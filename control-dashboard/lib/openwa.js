"use strict";

const path = require("node:path");
const procman = require("./procman");
const QRCode = require("../vendor/qrcode");
const { Service, HttpError, httpProbe, sameDir } = require("./service");
const { openwaSettings } = require("./config");

// WhatsApp rotates the QR roughly every 20 s. If it stops changing, it expired.
const QR_STALE_MS = 90_000;

function qrMatrix(text) {
  const qr = new QRCode(-1, 1); // auto version, error correction L
  qr.addData(text);
  qr.make();

  const size = qr.getModuleCount();
  const rows = [];

  for (let r = 0; r < size; r++) {
    let row = "";
    for (let c = 0; c < size; c++) row += qr.isDark(r, c) ? "1" : "0";
    rows.push(row);
  }

  return { size, rows };
}

class OpenWaService extends Service {
  constructor(ctx) {
    super(ctx, "openwa", "OpenWA", { startupTimeoutMs: 150_000 });

    this.qr = { value: null, changedAt: 0, matrix: null };
    this.accountCache = { at: 0, value: null };
    this.wa = this.blankWa();
  }

  blankWa() {
    return {
      state: "not_started",
      label: "Not started",
      detail: "",
      qr: null,
      account: null,
      lastConnectedAt: this.ctx.persist.get("openwa.lastConnectedAt"),
      lastDisconnectedAt: this.ctx.persist.get("openwa.lastDisconnectedAt"),
    };
  }

  dir() {
    return this.ctx.dirs().openwa;
  }

  async detect(snap, ports) {
    const dir = this.dir();
    const out = { pids: [], mainPid: null, managed: false, adopted: false, note: "" };

    if (!dir) {
      out.note = "OpenWA folder not found";
      return out;
    }

    const cfg = openwaSettings(dir);

    // 1. A process this dashboard started earlier (survives dashboard restarts).
    const reg = this.ctx.registry.get(this.id);

    if (reg) {
      const proc = snap.byPid.get(reg.pid);

      if (proc && Math.abs((proc.start || 0) - (reg.start || 0)) < 3000) {
        out.mainPid = reg.pid;
        out.managed = true;
        out.startedAtMs = proc.start;
      }
    }

    // 2. A proxy someone else started (e.g. from PowerShell): adopt it.
    const listener = ports.get(cfg.proxyPort);

    if (!out.mainPid && listener) {
      const probe = await httpProbe(`http://127.0.0.1:${cfg.proxyPort}/_render-health`, { timeout: 1500 });

      if (probe.ok && probe.status === 200 && probe.text.trim() === "ok") {
        out.mainPid = listener.pid;
        out.adopted = true;
        out.startedAtMs = snap.byPid.get(listener.pid)?.start || null;
        out.note = "Started outside the dashboard; its output is not captured";
      } else {
        const owner = snap.byPid.get(listener.pid);
        out.conflict = `Port ${cfg.proxyPort} is in use by ${owner?.name || "another program"} (pid ${listener.pid})`;
      }
    }

    if (out.mainPid) out.pids.push(out.mainPid);

    // Stray processes belonging to this project's folder (e.g. headless Chrome
    // left behind after the proxy exited). Only processes whose command line
    // contains this exact project folder are ever included.
    for (const p of snap.list) {
      if (p.pid === process.pid || out.pids.includes(p.pid)) continue;
      if (!/^(node|chrome|msedge|cmd)\.exe$/i.test(p.name || "")) continue;
      if (sameDir(p.cmd, dir)) out.pids.push(p.pid);
    }

    out.strays = out.pids.length > (out.mainPid ? 1 : 0);

    return out;
  }

  async probe(detected) {
    const info = this.info;
    const cfg = this.dir() ? openwaSettings(this.dir()) : null;
    const wa = this.blankWa();

    this.wa = wa;

    if (!cfg) {
      info.state = "error";
      info.error = "OpenWA folder not found. Set it in Settings.";
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
      } else if (detected.strays) {
        info.detail = "Leftover OpenWA processes found; Start will clean them up first";
      }

      this.qr = { value: null, changedAt: 0, matrix: null };
      return;
    }

    const health = await httpProbe(`http://127.0.0.1:${cfg.apiPort}/health`, { timeout: 2500 });
    const proxy = await httpProbe(`http://127.0.0.1:${cfg.proxyPort}/_render-health`, { timeout: 1500 });

    const apiUp = health.ok && health.status === 200 && health.json;
    const healthy = Boolean(apiUp) && proxy.ok && proxy.text.trim() === "ok";

    this.stateWhenRunning(healthy);

    if (!apiUp) {
      wa.state = info.state === "error" ? "error" : "starting";
      wa.label = wa.state === "error" ? "Error" : "Starting";
      wa.detail =
        wa.state === "error" ? "OpenWA process is running but its API is not responding" : "Starting OpenWA and the browser…";
      return;
    }

    const body = health.json;
    const session = body.session || {};
    const connected = body.connected === true && session.ready === true;
    const qrValue = typeof body.qr === "string" && body.qr.length > 20 ? body.qr : null;
    const now = Date.now();

    if (qrValue !== this.qr.value) {
      this.qr = {
        value: qrValue,
        changedAt: now,
        matrix: qrValue ? qrMatrix(qrValue) : null,
      };
    }

    const previous = this.ctx.persist.get("openwa.waState");

    if (connected) {
      wa.state = "connected";
      wa.label = "Connected";
      wa.detail = "WhatsApp session is ready to send";
      this.qr = { value: null, changedAt: now, matrix: null };

      if (previous !== "connected") {
        wa.lastConnectedAt = new Date(now).toISOString();
        this.ctx.persist.set("openwa.lastConnectedAt", wa.lastConnectedAt);
      }

      wa.account = await this.fetchAccount(cfg);
    } else if (qrValue) {
      const stale = now - this.qr.changedAt > QR_STALE_MS;

      wa.state = stale ? "qr_expired" : "waiting_qr";
      wa.label = stale ? "QR expired" : "Waiting for QR scan";
      wa.detail = stale
        ? "The QR code stopped refreshing. Restart OpenWA to get a new one."
        : "Open WhatsApp on your phone → Linked devices → Link a device, then scan the code.";
      wa.qr = stale ? null : { ...this.qr.matrix, updatedAt: new Date(this.qr.changedAt).toISOString() };
    } else if (["DISCONNECTED", "UNPAIRED", "CONFLICT", "TIMEOUT", "LOGGED_OUT"].includes(String(session.state))) {
      wa.state = "disconnected";
      wa.label = "Disconnected";
      wa.detail = `WhatsApp session state: ${session.state}`;
    } else {
      wa.state = "starting";
      wa.label = "Starting";
      wa.detail = `Session state: ${session.state || "unknown"}`;
    }

    if (previous === "connected" && wa.state !== "connected") {
      wa.lastDisconnectedAt = new Date(now).toISOString();
      this.ctx.persist.set("openwa.lastDisconnectedAt", wa.lastDisconnectedAt);
    }

    this.ctx.persist.set("openwa.waState", wa.state);
  }

  // Phone number of the linked account. Uses the OpenWA API key server-side
  // only; the key is never sent to the browser.
  async fetchAccount(cfg) {
    const now = Date.now();

    if (now - this.accountCache.at < 60_000 && this.accountCache.value) return this.accountCache.value;

    this.accountCache.at = now;

    const res = await httpProbe(`http://127.0.0.1:${cfg.apiPort}/api/session/getHostNumber`, {
      timeout: 4000,
      headers: cfg.apiKey ? { "X-API-Key": cfg.apiKey } : {},
    });

    let value = null;

    if (res.ok && res.status === 200 && res.json) {
      const raw = res.json.data ?? res.json.result ?? res.json.hostNumber ?? res.json;
      const text = typeof raw === "string" ? raw : typeof raw?.number === "string" ? raw.number : null;
      const digits = text ? text.replace(/@.*$/, "").replace(/\D/g, "") : "";
      value = digits ? `+${digits}` : null;
    }

    this.accountCache.value = value;

    return value;
  }

  afterStop() {
    this.qr = { value: null, changedAt: 0, matrix: null };
    this.ctx.persist.set("openwa.waState", "stopped");
  }

  async _start() {
    const dir = this.dir();

    if (!dir) throw new HttpError(400, "OpenWA folder not found. Choose it in Settings.");

    const cfg = openwaSettings(dir);
    const nodeModules = path.join(dir, "node_modules");
    const fs = require("node:fs");

    if (!fs.existsSync(path.join(nodeModules, "dotenv"))) {
      throw new HttpError(400, "OpenWA dependencies are missing. Use Settings → Setup → Install dependencies.");
    }

    for (const key of ["PROXY_TOKEN", "WA_API_KEY"]) {
      if (!cfg.env[key]) throw new HttpError(400, `OpenWA .env is missing ${key}`);
    }

    const snap = await procman.snapshot({ fresh: true });
    const ports = await procman.listeners();
    const detected = await this.detect(snap, ports);

    if (detected.mainPid) {
      this.desired = true;
      this.dashboardLog("info", `Already running (pid ${detected.mainPid}); not starting a duplicate`);
      return { ok: true, message: "OpenWA is already running", alreadyRunning: true };
    }

    if (detected.conflict) throw new HttpError(409, detected.conflict);

    // Clear leftovers (orphaned browser/node processes of this project only).
    if (detected.pids.length) {
      this.dashboardLog("warn", `Cleaning up ${detected.pids.length} leftover OpenWA process(es)`);
      await this.killDetected(detected);
    }

    this.dashboardLog("info", "Starting: node server.js");

    const res = await procman.spawnLogged({
      file: process.execPath,
      args: ["server.js"],
      cwd: dir,
      env: { ...process.env },
      logFile: this.logFile(),
    });

    if (!res.ok) throw new HttpError(500, `Could not start OpenWA: ${res.error}`);

    const after = await procman.snapshot({ fresh: true });
    const proc = after.byPid.get(res.pid);

    await this.ctx.registry.set(this.id, { pid: res.pid, start: proc?.start || Date.now() });

    this.startedAt = Date.now();
    this.desired = true;
    this.startTailing({ fromEnd: false });

    // Success here means "the API answers", not just "a process exists".
    const up = await this.waitUntil(async () => {
      const exited = !(await procman.snapshot({ fresh: true })).byPid.has(res.pid);
      if (exited) return "exited";
      const h = await httpProbe(`http://127.0.0.1:${cfg.apiPort}/health`, { timeout: 1500 });
      return h.ok && h.status === 200;
    }, this.startupTimeoutMs, 1500);

    const stillThere = (await procman.snapshot({ fresh: true })).byPid.has(res.pid);

    if (!stillThere) {
      this.desired = false;
      throw new HttpError(500, "OpenWA exited during startup. See the OpenWA log for details.");
    }

    if (!up) throw new HttpError(504, "OpenWA started but its API did not become ready in time");

    this.dashboardLog("info", `OpenWA API is up (pid ${res.pid})`);

    return { ok: true, message: "OpenWA started" };
  }
}

module.exports = { OpenWaService, qrMatrix };
