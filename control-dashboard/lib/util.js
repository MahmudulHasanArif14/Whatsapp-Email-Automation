"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------

const literalSecrets = new Set();

function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) literalSecrets.add(value);
}

function clearSecrets() {
  literalSecrets.clear();
}

const PATTERNS = [
  [/(https?:\/\/wa\.me\/settings\/linked_devices#)\S+/gi, "$1[redacted-qr]"],
  [/([?&](?:key|api_key|apikey|token|secret)=)[^\s&"']+/gi, "$1[redacted]"],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]"],
  [/("?(?:qr|access_?token|client_?secret|password|authorization)"?\s*[:=]\s*"?)[^\s",}]{6,}/gi, "$1[redacted]"],
  [/\b[a-f0-9]{64}\b/gi, "[redacted-hex]"],
  [/\b\d{9,15}@c\.us\b/g, "[redacted-number]@c.us"],
  [/\b[A-Za-z0-9+/_=-]{48,}\b/g, "[redacted-token]"],
];

function redact(text) {
  let out = String(text);

  for (const secret of literalSecrets) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }

  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }

  return out;
}

// ---------------------------------------------------------------
// Simple .env parser (values are never logged)
// ---------------------------------------------------------------

function parseEnv(text) {
  const out = {};

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }

    out[match[1]] = value;
  }

  return out;
}

function readEnvFile(dir) {
  try {
    return parseEnv(fs.readFileSync(path.join(dir, ".env"), "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------
// Atomic JSON helpers
// ---------------------------------------------------------------

async function atomicWriteJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });

  const temp = `${file}.${crypto.randomUUID()}.tmp`;

  try {
    await fsp.writeFile(temp, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });

    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(temp, file);
        return;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 6) {
          throw error;
        }
        await sleep(40 * (attempt + 1));
      }
    }
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function readJsonSafe(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------
// Bounded log buffer
// ---------------------------------------------------------------

class LogBuffer {
  constructor(limit = 3000) {
    this.limit = limit;
    this.entries = [];
    this.seq = 0;
    this.clearedBefore = 0;
  }

  add(service, level, message) {
    const text = redact(String(message)).slice(0, 2000);
    if (!text.trim()) return;

    const entry = {
      id: ++this.seq,
      time: new Date().toISOString(),
      service,
      level,
      message: text,
    };

    this.entries.push(entry);

    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }

    return entry;
  }

  query({ service, level, since = 0, limit = 500 } = {}) {
    const rank = { debug: 0, info: 1, warn: 2, error: 3 };
    const min = rank[level] ?? 0;

    return this.entries
      .filter(
        (e) =>
          e.id > since &&
          (!service || service === "all" || e.service === service) &&
          (rank[e.level] ?? 1) >= min,
      )
      .slice(-limit);
  }

  // Clears only the in-memory view; application files and audit data are untouched.
  clear() {
    this.entries = [];
  }
}

function guessLevel(line) {
  if (/\b(error|err|fatal|exception|failed|unauthorized|crashed|EADDRINUSE|ECONNREFUSED)\b/i.test(line)) {
    return "error";
  }
  if (/\b(warn|warning|WRN)\b/i.test(line)) return "warn";
  if (/^\s*debug:/i.test(line)) return "debug";
  return "info";
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

module.exports = {
  sleep,
  redact,
  registerSecret,
  clearSecrets,
  parseEnv,
  readEnvFile,
  atomicWriteJson,
  readJsonSafe,
  LogBuffer,
  guessLevel,
  isLoopback,
};
