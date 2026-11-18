"use strict";

require("dotenv").config();

const http = require("node:http");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const PORT = Number(process.env.PORT || 10000);

// Keep the proxy private on your Windows computer.
// For Render, set PROXY_HOST=0.0.0.0.
const PROXY_HOST = process.env.PROXY_HOST || "127.0.0.1";

const OPENWA_HOST = "127.0.0.1";
const OPENWA_PORT = 8081;

const OPENWA_VERSION = process.env.OPENWA_VERSION || "5.10.0";
const OPENWA_SESSION_ID = process.env.OPENWA_SESSION_ID || "render-test";

const WA_USER_DATA_DIR =
  process.env.WA_USER_DATA_DIR || path.join(__dirname, ".openwa-session");

const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

const HEALTH_CHECK_INTERVAL_MS = 2_000;

// --------------------------------------------------
// Validate configuration
// --------------------------------------------------

const proxyToken = process.env.PROXY_TOKEN;
const waApiKey = process.env.WA_API_KEY;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

function validSecret(value) {
  return typeof value === "string" && /^[\x21-\x7e]{32,256}$/.test(value);
}

if (!validSecret(proxyToken) || !validSecret(waApiKey)) {
  throw new Error("PROXY_TOKEN and WA_API_KEY must be separate strong secrets");
}

if (proxyToken === waApiKey) {
  throw new Error("Proxy and OpenWA credentials must differ");
}

if (!/^\d+\.\d+\.\d+$/.test(OPENWA_VERSION)) {
  throw new Error("Invalid OPENWA_VERSION");
}

if (!/^[a-zA-Z0-9_-]{1,64}$/.test(OPENWA_SESSION_ID)) {
  throw new Error("Invalid OPENWA_SESSION_ID");
}

// Keep the WhatsApp browser profile between restarts.
fs.mkdirSync(WA_USER_DATA_DIR, { recursive: true });

// --------------------------------------------------
// Security helpers
// --------------------------------------------------

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");

  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });

  res.end(JSON.stringify(payload));
}

// --------------------------------------------------
// Rate limiter
// One global limit for a single-purpose test service.
// --------------------------------------------------

let windowStarted = Date.now();
let requestCount = 0;

function rateLimited() {
  const now = Date.now();

  if (now - windowStarted >= WINDOW_MS) {
    windowStarted = now;
    requestCount = 0;
  }

  requestCount++;

  return requestCount > MAX_REQUESTS_PER_WINDOW;
}

// --------------------------------------------------
// OpenWA process state
// --------------------------------------------------

let openwa = null;
let openwaReady = false;
let shuttingDown = false;
let healthTimer = null;
let forceExitTimer = null;

// --------------------------------------------------
// OpenWA health/readiness check
// --------------------------------------------------

function scheduleHealthCheck() {
  if (shuttingDown) return;

  if (healthTimer) {
    clearTimeout(healthTimer);
  }

  healthTimer = setTimeout(checkOpenWaHealth, HEALTH_CHECK_INTERVAL_MS);

  healthTimer.unref();
}

function checkOpenWaHealth() {
  if (shuttingDown || !openwa) return;

  let finished = false;

  function finish(ready) {
    if (finished) return;
    finished = true;

    const wasReady = openwaReady;

    openwaReady = ready;

    if (ready && !wasReady) {
      console.log("OpenWA is connected and ready.");
    }

    if (!ready && wasReady) {
      console.warn("OpenWA session is no longer ready.");
    }

    scheduleHealthCheck();
  }

  const request = http.get(
    {
      hostname: OPENWA_HOST,
      port: OPENWA_PORT,
      path: "/health",
      method: "GET",
      timeout: 3_000,
    },
    (response) => {
      let responseBody = "";

      response.setEncoding("utf8");

      response.on("data", (chunk) => {
        responseBody += chunk;

        if (responseBody.length > 8192) {
          finish(false);
          response.destroy();
        }
      });

      response.on("end", () => {
        let health = null;

        try {
          health = JSON.parse(responseBody);
        } catch {
          health = null;
        }

        const ready =
          response.statusCode === 200 &&
          health?.connected === true &&
          health?.session?.ready === true;

        finish(ready);
      });

      response.on("error", () => {
        finish(false);
      });
    },
  );

  request.on("timeout", () => {
    request.destroy(new Error("OpenWA health check timed out"));
  });

  request.on("error", () => {
    finish(false);
  });
}

// --------------------------------------------------
// HTTP proxy
// --------------------------------------------------

const server = http.createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  // Synthetic health endpoint for the proxy process.
  if (req.method === "GET" && req.url === "/_render-health") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
    });

    return res.end("ok");
  }

  // Only the sendText endpoint is permitted.
  if (
    req.headers.upgrade ||
    req.method !== "POST" ||
    req.url !== "/api/sendText"
  ) {
    return sendJson(res, 404, {
      error: "Not found",
    });
  }

  // ------------------------------------------------
  // Proxy authentication
  // ------------------------------------------------

  const authorization = req.headers.authorization;

  const supplied =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

  if (!safeEqual(supplied, proxyToken)) {
    req.resume();

    return sendJson(
      res,
      401,
      { error: "Unauthorized" },
      { "WWW-Authenticate": "Bearer" },
    );
  }

  // ------------------------------------------------
  // Rate limiting
  // ------------------------------------------------

  if (rateLimited()) {
    req.resume();

    return sendJson(
      res,
      429,
      { error: "Rate limit exceeded" },
      { "Retry-After": "60" },
    );
  }

  // ------------------------------------------------
  // OpenWA readiness
  // ------------------------------------------------

  if (!openwaReady) {
    req.resume();

    return sendJson(
      res,
      503,
      { error: "WhatsApp session is not ready" },
      { "Retry-After": "5" },
    );
  }

  // ------------------------------------------------
  // Validate content type
  // ------------------------------------------------

  const contentType = (req.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (contentType !== "application/json") {
    req.resume();

    return sendJson(res, 415, {
      error: "JSON required",
    });
  }

  const contentEncoding = req.headers["content-encoding"];

  if (contentEncoding && contentEncoding !== "identity") {
    req.resume();

    return sendJson(res, 415, {
      error: "Compressed requests are not supported",
    });
  }

  // ------------------------------------------------
  // Check declared body size
  // ------------------------------------------------

  const declaredLength = req.headers["content-length"];

  if (
    declaredLength !== undefined &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  ) {
    req.resume();

    return sendJson(res, 413, {
      error: "Request too large",
    });
  }

  // ------------------------------------------------
  // Forward request to local OpenWA
  // ------------------------------------------------

  let bodyBytes = 0;
  let completed = false;

  const upstream = http.request({
    hostname: OPENWA_HOST,
    port: OPENWA_PORT,
    path: "/api/messages/sendText",
    method: "POST",
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": waApiKey,
    },
  });

  function finishError(status, message) {
    if (completed) return;

    completed = true;

    upstream.destroy();

    if (res.destroyed) return;

    if (!res.headersSent) {
      sendJson(res, status, {
        error: message,
      });
    } else {
      res.destroy();
    }
  }

  req.on("data", (chunk) => {
    bodyBytes += chunk.length;

    if (bodyBytes > MAX_BODY_BYTES) {
      finishError(413, "Request too large");
      return;
    }

    if (!completed && !upstream.write(chunk)) {
      req.pause();
    }
  });

  upstream.on("drain", () => {
    if (!completed) req.resume();
  });

  req.on("end", () => {
    if (!completed) {
      upstream.end();
    }
  });

  req.on("aborted", () => {
    finishError(400, "Request aborted");
  });

  req.on("error", () => {
    finishError(400, "Request error");
  });

  // ------------------------------------------------
  // OpenWA response
  // ------------------------------------------------

  upstream.on("response", (upstreamRes) => {
    let responseBytes = 0;
    const chunks = [];

    upstreamRes.on("data", (chunk) => {
      responseBytes += chunk.length;

      if (responseBytes > MAX_BODY_BYTES) {
        finishError(502, "Upstream response too large");
        upstreamRes.destroy();
        return;
      }

      chunks.push(chunk);
    });

    upstreamRes.on("aborted", () => {
      finishError(502, "OpenWA response aborted");
    });

    upstreamRes.on("error", () => {
      finishError(502, "OpenWA response error");
    });

    upstreamRes.on("end", () => {
      if (completed) return;

      completed = true;

      const status = upstreamRes.statusCode || 502;
      const body = Buffer.concat(chunks);

      if (!res.destroyed) {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });

        res.end(body);
      }
    });
  });

  upstream.on("timeout", () => {
    finishError(504, "Upstream timeout");
  });

  upstream.on("error", () => {
    finishError(502, "OpenWA unavailable");
  });

  // Stop upstream work if the client disconnects.
  res.on("close", () => {
    if (!res.writableEnded) {
      upstream.destroy();
    }
  });
});

// --------------------------------------------------
// HTTP server limits
// --------------------------------------------------

server.headersTimeout = 10_000;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

// --------------------------------------------------
// OpenWA shutdown
// --------------------------------------------------

function stopOpenWa() {
  if (!openwa || openwa.exitCode !== null) return;

  if (process.platform === "win32" && openwa.pid) {
    // Kill the complete Windows process tree:
    // cmd.exe -> npx.cmd -> Node/OpenWA.
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(openwa.pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );

    killer.on("error", () => {
      try {
        openwa.kill();
      } catch {
        // Process may already have exited.
      }
    });
  } else {
    try {
      openwa.kill("SIGTERM");
    } catch {
      // Process may already have exited.
    }
  }
}

function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;

  shuttingDown = true;
  openwaReady = false;

  process.exitCode = exitCode;

  console.log("Shutting down:", reason);

  if (healthTimer) {
    clearTimeout(healthTimer);
    healthTimer = null;
  }

  if (server.listening) {
    server.close(() => {});
    server.closeAllConnections();
  }

  stopOpenWa();

  forceExitTimer = setTimeout(() => {
    console.error("Shutdown timed out. Forcing exit.");

    stopOpenWa();

    process.exit(1);
  }, 10_000);

  forceExitTimer.unref();
}

// --------------------------------------------------
// Start OpenWA
// --------------------------------------------------

function startOpenWa() {
  const isWindows = process.platform === "win32";

  // No secrets are included in this command string.
  // WA_API_KEY is passed using the child environment.
  const windowsCommand = [
    "npx.cmd",
    "--yes",
    `@open-wa/wa-automate@${OPENWA_VERSION}`,
    "--session-id",
    OPENWA_SESSION_ID,
    "--host",
    OPENWA_HOST,
    "--port",
    String(OPENWA_PORT),
  ].join(" ");

  const command = isWindows ? process.env.ComSpec || "cmd.exe" : "npx";

  const args = isWindows
    ? ["/d", "/s", "/c", windowsCommand]
    : [
        "--yes",
        `@open-wa/wa-automate@${OPENWA_VERSION}`,
        "--session-id",
        OPENWA_SESSION_ID,
        "--host",
        OPENWA_HOST,
        "--port",
        String(OPENWA_PORT),
      ];

  // Do not give OpenWA the proxy's bearer token.
  const childEnv = {
    ...process.env,
    WA_API_KEY: waApiKey,
    WA_HOST: OPENWA_HOST,
    WA_PORT: String(OPENWA_PORT),
    WA_SESSION_ID: OPENWA_SESSION_ID,
    WA_USER_DATA_DIR,
  };

  delete childEnv.PROXY_TOKEN;

  console.log("Starting OpenWA", {
    version: OPENWA_VERSION,
    host: OPENWA_HOST,
    port: OPENWA_PORT,
    session: OPENWA_SESSION_ID,
  });

  try {
    openwa = spawn(command, args, {
      cwd: __dirname,
      env: childEnv,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
  } catch (error) {
    console.error("OpenWA spawn failed:", error.message);
    shutdown("OPENWA_SPAWN_ERROR", 1);
    return;
  }

  openwa.on("spawn", () => {
    console.log(
      "OpenWA process started. Waiting for WhatsApp session readiness...",
    );

    checkOpenWaHealth();
  });

  openwa.on("error", (error) => {
    console.error("Failed to launch OpenWA:", error.message);

    shutdown("OPENWA_SPAWN_ERROR", 1);
  });

  openwa.on("exit", (code, signal) => {
    console.error("OpenWA exited:", {
      code,
      signal,
    });

    openwaReady = false;

    if (!shuttingDown) {
      shutdown("OPENWA_EXIT", 1);
    }
  });
}

// --------------------------------------------------
// Start proxy
// --------------------------------------------------

server.on("error", (error) => {
  console.error("HTTP server error:", error.message);
  shutdown("HTTP_SERVER_ERROR", 1);
});

server.listen(PORT, PROXY_HOST, () => {
  console.log(`Protected proxy listening on http://${PROXY_HOST}:${PORT}`);

  startOpenWa();
});

// --------------------------------------------------
// Process signals
// --------------------------------------------------

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

// Helps nodemon clean up the OpenWA child process on restart.
process.on("SIGUSR2", () => {
  shutdown("SIGUSR2");
});
