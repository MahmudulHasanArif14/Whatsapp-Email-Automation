"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readEnvFile, readJsonSafe, atomicWriteJson, registerSecret } = require("./util");

// ---------------------------------------------------------------
// Fixed, permanent configuration (see README: do not change casually)
// ---------------------------------------------------------------

const FIXED_HOSTNAME = "dev.a1airportcarsworthing.co.uk";
const TUNNEL_NAME = "a1airport-dev";
const WEBHOOK_PATH = "/webhooks/icabbi";

const DASHBOARD_HOST = "127.0.0.1";
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3001);

const DASHBOARD_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(DASHBOARD_DIR, "data");
const LOG_DIR = path.join(DATA_DIR, "logs");
const CONFIG_FILE = path.join(DATA_DIR, "dashboard-config.json");

// Project identification: a folder is only accepted if its server.js carries
// the expected marker, so a wrong folder can never be started by mistake.
const PROJECTS = {
  openwa: {
    folderName: "openwa-render-secure",
    marker: /@open-wa\/wa-automate/,
    label: "OpenWA",
  },
  gateway: {
    folderName: "openwa-gateway",
    marker: /"name"\s*:\s*"openwa"/,
    markerFile: "package.json",
    requiredFiles: ["package.json", path.join("src", "main.ts")],
    label: "OpenWA Gateway",
  },
  bot: {
    folderName: "WesternCarsReviewBot",
    marker: /\/webhooks\/icabbi/,
    label: "Review Bot",
  },
};

function projectRoot() {
  // control-dashboard sits next to the two projects.
  return path.resolve(DASHBOARD_DIR, "..");
}

function loadOverrides() {
  return readJsonSafe(CONFIG_FILE, {}) || {};
}

function validateProjectDir(kind, dir) {
  const def = PROJECTS[kind];
  const result = { ok: false, dir: null, reason: "" };

  if (typeof dir !== "string" || !dir.trim() || dir.includes("\0")) {
    result.reason = "No folder given";
    return result;
  }

  let resolved;

  try {
    resolved = fs.realpathSync(path.resolve(dir.trim()));
  } catch {
    result.reason = "Folder does not exist";
    return result;
  }

  try {
    if (!fs.statSync(resolved).isDirectory()) {
      result.reason = "Not a folder";
      return result;
    }

    const required = def.requiredFiles || ["server.js", "package.json"];
    const markerFile = path.join(resolved, def.markerFile || "server.js");

    if (!required.every((f) => fs.existsSync(path.join(resolved, f)))) {
      result.reason = `${required.join(" or ")} is missing`;
      return result;
    }

    if (!def.marker.test(fs.readFileSync(markerFile, "utf8"))) {
      result.reason = `${path.basename(markerFile)} does not look like the ${def.label} application`;
      return result;
    }
  } catch (error) {
    result.reason = error.message;
    return result;
  }

  return { ok: true, dir: resolved, reason: "" };
}

function discover() {
  const overrides = loadOverrides();
  const root = projectRoot();
  const found = {};

  for (const kind of Object.keys(PROJECTS)) {
    const candidates = [];

    if (overrides[`${kind}Dir`]) candidates.push(overrides[`${kind}Dir`]);

    candidates.push(path.join(root, PROJECTS[kind].folderName));

    // Common alternative layouts: one level up / sibling "ReviewSetup".
    candidates.push(path.join(root, "ReviewSetup", PROJECTS[kind].folderName));

    let chosen = { ok: false, dir: null, reason: "Not found", source: "none" };

    for (const candidate of candidates) {
      const check = validateProjectDir(kind, candidate);

      if (check.ok) {
        chosen = {
          ...check,
          source: candidate === overrides[`${kind}Dir`] ? "manual" : "auto",
        };
        break;
      }

      if (candidate === overrides[`${kind}Dir`]) {
        chosen.reason = `Saved folder is invalid: ${check.reason}`;
      }
    }

    found[kind] = chosen;
  }

  return { root, found };
}

async function saveProjectDir(kind, dir) {
  if (!PROJECTS[kind]) throw new Error("Unknown project");

  const check = validateProjectDir(kind, dir);
  if (!check.ok) throw new Error(check.reason);

  const overrides = loadOverrides();
  overrides[`${kind}Dir`] = check.dir;
  await atomicWriteJson(CONFIG_FILE, overrides);

  return check.dir;
}

// ---------------------------------------------------------------
// Derived settings for each project (ports, keys). Secrets never leave here.
// ---------------------------------------------------------------

function openwaSettings(dir) {
  const env = readEnvFile(dir);
  let apiPort = 8081;

  try {
    const source = fs.readFileSync(path.join(dir, "server.js"), "utf8");
    const match = /OPENWA_PORT\s*=\s*(\d{2,5})/.exec(source);
    if (match) apiPort = Number(match[1]);
  } catch {
    // keep default
  }

  for (const key of ["WA_API_KEY", "PROXY_TOKEN"]) registerSecret(env[key]);

  return {
    env,
    apiHost: "127.0.0.1",
    apiPort,
    proxyPort: Number(env.PORT || 10000),
    sessionId: env.OPENWA_SESSION_ID || "render-test",
    apiKey: env.WA_API_KEY || "",
  };
}

function botSettings(dir) {
  const env = readEnvFile(dir);

  for (const key of ["MS_CLIENT_SECRET", "OPENWA_API_KEY", "WEBHOOK_SECRET"]) {
    registerSecret(env[key]);
  }

  return {
    env,
    port: Number(env.PORT || 3000),
    dataDir: path.join(dir, "data"),
    secretFile: path.join(dir, ".webhook-secret"),
  };
}

function readWebhookSecret(dir) {
  try {
    const value = fs.readFileSync(path.join(dir, ".webhook-secret"), "utf8").trim();
    // Same format check the Review Bot applies at startup.
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function cloudflaredHome() {
  return path.join(os.homedir(), ".cloudflared");
}

module.exports = {
  FIXED_HOSTNAME,
  TUNNEL_NAME,
  WEBHOOK_PATH,
  DASHBOARD_HOST,
  DASHBOARD_PORT,
  DASHBOARD_DIR,
  DATA_DIR,
  LOG_DIR,
  PROJECTS,
  discover,
  saveProjectDir,
  validateProjectDir,
  openwaSettings,
  botSettings,
  readWebhookSecret,
  cloudflaredHome,
  projectRoot,
};
