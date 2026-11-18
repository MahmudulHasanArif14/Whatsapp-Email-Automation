"use strict";

// Service adapter for the open-source OpenWA gateway (rmyndharis/OpenWA),
// run with plain Node: `node -r bind-loopback.js dist/main.js`.
// It reuses the OpenWA service shape (id "openwa") so the UI is unchanged.

const fs = require("node:fs");
const path = require("node:path");
const procman = require("./procman");
const { HttpError, httpProbe, sameDir } = require("./service");
const { OpenWaService } = require("./openwa");
const { readEnvFile, registerSecret } = require("./util");

const QR_STALE_MS = 120_000;
const DEFAULT_SESSION = "western-cars";

function gatewaySettings(dir, botEnv = {}) {
  const env = readEnvFile(dir);
  let apiKey = env.API_MASTER_KEY || "";

  if (!apiKey) {
    try {
      apiKey = fs.readFileSync(path.join(dir, "data", ".api-key"), "utf8").trim();
    } catch {
      apiKey = "";
    }
  }

  registerSecret(apiKey);

  return {
    env,
    port: Number(env.PORT || 2785),
    apiKey,
    sessionName: botEnv.OPENWA_GATEWAY_SESSION || DEFAULT_SESSION,
  };
}

class GatewayService extends OpenWaService {
  constructor(ctx) {
    super(ctx);
    this.label = "OpenWA Gateway";
    this.info.label = this.label;
    this.startupTimeoutMs = 240_000; // first boot builds the database
  }

  dir() {
    return this.ctx.dirs().gateway;
  }

  cfg() {
    const bot = this.ctx.dirs().bot;
    return gatewaySettings(this.dir(), bot ? readEnvFile(bot) : {});
  }

  api(cfg, pathname, options = {}) {
    return httpProbe(`http://127.0.0.1:${cfg.port}${pathname}`, {
      timeout: options.timeout || 4000,
      method: options.method || "GET",
      body: options.body,
      headers: { "X-API-Key": cfg.apiKey, "content-type": "application/json" },
    });
  }

  async detect(snap, ports) {
    const dir = this.dir();
    const out = { pids: [], mainPid: null, managed: false, adopted: false, note: "" };

    if (!dir) {
      out.note = "OpenWA gateway folder not found";
      return out;
    }

    const cfg = this.cfg();
    const reg = this.ctx.registry.get(this.id);

    if (reg) {
      const proc = snap.byPid.get(reg.pid);

      if (proc && Math.abs((proc.start || 0) - (reg.start || 0)) < 3000) {
        out.mainPid = reg.pid;
        out.managed = true;
        out.startedAtMs = proc.start;
      }
    }

    const listener = ports.get(cfg.port);

    if (!out.mainPid && listener) {
      const owner = snap.byPid.get(listener.pid);
      const probe = await httpProbe(`http://127.0.0.1:${cfg.port}/api/health`, { timeout: 1500 });

      if (probe.json?.status === "ok" && owner && /dist[\\/]main/i.test(owner.cmd || "")) {
        out.mainPid = listener.pid;
        out.adopted = true;
        out.startedAtMs = owner.start || null;
        out.note = "Started outside the dashboard; its output is not captured";
      } else {
        out.conflict = `Port ${cfg.port} is in use by ${owner?.name || "another program"} (pid ${listener.pid})`;
      }
    }

    if (out.mainPid) out.pids.push(out.mainPid);

    // Browser/node leftovers whose command line points into this folder.
    for (const p of snap.list) {
      if (p.pid === process.pid || out.pids.includes(p.pid)) continue;
      if (!/^(node|chrome|msedge)\.exe$/i.test(p.name || "")) continue;
      if (sameDir(p.cmd, dir)) out.pids.push(p.pid);
    }

    out.strays = out.pids.length > (out.mainPid ? 1 : 0);

    return out;
  }

  async findSession(cfg) {
    const res = await this.api(cfg, "/api/sessions");

    if (!res.ok || res.status !== 200) return { error: `Gateway API HTTP ${res.status || res.error}` };

    const list = Array.isArray(res.json) ? res.json : res.json?.data || res.json?.sessions || [];

    return { session: list.find((s) => s.name === cfg.sessionName) || null };
  }

  async probe(detected) {
    const info = this.info;
    const wa = this.blankWa();
    this.wa = wa;

    if (!this.dir()) {
      info.state = "error";
      info.error = "OpenWA gateway folder not found. Set it in Settings.";
      wa.state = "error";
      wa.label = "Error";
      return;
    }

    if (detected.conflict && !detected.mainPid) {
      info.state = "error";
      info.error = detected.conflict;
      wa.state = "error";
      wa.label = "Error";
      wa.detail = detected.conflict;
      return;
    }

    if (!detected.mainPid) {
      this.stateWhenAbsent();

      if (info.state === "error") {
        wa.state = "error";
        wa.label = "Error";
        wa.detail = info.error;
      }

      this.qr = { value: null, changedAt: 0, matrix: null };
      return;
    }

    const cfg = this.cfg();
    const health = await httpProbe(`http://127.0.0.1:${cfg.port}/api/health`, { timeout: 2500 });
    const up = health.ok && health.status === 200 && health.json?.status === "ok";

    this.stateWhenRunning(up);

    if (!up) {
      wa.state = info.state === "error" ? "error" : "starting";
      wa.label = wa.state === "error" ? "Error" : "Starting";
      wa.detail = wa.state === "error" ? "The gateway process is running but its API is not responding" : "Starting the OpenWA gateway…";
      return;
    }

    if (!cfg.apiKey) {
      wa.state = "error";
      wa.label = "Error";
      wa.detail = "Gateway API key not found (data/.api-key)";
      return;
    }

    const found = await this.findSession(cfg);

    if (found.error) {
      wa.state = "error";
      wa.label = "Error";
      wa.detail = found.error;
      return;
    }

    const session = found.session;
    const now = Date.now();
    const previous = this.ctx.persist.get("openwa.waState");

    if (!session) {
      wa.state = "starting";
      wa.label = "No session yet";
      wa.detail = "The WhatsApp session will be created when the gateway is started from the dashboard.";
    } else if (session.status === "ready") {
      wa.state = "connected";
      wa.label = "Connected";
      wa.detail = "WhatsApp session is ready to send";
      wa.account = session.phone ? `+${String(session.phone).replace(/\D/g, "")}` : null;
      // Same identity the Review Bot stamps on each message it sends.
      wa.senderKey = session.id ? `${session.id}:${session.phone || ""}` : null;
      this.qr = { value: null, changedAt: now, matrix: null };

      if (previous !== "connected") {
        wa.lastConnectedAt = new Date(now).toISOString();
        this.ctx.persist.set("openwa.lastConnectedAt", wa.lastConnectedAt);
      }
    } else if (session.status === "qr_ready") {
      const qrRes = await this.api(cfg, `/api/sessions/${encodeURIComponent(session.id)}/qr`);
      const image = qrRes.json?.qrCode && String(qrRes.json.qrCode).startsWith("data:image/") ? qrRes.json.qrCode : null;

      if (image !== this.qr.value) this.qr = { value: image, changedAt: now, matrix: null };

      const stale = now - this.qr.changedAt > QR_STALE_MS;

      if (image && !stale) {
        wa.state = "waiting_qr";
        wa.label = "Waiting for QR scan";
        wa.detail = "Open WhatsApp on your phone → Linked devices → Link a device, then scan the code.";
        wa.qr = { image, updatedAt: new Date(this.qr.changedAt).toISOString() };
      } else {
        wa.state = image ? "qr_expired" : "starting";
        wa.label = image ? "QR expired" : "Starting";
        wa.detail = image ? "The QR code stopped refreshing. Restart OpenWA for a new one." : "Waiting for the QR code…";
      }
    } else if (["created", "initializing", "authenticating"].includes(session.status)) {
      wa.state = "starting";
      wa.label = session.status === "authenticating" ? "Authenticating" : "Starting";
      wa.detail = `Session status: ${session.status}`;
    } else if (session.status === "action_required") {
      wa.state = "error";
      wa.label = "Action required";
      wa.detail = session.lastError || "WhatsApp needs a manual step on the phone (for example a passkey prompt).";
    } else if (session.status === "failed") {
      wa.state = "error";
      wa.label = "Failed";
      wa.detail = session.lastError || "The session failed to start";
    } else {
      wa.state = "disconnected";
      wa.label = "Disconnected";
      wa.detail = session.lastError ? `Session ${session.status}: ${session.lastError}` : `Session status: ${session.status}`;
    }

    if (session?.restriction && wa.state === "connected") {
      wa.detail = `Connected, but the account reports a restriction: ${JSON.stringify(session.restriction).slice(0, 160)}`;
    }

    if (previous === "connected" && wa.state !== "connected") {
      wa.lastDisconnectedAt = new Date(now).toISOString();
      this.ctx.persist.set("openwa.lastDisconnectedAt", wa.lastDisconnectedAt);
    }

    this.ctx.persist.set("openwa.waState", wa.state);
  }

  // Create (once) and start the WhatsApp session. Idempotent.
  async ensureSession(cfg) {
    let { session, error } = await this.findSession(cfg);

    if (error) throw new HttpError(502, error);

    if (!session) {
      const created = await this.api(cfg, "/api/sessions", { method: "POST", body: JSON.stringify({ name: cfg.sessionName }), timeout: 15000 });

      if (!created.ok || ![200, 201].includes(created.status)) {
        throw new HttpError(502, `Could not create the WhatsApp session (HTTP ${created.status || created.error})`);
      }

      session = created.json;
      this.dashboardLog("info", `Created WhatsApp session "${cfg.sessionName}"`);
    }

    await this.ensureReplyWebhook(cfg, session).catch((e) => this.dashboardLog("warn", `Reply webhook not registered: ${e.message}`));

    if (["created", "disconnected", "failed"].includes(session.status)) {
      const started = await this.api(cfg, `/api/sessions/${encodeURIComponent(session.id)}/start`, { method: "POST", body: "{}", timeout: 20000 });

      if (!started.ok || ![200, 201, 202].includes(started.status)) {
        throw new HttpError(502, `Could not start the WhatsApp session (HTTP ${started.status || started.error})`);
      }

      this.dashboardLog("info", "WhatsApp session start requested");
    }
  }

  // Registers the gateway -> Review Bot webhook used for STOP opt-outs.
  async ensureReplyWebhook(cfg, session) {
    const botDir = this.ctx.dirs().bot;
    if (!botDir) return;

    const botEnv = readEnvFile(botDir);
    if (!botEnv.WHATSAPP_REPLY_SECRET) return;

    const target = `http://127.0.0.1:${Number(botEnv.PORT || 3000)}/webhooks/whatsapp-reply?key=${botEnv.WHATSAPP_REPLY_SECRET}`;
    const listed = await this.api(cfg, `/api/sessions/${encodeURIComponent(session.id)}/webhooks`);
    const list = Array.isArray(listed.json) ? listed.json : listed.json?.data || [];

    // The stored URL is never logged (it carries the reply secret).
    if (list.some((w) => String(w.url || "").includes("/webhooks/whatsapp-reply"))) return;

    const created = await this.api(cfg, `/api/sessions/${encodeURIComponent(session.id)}/webhooks`, {
      method: "POST",
      body: JSON.stringify({ url: target, events: ["message.received"] }),
      timeout: 15000,
    });

    if (!created.ok || ![200, 201].includes(created.status)) {
      throw new Error(`gateway answered HTTP ${created.status || created.error}`);
    }

    this.dashboardLog("info", "Registered the STOP reply webhook with the gateway");
  }

  async _start() {
    const dir = this.dir();

    if (!dir) throw new HttpError(400, "OpenWA gateway folder not found. Choose it in Settings.");

    if (!fs.existsSync(path.join(dir, "dist", "main.js"))) {
      throw new HttpError(400, "The gateway is not built. Use Settings → Setup check → Install gateway.");
    }

    if (!fs.existsSync(path.join(dir, "node_modules"))) {
      throw new HttpError(400, "Gateway dependencies are missing. Use Settings → Setup check → Install gateway.");
    }

    const cfg = this.cfg();
    const snap = await procman.snapshot({ fresh: true });
    const ports = await procman.listeners();
    const detected = await this.detect(snap, ports);

    if (detected.mainPid) {
      this.desired = true;
      this.dashboardLog("info", `Gateway already running (pid ${detected.mainPid}); not starting a duplicate`);
    } else {
      if (detected.conflict) throw new HttpError(409, detected.conflict);

      if (detected.pids.length) {
        this.dashboardLog("warn", `Cleaning up ${detected.pids.length} leftover gateway process(es)`);
        await this.killDetected(detected);
      }

      this.dashboardLog("info", "Starting: node dist/main.js (bound to 127.0.0.1)");

      const env = { ...process.env, HOST: "127.0.0.1" };

      const res = await procman.spawnLogged({
        file: process.execPath,
        args: ["-r", path.join(__dirname, "bind-loopback.js"), "dist/main.js"],
        cwd: dir,
        env,
        logFile: this.logFile(),
      });

      if (!res.ok) throw new HttpError(500, `Could not start the gateway: ${res.error}`);

      const after = await procman.snapshot({ fresh: true });
      await this.ctx.registry.set(this.id, { pid: res.pid, start: after.byPid.get(res.pid)?.start || Date.now() });

      this.startedAt = Date.now();
      this.desired = true;
      this.startTailing({ fromEnd: false });

      const ok = await this.waitUntil(async () => {
        if (!(await procman.snapshot({ fresh: true })).byPid.has(res.pid)) return true;
        const h = await httpProbe(`http://127.0.0.1:${cfg.port}/api/health`, { timeout: 1500 });
        return h.ok && h.status === 200;
      }, this.startupTimeoutMs, 2000);

      if (!(await procman.snapshot({ fresh: true })).byPid.has(res.pid)) {
        this.desired = false;
        throw new HttpError(500, "The gateway exited during startup. See the OpenWA log.");
      }

      if (!ok) throw new HttpError(504, "The gateway started but its API did not become ready in time");
    }

    const fresh = this.cfg(); // the API key file exists after first boot
    if (!fresh.apiKey) throw new HttpError(500, "Gateway API key was not created (data/.api-key)");

    await this.ensureSession(fresh);

    return { ok: true, message: "OpenWA gateway started", alreadyRunning: Boolean(detected.mainPid) };
  }
}

module.exports = { GatewayService, gatewaySettings };
