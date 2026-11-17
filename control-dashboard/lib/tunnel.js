"use strict";

// Manages the EXISTING Cloudflare named tunnel. This module never creates a
// tunnel, never touches DNS and never changes the Cloudflare account. It only
// inspects, runs `cloudflared ... run <name>` and (on explicit request) repairs
// the local config.yml after taking a backup.

const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns").promises;
const procman = require("./procman");
const { Service, HttpError, httpProbe } = require("./service");
const { FIXED_HOSTNAME, TUNNEL_NAME, cloudflaredHome, botSettings, WEBHOOK_PATH } = require("./config");
const { atomicWriteJson } = require("./util");

const KNOWN_PATHS = [
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\Cloudflare\\Cloudflared\\cloudflared.exe",
];

// Minimal parser for the cloudflared config shape (scalars + ingress list).
function parseConfig(text) {
  const result = { scalars: {}, ingress: [] };
  let inIngress = false;
  let current = null;

  const clean = (v) => String(v).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");

  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    if (/^ingress\s*:/.test(raw)) {
      inIngress = true;
      continue;
    }

    if (inIngress && /^\s+-\s/.test(raw)) {
      current = {};
      result.ingress.push(current);
      const m = /^\s+-\s+([A-Za-z]+)\s*:\s*(.*)$/.exec(raw);
      if (m) current[m[1]] = clean(m[2]);
      continue;
    }

    if (inIngress && /^\s+[A-Za-z]+\s*:/.test(raw) && current) {
      const m = /^\s+([A-Za-z]+)\s*:\s*(.*)$/.exec(raw);
      if (m) current[m[1]] = clean(m[2]);
      continue;
    }

    const top = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(raw);

    if (top) {
      inIngress = false;
      result.scalars[top[1]] = clean(top[2]);
    }
  }

  return result;
}

class TunnelService extends Service {
  constructor(ctx) {
    super(ctx, "tunnel", "Cloudflare Tunnel", { startupTimeoutMs: 45_000 });

    this.connections = 0;
    this.lastError = null;
    this.inspectCache = { at: 0, value: null };
    this.listCache = { at: 0, value: null };
    this.publicCache = { at: 0, value: null };
    this.exe = null;
  }

  onLine(line) {
    if (/Registered tunnel connection/i.test(line)) this.connections += 1;
    if (/Unregistered tunnel connection|Lost connection|connection .* terminated/i.test(line)) {
      this.connections = Math.max(0, this.connections - 1);
    }
    if (/\bERR\b/.test(line)) this.lastError = line.replace(/^\S+\s+ERR\s+/, "").slice(0, 300);
  }

  async findExe() {
    if (this.exe && fs.existsSync(this.exe)) return this.exe;

    const where = await procman.run("where.exe", ["cloudflared"], { timeout: 5000 });
    const first = where.ok ? where.stdout.split(/\r?\n/).find((l) => l.trim()) : null;

    if (first && fs.existsSync(first.trim())) {
      this.exe = first.trim();
      return this.exe;
    }

    this.exe = KNOWN_PATHS.find((p) => fs.existsSync(p)) || null;

    return this.exe;
  }

  // Read-only local inspection. `network: true` also asks Cloudflare for the
  // tunnel list/connectors (read-only `tunnel list` / `tunnel info`).
  async inspect({ force = false, network = false } = {}) {
    const now = Date.now();

    if (!force && !network && this.inspectCache.value && now - this.inspectCache.at < 15_000) {
      return this.inspectCache.value;
    }

    const home = cloudflaredHome();
    const exe = await this.findExe();
    const issues = [];
    const r = {
      installed: Boolean(exe),
      exePath: exe,
      version: null,
      outdated: false,
      authConfigured: fs.existsSync(path.join(home, "cert.pem")),
      tunnelName: TUNNEL_NAME,
      tunnelId: null,
      tunnelFound: null,
      credentialsFile: null,
      credentialsExists: false,
      configFile: path.join(home, "config.yml"),
      configExists: false,
      hostname: FIXED_HOSTNAME,
      hostnameConfigured: false,
      localTarget: null,
      expectedTarget: null,
      ingressOk: false,
      ingressNotes: [],
      issues,
      checkedAt: new Date().toISOString(),
    };

    if (!exe) {
      issues.push("cloudflared is not installed or not on PATH.");
    } else {
      const v = await procman.run(exe, ["--version"], { timeout: 8000 });
      const m = /version\s+(\S+)/i.exec(v.stdout + v.stderr);
      r.version = m ? m[1] : null;
      r.outdated = /outdated/i.test(v.stdout + v.stderr);
    }

    if (!r.authConfigured) {
      issues.push("Cloudflare login certificate (cert.pem) was not found. It is only needed for tunnel management commands; running an existing tunnel needs the credentials file.");
    }

    // Existing config.yml
    const botDir = this.ctx.dirs().bot;
    const botPort = botDir ? botSettings(botDir).port : 3000;
    r.expectedTarget = `http://127.0.0.1:${botPort}`;

    let parsed = null;

    try {
      parsed = parseConfig(fs.readFileSync(r.configFile, "utf8"));
      r.configExists = true;
    } catch {
      issues.push(`Tunnel config not found: ${r.configFile}`);
    }

    if (parsed) {
      r.credentialsFile = parsed.scalars["credentials-file"] || null;
      r.configTunnel = parsed.scalars.tunnel || null;

      if (r.credentialsFile) r.credentialsExists = fs.existsSync(r.credentialsFile);

      const rule = parsed.ingress.find((i) => (i.hostname || "").toLowerCase() === FIXED_HOSTNAME);

      if (!rule) {
        r.ingressNotes.push(`No ingress rule for ${FIXED_HOSTNAME}`);
      } else {
        r.hostnameConfigured = true;
        r.localTarget = rule.service || null;

        const norm = (s) => String(s || "").replace(/\/+$/, "").toLowerCase().replace("localhost", "127.0.0.1");

        if (norm(rule.service) === norm(r.expectedTarget)) {
          r.ingressOk = true;
        } else {
          r.ingressNotes.push(`${FIXED_HOSTNAME} routes to ${rule.service || "(nothing)"}; expected ${r.expectedTarget}`);
        }

        if (rule.path) r.ingressNotes.push(`The rule has a path filter (${rule.path}); webhooks need /webhooks/icabbi to match`);
      }

      const last = parsed.ingress[parsed.ingress.length - 1];

      if (!last || last.hostname) r.ingressNotes.push("The final ingress rule must be a catch-all (for example http_status:404)");

      // The management dashboard must never be reachable through the tunnel.
      const dashPort = String(this.ctx.dashboardPort);

      for (const rule2 of parsed.ingress) {
        if (new RegExp(`[:/]${dashPort}(/|$)`).test(rule2.service || "")) {
          r.ingressOk = false;
          r.ingressNotes.push(`DANGER: an ingress rule exposes the dashboard port ${dashPort} publicly`);
        }
      }

      if (!r.credentialsFile) issues.push("config.yml has no credentials-file entry.");
      else if (!r.credentialsExists) issues.push(`Credentials file not found: ${r.credentialsFile}`);
    }

    // Tunnel identity from Cloudflare (read-only) when allowed.
    if (exe && r.authConfigured && (network || (this.listCache.value && now - this.listCache.at < 120_000))) {
      const list = await this.tunnelList(exe, network && (force || now - this.listCache.at > 60_000));

      if (list.ok) {
        const t = list.tunnels.find((x) => x.name === TUNNEL_NAME);
        r.tunnelFound = Boolean(t);
        if (t) r.tunnelId = t.id;
        else issues.push(`Tunnel "${TUNNEL_NAME}" was not found in this Cloudflare account.`);
      } else {
        issues.push(`Could not list tunnels: ${list.error}`);
      }
    }

    // Fall back to the id recorded in config.yml / credentials file name.
    if (!r.tunnelId && r.configTunnel && /^[0-9a-f-]{36}$/i.test(r.configTunnel)) r.tunnelId = r.configTunnel;

    if (r.tunnelId && r.configTunnel && r.configTunnel !== r.tunnelId && r.tunnelFound) {
      issues.push(`config.yml references tunnel ${r.configTunnel} but "${TUNNEL_NAME}" has id ${r.tunnelId}`);
    }

    if (!r.hostnameConfigured || !r.ingressOk) issues.push(...r.ingressNotes);

    this.inspectCache = { at: Date.now(), value: r };

    return r;
  }

  async tunnelList(exe, refresh) {
    if (!refresh && this.listCache.value) return this.listCache.value;

    const res = await procman.run(exe, ["tunnel", "list", "--output", "json"], { timeout: 25_000 });
    let value;

    try {
      const tunnels = JSON.parse(res.stdout.slice(res.stdout.indexOf("[")));
      value = { ok: true, tunnels: Array.isArray(tunnels) ? tunnels : [] };
    } catch {
      value = { ok: false, error: (res.stderr || res.error || "unreadable output").split(/\r?\n/)[0].slice(0, 200) };
    }

    this.listCache = { at: Date.now(), value };

    return value;
  }

  // Connectors Cloudflare currently sees for the tunnel (read-only).
  async connectors(exe) {
    const res = await procman.run(exe, ["tunnel", "info", "--output", "json", TUNNEL_NAME], { timeout: 25_000 });

    try {
      const json = JSON.parse(res.stdout.slice(res.stdout.indexOf("{")));
      const conns = (json.conns || []).reduce((n, c) => n + (c.conns ? c.conns.length : 1), 0);
      return { ok: true, count: conns };
    } catch {
      return { ok: false, count: 0 };
    }
  }

  // Proves DNS + tunnel + Review Bot end to end, using the bot's public,
  // secret-free /health route. A DNS lookup alone cannot (proxied CNAMEs hide).
  async publicCheck({ force = false } = {}) {
    const now = Date.now();

    if (!force && this.publicCache.value && now - this.publicCache.at < 30_000) return this.publicCache.value;

    const result = { hostname: FIXED_HOSTNAME, dns: null, reachable: false, botHealthy: false, detail: "", checkedAt: new Date().toISOString() };

    try {
      const addrs = await dns.resolve4(FIXED_HOSTNAME);
      result.dns = { resolves: addrs.length > 0, addresses: addrs.length };
    } catch (error) {
      result.dns = { resolves: false, code: error.code };
    }

    if (!result.dns.resolves) {
      result.detail =
        result.dns.code === "ENOTFOUND" || result.dns.code === "ENODATA"
          ? `No DNS record exists for ${FIXED_HOSTNAME}.`
          : `DNS lookup failed (${result.dns.code || "error"}).`;
    } else {
      const probe = await httpProbe(`https://${FIXED_HOSTNAME}/health`, { timeout: 8000 });

      result.reachable = probe.ok;
      result.httpStatus = probe.status || null;

      if (probe.ok && probe.json?.service === "western-cars-review-bot") {
        result.botHealthy = true;
        result.detail = "Public hostname reaches the Review Bot through the tunnel.";
      } else if (probe.ok) {
        result.detail = `${FIXED_HOSTNAME} answered HTTP ${probe.status} but not from the Review Bot (tunnel stopped, bot stopped, or DNS points elsewhere).`;
      } else {
        result.detail = `Could not reach https://${FIXED_HOSTNAME}/health (${probe.error}).`;
      }
    }

    this.publicCache = { at: Date.now(), value: result };

    return result;
  }

  async detect(snap) {
    const out = { pids: [], mainPid: null, managed: false, adopted: false, note: "" };

    const reg = this.ctx.registry.get(this.id);

    if (reg) {
      const proc = snap.byPid.get(reg.pid);

      if (proc && Math.abs((proc.start || 0) - (reg.start || 0)) < 3000) {
        out.mainPid = reg.pid;
        out.managed = true;
        out.startedAtMs = proc.start;
      }
    }

    if (!out.mainPid) {
      const proc = snap.list.find(
        (p) =>
          /^cloudflared(\.exe)?$/i.test(p.name || "") &&
          /\btunnel\b/i.test(p.cmd || "") &&
          /\brun\b/i.test(p.cmd || "") &&
          (p.cmd || "").includes(TUNNEL_NAME),
      );

      if (proc) {
        out.mainPid = proc.pid;
        out.adopted = true;
        out.startedAtMs = proc.start;
        out.note = "Started outside the dashboard; its output is not captured";
      }
    }

    // Different tunnels run by this machine are left alone.
    if (out.mainPid) out.pids.push(out.mainPid);

    return out;
  }

  async probe(detected) {
    const info = this.info;

    if (!detected.mainPid) {
      this.stateWhenAbsent();
      this.connections = 0;
      return;
    }

    let connections = this.connections;

    if (!detected.managed || connections === 0) {
      // Adopted (or re-attached after a dashboard restart): ask Cloudflare (cached).
      const exe = await this.findExe();

      if (exe && (!this.connCache || Date.now() - this.connCache.at > 30_000)) {
        this.connCache = { at: Date.now(), value: await this.connectors(exe) };
      }

      connections = this.connCache?.value?.count || 0;
    }

    info.connections = connections;
    info.lastError = this.lastError;

    this.stateWhenRunning(connections > 0);

    if (info.state === "starting") info.detail = "Waiting for tunnel connections to register…";
  }

  async _start() {
    const snap = await procman.snapshot({ fresh: true });
    const detected = await this.detect(snap);

    if (detected.mainPid) {
      this.desired = true;
      this.dashboardLog("info", `Tunnel already running (pid ${detected.mainPid}); not starting a duplicate`);
      return { ok: true, message: "Tunnel is already running", alreadyRunning: true };
    }

    const check = await this.inspect({ force: true, network: true });

    const blockers = [];
    if (!check.installed) blockers.push("cloudflared is not installed");
    if (!check.configExists) blockers.push("config.yml is missing");
    if (!check.credentialsExists) blockers.push("credentials file is missing");
    if (check.tunnelFound === false) blockers.push(`tunnel "${TUNNEL_NAME}" does not exist in the account`);

    if (blockers.length) throw new HttpError(400, `Cannot start tunnel: ${blockers.join("; ")}.`);

    if (!check.ingressOk) {
      throw new HttpError(
        400,
        `Tunnel routing is not valid: ${check.ingressNotes.join("; ") || "ingress mismatch"}. Use Cloudflare → Repair config, or fix config.yml.`,
      );
    }

    this.connections = 0;
    this.lastError = null;
    this.dashboardLog("info", `Starting: cloudflared tunnel run ${TUNNEL_NAME}`);

    const res = await procman.spawnLogged({
      file: check.exePath,
      args: ["--config", check.configFile, "tunnel", "run", TUNNEL_NAME],
      cwd: cloudflaredHome(),
      env: { ...process.env },
      logFile: this.logFile(),
    });

    if (!res.ok) throw new HttpError(500, `Could not start cloudflared: ${res.error}`);

    const after = await procman.snapshot({ fresh: true });
    await this.ctx.registry.set(this.id, { pid: res.pid, start: after.byPid.get(res.pid)?.start || Date.now() });

    this.startedAt = Date.now();
    this.desired = true;
    this.startTailing({ fromEnd: false });

    const up = await this.waitUntil(async () => {
      if (!(await procman.snapshot({ fresh: true })).byPid.has(res.pid)) return true;
      return this.connections > 0;
    }, this.startupTimeoutMs, 800);

    const alive = (await procman.snapshot({ fresh: true })).byPid.has(res.pid);

    if (!alive) {
      this.desired = false;
      throw new HttpError(500, `cloudflared exited during startup${this.lastError ? `: ${this.lastError}` : ""}`);
    }

    if (!up) throw new HttpError(504, "cloudflared is running but no tunnel connection registered in time");

    this.publicCache = { at: 0, value: null };
    this.dashboardLog("info", `Tunnel connected (pid ${res.pid})`);

    return { ok: true, message: "Tunnel started" };
  }

  // Writes config.yml only when it is missing or has no valid rule. Always
  // backs up first. Never creates tunnels or DNS records.
  async repairConfig() {
    const check = await this.inspect({ force: true, network: true });

    if (check.ingressOk && check.configExists && check.credentialsExists) {
      return { ok: true, changed: false, message: "Configuration is already valid; nothing was changed." };
    }

    if (!check.tunnelId) {
      throw new HttpError(400, "The existing tunnel id could not be determined (Cloudflare login required), so the config was not changed.");
    }

    const credentials = check.credentialsFile || path.join(cloudflaredHome(), `${check.tunnelId}.json`);

    if (!fs.existsSync(credentials)) {
      throw new HttpError(400, `Credentials file for the existing tunnel was not found: ${credentials}. It cannot be recreated here.`);
    }

    if (check.configExists) {
      const backup = `${check.configFile}.bak-${Date.now()}`;
      fs.copyFileSync(check.configFile, backup);
      this.dashboardLog("info", `Backed up config.yml to ${path.basename(backup)}`);
    }

    const text =
      `tunnel: ${check.tunnelId}\n` +
      `credentials-file: ${credentials}\n\n` +
      `ingress:\n` +
      `  - hostname: ${FIXED_HOSTNAME}\n` +
      `    service: ${check.expectedTarget}\n\n` +
      `  - service: http_status:404\n`;

    fs.mkdirSync(path.dirname(check.configFile), { recursive: true });
    fs.writeFileSync(check.configFile, text, "utf8");
    this.dashboardLog("info", "config.yml repaired for the existing tunnel");
    this.inspectCache = { at: 0, value: null };

    return { ok: true, changed: true, message: "config.yml was rewritten (a backup was kept)." };
  }

  // Exact DNS guidance. The dashboard never performs it.
  dnsHelp(tunnelId) {
    return {
      cli: `cloudflared tunnel route dns ${TUNNEL_NAME} ${FIXED_HOSTNAME}`,
      dashboard: tunnelId
        ? `Cloudflare DNS → add CNAME  ${FIXED_HOSTNAME.split(".")[0]}  →  ${tunnelId}.cfargotunnel.com  (Proxied)`
        : `Cloudflare DNS → add a proxied CNAME for ${FIXED_HOSTNAME} pointing to <tunnel-id>.cfargotunnel.com`,
    };
  }
}

module.exports = { TunnelService, parseConfig };
