"use strict";

// Windows process management: inspection, safe process-tree termination and
// detached, log-file-backed spawning (children survive a dashboard restart).

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { sleep, readJsonSafe, atomicWriteJson } = require("./util");

const SNAPSHOT_TTL_MS = 2500;

let cache = { at: 0, value: null, pending: null };

function run(file, args, { timeout = 15000, cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: error && error.killed ? "timed out" : error ? error.message : null,
        });
      },
    );
  });
}

const PS_SNAPSHOT = [
  "$ErrorActionPreference='SilentlyContinue';",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "[pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=$_.Name;cmd=$_.CommandLine;",
  "start=$(if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0})}",
  "} | ConvertTo-Json -Compress",
].join(" ");

async function snapshot({ fresh = false } = {}) {
  const now = Date.now();

  if (!fresh && cache.value && now - cache.at < SNAPSHOT_TTL_MS) return cache.value;
  if (cache.pending) return cache.pending;

  cache.pending = (async () => {
    const res = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SNAPSHOT],
      { timeout: 20000 },
    );

    let list = [];

    try {
      const parsed = JSON.parse(res.stdout);
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      list = cache.value ? cache.value.list : [];
    }

    const byPid = new Map(list.map((p) => [p.pid, p]));
    cache = { at: Date.now(), value: { list, byPid }, pending: null };

    return cache.value;
  })().finally(() => {
    cache.pending = null;
  });

  return cache.pending;
}

// Map of listening TCP port -> owning pid (IPv4 and IPv6 loopback/any).
async function listeners() {
  const res = await run("netstat.exe", ["-ano", "-p", "TCP"], { timeout: 10000 });
  const map = new Map();

  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m) map.set(Number(m[2]), { pid: Number(m[3]), address: m[1] });
  }

  return map;
}

function descendantsOf(snap, rootPids) {
  const result = new Set();
  const queue = [...rootPids];

  while (queue.length) {
    const parent = queue.shift();

    for (const p of snap.list) {
      if (p.ppid === parent && !result.has(p.pid) && !rootPids.includes(p.pid)) {
        result.add(p.pid);
        queue.push(p.pid);
      }
    }
  }

  return [...result];
}

// Walk up through wrapper processes (npx/cmd/nodemon launchers) but never
// past a shell or anything unrelated.
function wrapperAncestors(snap, pid, allow) {
  const out = [];
  let current = snap.byPid.get(pid);

  while (current) {
    const parent = snap.byPid.get(current.ppid);

    if (!parent || parent.pid === current.pid || !allow(parent)) break;

    out.push(parent.pid);
    current = parent;
  }

  return out;
}

async function killPids(pids) {
  const targets = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 4 && p !== process.pid);
  if (!targets.length) return;

  // Children first so wrappers cannot respawn them.
  for (const pid of targets.reverse()) {
    await run("taskkill.exe", ["/F", "/PID", String(pid)], { timeout: 8000 });
  }
}

async function waitGone(pids, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    const snap = await snapshot({ fresh: true });
    if (!pids.some((p) => snap.byPid.has(p))) return true;
    await sleep(300);
  }

  return false;
}

// Spawn detached with stdout/stderr appended to a log file. Because the child
// owns the file handle (not a pipe) it keeps running if the dashboard exits.
function spawnLogged({ file, args, cwd, env, logFile }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  // Keep one previous run so a new run never replays old crash lines.
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 0) {
      fs.renameSync(logFile, `${logFile}.prev`);
    }
  } catch {
    // rotation is best-effort
  }

  const fd = fs.openSync(logFile, "a");

  const child = spawn(file, args, {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", fd, fd],
  });

  fs.closeSync(fd);

  const spawned = new Promise((resolve) => {
    child.once("spawn", () => resolve({ ok: true, pid: child.pid }));
    child.once("error", (error) => resolve({ ok: false, error: error.message }));
  });

  child.unref();

  return spawned;
}

// ---------------------------------------------------------------
// Registry of processes started by the dashboard
// ---------------------------------------------------------------

class Registry {
  constructor(file) {
    this.file = file;
    this.data = readJsonSafe(file, {}) || {};
  }

  get(id) {
    return this.data[id] || null;
  }

  async set(id, value) {
    if (value) this.data[id] = value;
    else delete this.data[id];

    await atomicWriteJson(this.file, this.data).catch(() => {});
  }
}

// Tails a log file, emitting new complete lines.
class Tailer {
  constructor(file, onLine) {
    this.file = file;
    this.onLine = onLine;
    this.offset = 0;
    this.carry = "";
    this.timer = null;
  }

  start({ fromEnd = true } = {}) {
    try {
      this.offset = fromEnd && fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    } catch {
      this.offset = 0;
    }

    this.stop();
    this.timer = setInterval(() => this.poll(), 700);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    let size;

    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }

    if (size < this.offset) {
      this.offset = 0;
      this.carry = "";
    }

    if (size === this.offset) return;

    const length = Math.min(size - this.offset, 512 * 1024);
    const buffer = Buffer.alloc(length);

    try {
      const fd = fs.openSync(this.file, "r");
      fs.readSync(fd, buffer, 0, length, this.offset);
      fs.closeSync(fd);
    } catch {
      return;
    }

    this.offset += length;

    const text = this.carry + buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    this.carry = lines.pop() || "";

    for (const line of lines) {
      // Strip ANSI colour codes.
      const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      if (clean.trim()) this.onLine(clean);
    }
  }
}

module.exports = {
  run,
  snapshot,
  listeners,
  descendantsOf,
  wrapperAncestors,
  killPids,
  waitGone,
  spawnLogged,
  Registry,
  Tailer,
};
