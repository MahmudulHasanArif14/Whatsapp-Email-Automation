"use strict";

// Western Cars Local Operations Dashboard.
// Binds to 127.0.0.1 only. Not routed through Cloudflare. No dependencies.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const config = require("./lib/config");
const data = require("./lib/data");
const { Manager } = require("./lib/manager");
const { HttpError } = require("./lib/service");
const { redact, isLoopback } = require("./lib/util");

const HOST = config.DASHBOARD_HOST; // 127.0.0.1
const PORT = config.DASHBOARD_PORT;
const TOKEN = crypto.randomBytes(24).toString("hex");
const PUBLIC_DIR = path.join(__dirname, "public");

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);

const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

const manager = new Manager();

function secureHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, secureHeaders({ "Content-Type": type, ...extra }));
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function tokenOk(supplied) {
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (c) => {
      size += c.length;
      if (size > 16 * 1024) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on("end", () => {
      if (!chunks.length) return resolve({});

      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

const needBot = () => {
  const dir = manager.ctx.dirs().bot;
  if (!dir) throw new HttpError(400, "Review Bot folder not found. Choose it in Settings.");
  return dir;
};

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------

async function api(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean).slice(1); // after "api"

  if (method !== "GET") {
    const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json") throw new HttpError(415, "JSON required");
  }

  // ---- state & live stream
  if (method === "GET" && parts[0] === "state") {
    return send(res, 200, manager.lastState || (await manager.buildState()));
  }

  if (method === "GET" && parts[0] === "events") {
    res.writeHead(200, secureHeaders({ "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" }));
    const push = (state) => res.write(`data: ${JSON.stringify(state)}\n\n`);
    const unsubscribe = manager.subscribe(push);
    const ping = setInterval(() => res.write(": keepalive\n\n"), 20_000);

    if (manager.lastState) push(manager.lastState);

    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
    return;
  }

  // ---- service control
  if (method === "POST" && parts[0] === "services" && parts.length === 3) {
    const svc = manager.services[parts[1]];
    if (!svc) throw new HttpError(404, "Unknown service");
    if (!["start", "stop", "restart"].includes(parts[2])) throw new HttpError(404, "Unknown action");
    if (manager.job?.running) throw new HttpError(409, "Start All / Stop All is in progress");

    manager.dashLog("info", `${svc.label}: ${parts[2]} requested`);
    const result = await svc[parts[2]]();
    manager.readinessCache = { at: 0, value: null };
    manager.tick();
    return send(res, 200, result);
  }

  if (method === "POST" && parts[0] === "all" && parts.length === 2) {
    if (parts[1] === "start") return send(res, 202, await manager.startAll());
    if (parts[1] === "stop") return send(res, 202, await manager.stopAll());
    throw new HttpError(404, "Unknown action");
  }

  // ---- sending toggles
  if (method === "POST" && parts[0] === "sending") {
    const body = await readBody(req);
    const dir = needBot();

    for (const key of Object.keys(body)) {
      if (!["whatsapp", "email"].includes(key)) throw new HttpError(400, `Unknown setting: ${key}`);
    }

    const result = await data.setSending(dir, body);

    for (const key of ["whatsapp", "email"]) {
      if (body[key] !== undefined) manager.dashLog("info", `${key === "whatsapp" ? "WhatsApp" : "Email"} sending turned ${body[key] ? "ON" : "OFF"}`);
    }

    manager.tick();
    return send(res, 200, result);
  }

  // ---- iCabbi webhook URL (intentional reveal; never logged)
  if (method === "POST" && parts[0] === "webhook-url") {
    return send(res, 200, { url: manager.webhookUrl() });
  }

  if (method === "POST" && parts[0] === "readiness") {
    return send(res, 200, await manager.readiness({ force: true }));
  }

  // ---- Cloudflare
  if (method === "GET" && parts[0] === "tunnel") {
    const info = await manager.tunnel.inspect({ force: true, network: true });
    const pub = manager.tunnel.publicCache.value;
    return send(res, 200, { ...info, public: pub, dnsHelp: manager.tunnel.dnsHelp(info.tunnelId), lastError: manager.tunnel.lastError });
  }

  if (method === "POST" && parts[0] === "tunnel" && parts[1] === "check") {
    const info = await manager.tunnel.inspect({ force: true, network: true });
    const pub = await manager.tunnel.publicCheck({ force: true });
    manager.readinessCache = { at: 0, value: null };
    return send(res, 200, { ...info, public: pub, dnsHelp: pub.dns?.resolves === false ? manager.tunnel.dnsHelp(info.tunnelId) : null });
  }

  if (method === "POST" && parts[0] === "tunnel" && parts[1] === "repair-config") {
    return send(res, 200, await manager.tunnel.repairConfig());
  }

  // ---- data
  if (method === "GET" && parts[0] === "messages") {
    const dir = needBot();
    const q = Object.fromEntries(url.searchParams);
    const { rows, errors } = data.allRows(dir);
    const filtered = data.filterRows(rows, q);
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
    return send(res, 200, { total: filtered.length, rows: filtered.slice(0, limit), errors });
  }

  if (method === "GET" && parts[0] === "queue") {
    return send(res, 200, data.queueView(needBot()));
  }

  // ---- logs
  if (method === "GET" && parts[0] === "logs") {
    const q = Object.fromEntries(url.searchParams);
    return send(res, 200, { entries: manager.logs.query({ service: q.service, level: q.level, since: Number(q.since) || 0, limit: 600 }), serverTime: new Date().toISOString() });
  }

  if (method === "POST" && parts[0] === "logs" && parts[1] === "clear") {
    manager.logs.clear();
    manager.dashLog("info", "Log view cleared (application files were not touched)");
    return send(res, 200, { ok: true });
  }

  // ---- setup
  if (method === "GET" && parts[0] === "setup") {
    return send(res, 200, await manager.setupChecks());
  }

  if (method === "POST" && parts[0] === "setup" && parts[1] === "folder") {
    const body = await readBody(req);
    if (!["openwa", "bot"].includes(body.kind)) throw new HttpError(400, "Unknown project");
    try {
      const dir = await manager.chooseFolder(body.kind, body.dir);
      return send(res, 200, { ok: true, dir });
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  }

  if (method === "POST" && parts[0] === "setup" && parts[1] === "install-gateway") {
    return send(res, 200, manager.installGateway());
  }

  if (method === "POST" && parts[0] === "setup" && parts[1] === "link-gateway") {
    return send(res, 200, manager.linkGateway());
  }

  if (method === "POST" && parts[0] === "setup" && parts[1] === "install") {
    const body = await readBody(req);
    if (!["openwa", "bot"].includes(body.kind)) throw new HttpError(400, "Unknown project");
    return send(res, 200, await manager.installDependencies(body.kind));
  }

  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------
// Server
// ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding defence: only our own host names are served.
    if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) {
      return send(res, 421, { error: "Misdirected request" });
    }

    if (!isLoopback(req.socket.remoteAddress)) {
      return send(res, 403, { error: "Local access only" });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // Static assets
    if (req.method === "GET" && STATIC[url.pathname]) {
      const entry = STATIC[url.pathname];
      let body = fs.readFileSync(path.join(PUBLIC_DIR, entry.file));

      if (entry.file === "index.html") body = Buffer.from(body.toString("utf8").replace("__DASHBOARD_TOKEN__", TOKEN));

      return send(res, 200, body, entry.type);
    }

    if (url.pathname === "/api/ping") {
      return send(res, 200, { dashboard: "western-cars-control" });
    }

    if (url.pathname.startsWith("/api/")) {
      // Mutations: same-origin only. Everything: per-launch token.
      const origin = req.headers.origin;

      if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: "Cross-origin request refused" });
      if (req.method !== "GET" && !origin && req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") {
        return send(res, 403, { error: "Cross-site request refused" });
      }

      const supplied = req.headers["x-dashboard-token"] || url.searchParams.get("t");

      if (!tokenOk(supplied)) return send(res, 401, { error: "Missing or stale dashboard token. Reload the page." });

      return await api(req, res, url);
    }

    return send(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message });

    manager.dashLog("error", `Unhandled error: ${error.message}`);
    return send(res, 500, { error: redact(error.message).slice(0, 300) });
  }
});

server.requestTimeout = 660_000; // npm ci can take a while
server.headersTimeout = 10_000;

function openBrowser() {
  const url = `http://localhost:${PORT}`;
  spawn("cmd.exe", ["/d", "/c", "start", '""', url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

server.on("error", async (error) => {
  if (error.code === "EADDRINUSE") {
    // Already running? Just open it.
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(2000), headers: { Host: `127.0.0.1:${PORT}` } });
      const j = await r.json();

      if (j.dashboard === "western-cars-control") {
        console.log(`The dashboard is already running at http://localhost:${PORT}`);
        if (process.argv.includes("--open")) openBrowser();
        process.exit(0);
      }
    } catch {
      // fall through
    }

    console.error(`Port ${PORT} is already in use by another program. Set DASHBOARD_PORT to use a different port.`);
    process.exit(1);
  }

  console.error("Server error:", error.message);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  console.log("------------------------------------------------");
  console.log(" Western Cars Operations Dashboard");
  console.log(` Open:  http://localhost:${PORT}   (this computer only)`);
  console.log(" Keep this window open. Closing it does NOT stop OpenWA, the");
  console.log(" Review Bot or the tunnel - use Stop All in the dashboard.");
  console.log("------------------------------------------------");

  await manager.start();

  if (process.argv.includes("--open")) openBrowser();
});

function shutdown() {
  manager.stopLoop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { server, manager, TOKEN };
