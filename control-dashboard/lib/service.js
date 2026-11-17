"use strict";

const path = require("node:path");
const procman = require("./procman");
const { sleep, guessLevel } = require("./util");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sameDir(cmd, dir) {
  if (!cmd || !dir) return false;
  const norm = (s) => String(s).replace(/\//g, "\\").toLowerCase();
  return norm(cmd).includes(norm(dir));
}

async function httpProbe(url, { timeout = 2000, method = "GET", body, headers } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
      redirect: "manual",
    });

    const text = await res.text().catch(() => "");
    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return { ok: true, status: res.status, text, json };
  } catch (error) {
    return { ok: false, status: 0, text: "", json: null, error: error.cause?.code || error.name || "error" };
  }
}

// Shared behaviour: exclusive operations, log tailing, process lifecycle.
class Service {
  constructor(ctx, id, label, { startupTimeoutMs = 90000 } = {}) {
    this.ctx = ctx;
    this.id = id;
    this.label = label;
    this.startupTimeoutMs = startupTimeoutMs;

    this.busy = null; // name of the running operation
    this.desired = false; // true after a successful start, false after stop
    this.startedAt = null; // when this dashboard issued the start
    this.exitNote = null;
    this.tailer = null;

    this.info = this.blankInfo();
  }

  blankInfo() {
    return {
      id: this.id,
      label: this.label,
      state: "stopped",
      pid: null,
      pids: [],
      managed: false,
      adopted: false,
      uptimeStartedAt: null,
      busy: null,
      error: null,
      detail: "",
      logCaptured: false,
    };
  }

  log(level, message) {
    this.ctx.logs.add(this.id, level, message);
  }

  dashboardLog(level, message) {
    this.ctx.logs.add("dashboard", level, `[${this.label}] ${message}`);
  }

  logFile() {
    return path.join(this.ctx.logDir, `${this.id}.log`);
  }

  startTailing({ fromEnd = true } = {}) {
    if (this.tailer) this.tailer.stop();

    this.tailer = new procman.Tailer(this.logFile(), (line) => {
      this.onLine(line);
      this.log(guessLevel(line), line);
    });

    this.tailer.start({ fromEnd });
  }

  onLine() {}

  // Run an operation exclusively; refuses a concurrent one (double-click safe).
  async exclusive(name, fn) {
    if (this.busy) {
      throw new HttpError(409, `${this.label} is busy: ${this.busy}`);
    }

    this.busy = name;
    this.info.busy = name;

    try {
      return await fn();
    } finally {
      this.busy = null;
      this.info.busy = null;
    }
  }

  async waitUntil(predicate, timeoutMs, intervalMs = 1000) {
    const end = Date.now() + timeoutMs;

    while (Date.now() < end) {
      if (await predicate()) return true;
      await sleep(intervalMs);
    }

    return false;
  }

  // Subclasses implement detect() -> { pids, mainPid, managed, adopted, note }
  // and probe(detected) -> updates this.info.
  async refresh(snap, ports) {
    const detected = await this.detect(snap, ports);
    const info = this.blankInfo();

    info.busy = this.busy;
    info.logCaptured = Boolean(detected.managed);
    info.pids = detected.pids || [];
    info.pid = detected.mainPid || null;
    info.managed = Boolean(detected.managed);
    info.adopted = Boolean(detected.adopted);
    info.uptimeStartedAt = detected.startedAtMs ? new Date(detected.startedAtMs).toISOString() : null;
    info.detail = detected.note || "";
    info.conflict = detected.conflict || null;

    this.info = info;

    await this.probe(detected, snap);

    return this.info;
  }

  stateWhenRunning(healthy, { hardFail = null } = {}) {
    const info = this.info;

    if (hardFail) {
      info.state = "error";
      info.error = hardFail;
      return;
    }

    if (healthy) {
      info.state = "running";
      if (!this.busy) this.desired = true;
      this.exitNote = null;
      return;
    }

    const age = this.startedAt ? Date.now() - this.startedAt : Infinity;
    info.state = age < this.startupTimeoutMs ? "starting" : "error";

    if (info.state === "error" && !info.error) {
      info.error = "Process is running but not responding to health checks";
    }
  }

  stateWhenAbsent() {
    const info = this.info;

    if (this.desired && !this.busy) {
      info.state = "error";
      info.error = this.exitNote || "Process exited unexpectedly";
    } else {
      info.state = "stopped";
    }
  }

  async killDetected(detected) {
    const snap = await procman.snapshot({ fresh: true });
    const pids = new Set((detected.pids || []).filter((p) => p !== process.pid));

    for (const pid of [...pids]) {
      for (const d of procman.descendantsOf(snap, [pid])) pids.add(d);
    }

    const list = [...pids];
    await procman.killPids(list);
    const gone = await procman.waitGone(list, 8000);

    return { list, gone };
  }

  async _stop({ silent = false } = {}) {
    {
      this.desired = false;
      this.exitNote = null;

      const snap = await procman.snapshot({ fresh: true });
      const ports = await procman.listeners();
      const detected = await this.detect(snap, ports);

      if (!detected.pids.length) {
        await this.ctx.registry.set(this.id, null);
        return { ok: true, message: `${this.label} was not running` };
      }

      if (!silent) this.dashboardLog("info", `Stopping (pids ${detected.pids.join(", ")})`);

      this.info.state = "stopping";
      const { gone, list } = await this.killDetected(detected);

      await this.ctx.registry.set(this.id, null);
      await this.afterStop?.();

      if (!gone) {
        this.dashboardLog("error", "Some processes did not exit after being stopped");
        throw new HttpError(500, `${this.label}: some processes did not exit`);
      }

      this.dashboardLog("info", `Stopped (${list.length} process(es))`);

      return { ok: true, message: `${this.label} stopped` };
    }
  }

  start() {
    return this.exclusive("starting", () => this._start());
  }

  stop() {
    return this.exclusive("stopping", () => this._stop());
  }

  restart() {
    return this.exclusive("restarting", async () => {
      await this._stop({ silent: true });
      await sleep(800);
      return this._start();
    });
  }
}

module.exports = { Service, HttpError, httpProbe, sameDir };
