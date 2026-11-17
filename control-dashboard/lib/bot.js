"use strict";

const fs = require("node:fs");
const path = require("node:path");
const procman = require("./procman");
const { Service, HttpError, httpProbe, sameDir } = require("./service");
const { botSettings, readWebhookSecret } = require("./config");
const { readJsonSafe, sleep } = require("./util");

const SERVICE_NAME = "western-cars-review-bot";

class BotService extends Service {
  constructor(ctx) {
    super(ctx, "bot", "Review Bot", { startupTimeoutMs: 45_000 });
    this.crashed = false;
  }

  dir() {
    return this.ctx.dirs().bot;
  }

  onLine(line) {
    if (/app crashed - waiting for file changes/i.test(line)) this.crashed = true;
    if (/starting `node/i.test(line) || /Western Cars Review Bot started/.test(line)) this.crashed = false;
  }

  nodemonBin(dir) {
    return path.join(dir, "node_modules", "nodemon", "bin", "nodemon.js");
  }

  async detect(snap, ports) {
    const dir = this.dir();
    const out = { pids: [], mainPid: null, managed: false, adopted: false, note: "" };

    if (!dir) {
      out.note = "Review Bot folder not found";
      return out;
    }

    const cfg = botSettings(dir);
    const wrapper = (p) => p.pid !== process.pid && /^(node|cmd)\.exe$/i.test(p.name || "") && /nodemon|npx-cli/i.test(p.cmd || "");

    const addWrappers = (pid) => {
      for (const a of procman.wrapperAncestors(snap, pid, wrapper)) {
        if (!out.pids.includes(a)) out.pids.push(a);
      }
    };

    const reg = this.ctx.registry.get(this.id);

    if (reg) {
      const proc = snap.byPid.get(reg.pid);

      if (proc && Math.abs((proc.start || 0) - (reg.start || 0)) < 3000) {
        out.mainPid = reg.pid;
        out.managed = true;
        out.startedAtMs = proc.start;
      }
    }

    // Any nodemon supervising this project's server.js, whoever started it.
    if (!out.mainPid) {
      const nodemon = snap.list.find(
        (p) => /^node\.exe$/i.test(p.name || "") && /nodemon/i.test(p.cmd || "") && sameDir(p.cmd, dir),
      );

      if (nodemon) {
        out.mainPid = nodemon.pid;
        out.adopted = true;
        out.startedAtMs = nodemon.start;
        out.note = "Started outside the dashboard; its output is not captured";
      }
    }

    const listener = ports.get(cfg.port);

    if (!out.mainPid && listener) {
      const probe = await httpProbe(`http://127.0.0.1:${cfg.port}/health`, { timeout: 1500 });

      if (probe.json && probe.json.service === SERVICE_NAME) {
        out.mainPid = listener.pid;
        out.adopted = true;
        out.startedAtMs = snap.byPid.get(listener.pid)?.start || null;
        out.note = "Started outside the dashboard; its output is not captured";
      } else {
        const owner = snap.byPid.get(listener.pid);
        out.conflict = `Port ${cfg.port} is in use by ${owner?.name || "another program"} (pid ${listener.pid})`;
      }
    }

    if (out.mainPid) {
      out.pids.push(out.mainPid);
      addWrappers(out.mainPid);
    }

    // The app process that actually holds the port (child of nodemon).
    if (listener && out.mainPid) {
      const owner = snap.byPid.get(listener.pid);
      const ours = out.pids.includes(listener.pid) || procman.descendantsOf(snap, out.pids).includes(listener.pid);

      if (owner && ours && !out.pids.includes(listener.pid)) out.pids.push(listener.pid);
    }

    return out;
  }

  async probe(detected) {
    const info = this.info;
    const dir = this.dir();

    if (!dir) {
      info.state = "error";
      info.error = "Review Bot folder not found. Set it in Settings.";
      return;
    }

    const cfg = botSettings(dir);

    if (detected.conflict && !detected.mainPid) {
      info.state = "error";
      info.error = detected.conflict;
      return;
    }

    if (!detected.mainPid) {
      this.stateWhenAbsent();
      return;
    }

    const health = await httpProbe(`http://127.0.0.1:${cfg.port}/health`, { timeout: 2000 });
    const healthy = health.ok && health.status === 200 && health.json?.service === SERVICE_NAME;

    if (healthy) {
      info.health = {
        whatsappEnabled: health.json.whatsappEnabled === true,
        emailEnabled: health.json.emailEnabled === true,
        queueIntervalMs: health.json.queueIntervalMs,
      };
    }

    const crashed = this.crashed && detected.managed && !healthy;

    this.stateWhenRunning(healthy, {
      hardFail: crashed ? "The application crashed (nodemon is waiting for file changes). See the Review Bot log." : null,
    });

    // The bot reads .webhook-secret once at startup.
    try {
      const secretMtime = fs.statSync(path.join(dir, ".webhook-secret")).mtimeMs;

      if (detected.startedAtMs && secretMtime > detected.startedAtMs + 2000) {
        info.secretChangedSinceStart = true;
      }
    } catch {
      // handled by readiness checks
    }
  }

  // Authentication still enforced locally: a keyless POST must be rejected.
  // Never sends a valid key, so no real booking can be created by this check.
  async verifyWebhook() {
    const dir = this.dir();
    if (!dir) return { ok: false, detail: "Review Bot folder not found" };

    const cfg = botSettings(dir);

    const res = await httpProbe(`http://127.0.0.1:${cfg.port}/webhooks/icabbi`, {
      method: "POST",
      timeout: 3000,
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    if (!res.ok) return { ok: false, detail: `Webhook endpoint not reachable (${res.error})` };

    if (res.status === 401) {
      return { ok: true, detail: "Webhook endpoint reachable; unauthenticated requests are rejected (401)" };
    }

    return { ok: false, detail: `Unexpected webhook response HTTP ${res.status} for a request without a key` };
  }

  activity() {
    const dir = this.dir();
    if (!dir) return null;

    return readJsonSafe(path.join(dir, "data", "runtime-status.json"), null);
  }

  async _start() {
    const dir = this.dir();

    if (!dir) throw new HttpError(400, "Review Bot folder not found. Choose it in Settings.");

    const cfg = botSettings(dir);
    const nodemon = this.nodemonBin(dir);

    if (!fs.existsSync(nodemon)) {
      throw new HttpError(400, "Review Bot dependencies are missing (nodemon). Use Settings → Setup → Install dependencies.");
    }

    if (!readWebhookSecret(dir)) {
      throw new HttpError(400, "Review Bot .webhook-secret is missing or not a 64-character hex string");
    }

    const snap = await procman.snapshot({ fresh: true });
    const ports = await procman.listeners();
    const detected = await this.detect(snap, ports);

    if (detected.mainPid) {
      const h = await httpProbe(`http://127.0.0.1:${cfg.port}/health`, { timeout: 2000 });

      if (h.ok && h.status === 200 && h.json?.service === SERVICE_NAME) {
        this.desired = true;
        this.dashboardLog("info", `Already running (pid ${detected.mainPid}); not starting a duplicate`);
        return { ok: true, message: "Review Bot is already running", alreadyRunning: true };
      }

      // A supervisor is alive but the app is not answering (for example nodemon
      // waiting after a crash). Clear exactly that process tree and start fresh.
      this.dashboardLog("warn", `Found an unresponsive Review Bot (pid ${detected.mainPid}); restarting it`);
      await this.killDetected(detected);
      await sleep(800);
    }

    if (detected.conflict && !detected.mainPid) throw new HttpError(409, detected.conflict);

    this.dashboardLog("info", "Starting: nodemon server.js");
    this.crashed = false;

    const res = await procman.spawnLogged({
      file: process.execPath,
      args: [nodemon, "server.js"],
      cwd: dir,
      env: { ...process.env },
      logFile: this.logFile(),
    });

    if (!res.ok) throw new HttpError(500, `Could not start Review Bot: ${res.error}`);

    const after = await procman.snapshot({ fresh: true });
    await this.ctx.registry.set(this.id, { pid: res.pid, start: after.byPid.get(res.pid)?.start || Date.now() });

    this.startedAt = Date.now();
    this.desired = true;
    this.startTailing({ fromEnd: false });

    const up = await this.waitUntil(async () => {
      if (this.crashed) return true;
      const h = await httpProbe(`http://127.0.0.1:${cfg.port}/health`, { timeout: 1500 });
      return h.ok && h.status === 200 && h.json?.service === SERVICE_NAME;
    }, this.startupTimeoutMs, 800);

    if (this.crashed) {
      throw new HttpError(500, "Review Bot crashed during startup. See the Review Bot log for details.");
    }

    if (!up) throw new HttpError(504, "Review Bot started but its health check did not pass in time");

    this.dashboardLog("info", `Review Bot healthy (pid ${res.pid})`);

    return { ok: true, message: "Review Bot started" };
  }
}

module.exports = { BotService, SERVICE_NAME };
