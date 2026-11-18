"use strict";

const fs = require("node:fs");
const path = require("node:path");
const procman = require("./procman");
const config = require("./config");
const data = require("./data");
const { OpenWaService } = require("./openwa");
const { GatewayService } = require("./gateway");
const { BotService } = require("./bot");
const { TunnelService } = require("./tunnel");
const { HttpError } = require("./service");
const { LogBuffer, readJsonSafe, atomicWriteJson, readEnvFile, sleep, registerSecret } = require("./util");

// Small persisted key/value store (connection timestamps etc.).
class Persist {
  constructor(file) {
    this.file = file;
    this.data = readJsonSafe(file, {}) || {};
    this.timer = null;
  }

  get(key) {
    return this.data[key] ?? null;
  }

  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => atomicWriteJson(this.file, this.data).catch(() => {}), 300);
  }
}

class Manager {
  constructor() {
    fs.mkdirSync(config.LOG_DIR, { recursive: true });

    this.logs = new LogBuffer(3000);
    this.discovery = config.discover();

    this.ctx = {
      logs: this.logs,
      logDir: config.LOG_DIR,
      dashboardPort: config.DASHBOARD_PORT,
      registry: new procman.Registry(path.join(config.DATA_DIR, "managed-processes.json")),
      persist: new Persist(path.join(config.DATA_DIR, "state.json")),
      dirs: () => ({
        openwa: this.discovery.found.openwa.ok ? this.discovery.found.openwa.dir : null,
        gateway: this.discovery.found.gateway.ok ? this.discovery.found.gateway.dir : null,
        bot: this.discovery.found.bot.ok ? this.discovery.found.bot.dir : null,
      }),
    };

    // The WhatsApp provider is chosen by the Review Bot's .env (WHATSAPP_PROVIDER).
    const botDir = this.ctx.dirs().bot;
    this.useGateway = Boolean(this.ctx.dirs().gateway && botDir && readEnvFile(botDir).WHATSAPP_PROVIDER === "openwa-gateway");
    this.openwa = this.useGateway ? new GatewayService(this.ctx) : new OpenWaService(this.ctx);
    this.bot = new BotService(this.ctx);
    this.tunnel = new TunnelService(this.ctx);
    this.services = { openwa: this.openwa, bot: this.bot, tunnel: this.tunnel };

    this.job = null; // Start All / Stop All progress
    this.readinessCache = { at: 0, value: null };
    this.webhookAuthCache = { at: 0, value: null };
    this.lastState = null;
    this.listeners = new Set();
    this.timer = null;
    this.refreshing = false;
  }

  dashLog(level, message) {
    this.logs.add("dashboard", level, message);
  }

  // -------------------------------------------------------------
  // Background refresh
  // -------------------------------------------------------------

  async start() {
    this.dashLog("info", `Dashboard started on http://${config.DASHBOARD_HOST}:${config.DASHBOARD_PORT}`);

    // Resume log tailing for processes this dashboard started earlier.
    for (const svc of Object.values(this.services)) {
      if (this.ctx.registry.get(svc.id)) {
        svc.desired = true;
        svc.startTailing({ fromEnd: true });
        svc.startedAt = Date.now() - svc.startupTimeoutMs; // already past startup grace
      }
    }

    await this.tick();
  }

  async tick() {
    if (this.refreshing) return;
    this.refreshing = true;

    try {
      const snap = await procman.snapshot();
      const ports = await procman.listeners();

      await Promise.all(Object.values(this.services).map((s) => s.refresh(snap, ports).catch((e) => {
        s.info.state = "error";
        s.info.error = `Status check failed: ${e.message}`;
      })));

      const state = await this.buildState();
      const json = JSON.stringify(state);

      if (json !== this.lastJson) {
        this.lastJson = json;
        this.lastState = state;
        for (const fn of this.listeners) fn(state);
      }
    } catch (error) {
      this.dashLog("error", `Refresh failed: ${error.message}`);
    } finally {
      this.refreshing = false;
      this.timer = setTimeout(() => this.tick(), 2500);
      this.timer.unref?.();
    }
  }

  stopLoop() {
    clearTimeout(this.timer);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // -------------------------------------------------------------
  // State
  // -------------------------------------------------------------

  async buildState() {
    const dirs = this.ctx.dirs();
    const state = {
      time: new Date().toISOString(),
      whatsappProvider: this.useGateway ? "openwa-gateway" : "openwa-legacy",
      dirs: {
        gateway: { ok: this.discovery.found.gateway.ok, source: this.discovery.found.gateway.source, reason: this.discovery.found.gateway.reason, dir: dirs.gateway },
        openwa: { ok: this.discovery.found.openwa.ok, source: this.discovery.found.openwa.source, reason: this.discovery.found.openwa.reason, dir: dirs.openwa },
        bot: { ok: this.discovery.found.bot.ok, source: this.discovery.found.bot.source, reason: this.discovery.found.bot.reason, dir: dirs.bot },
      },
      install: this.installJob || null,
      services: {
        openwa: this.openwa.info,
        bot: this.bot.info,
        tunnel: this.tunnel.info,
      },
      whatsapp: this.openwa.wa,
      job: this.job,
      hostname: config.FIXED_HOSTNAME,
      webhookPath: config.WEBHOOK_PATH,
      tunnelName: config.TUNNEL_NAME,
    };

    if (dirs.bot) {
      state.sending = data.getSending(dirs.bot);
      state.activity = data.activity(dirs.bot);
      const { rows, errors } = data.allRows(dirs.bot);
      state.stats = { whatsapp: data.statsFor(rows, "whatsapp"), email: data.statsFor(rows, "email") };
      state.stats.whatsapp.capUsage = data.waCapUsage(rows, readEnvFile(dirs.bot), this.openwa.wa && this.openwa.wa.senderKey);
      const q = data.queueView(dirs.bot);
      state.queueTotals = q.totals;
      state.storageErrors = [...new Set([...errors, ...q.errors])];

      // Compare what the dashboard set with what the running bot reports.
      const h = this.bot.info.health;
      state.sendingEffective = h ? { whatsapp: h.whatsappEnabled, email: h.emailEnabled } : null;
    }

    state.readiness = await this.readiness();

    return state;
  }

  // -------------------------------------------------------------
  // iCabbi webhook readiness (never includes the secret)
  // -------------------------------------------------------------

  async readiness({ force = false } = {}) {
    const now = Date.now();

    if (!force && this.readinessCache.value && now - this.readinessCache.at < 10_000) return this.readinessCache.value;

    const dirs = this.ctx.dirs();
    const items = [];
    const add = (id, label, status, detail, fix) => items.push({ id, label, status, detail, fix: fix || null });

    const t = await this.tunnel.inspect();

    add("cloudflared", "cloudflared installed", t.installed ? "ok" : "fail", t.installed ? `Version ${t.version || "unknown"}` : "Not found", t.installed ? null : "Install cloudflared from Cloudflare and add it to PATH.");
    add("credentials", "Tunnel credentials and config.yml", t.configExists && t.credentialsExists ? "ok" : "fail", t.configExists ? (t.credentialsExists ? "Found" : `Credentials file missing: ${t.credentialsFile || "(not set)"}`) : "config.yml missing", "Copy the tunnel's config.yml and credentials JSON to this computer's .cloudflared folder.");
    add("ingress", `${config.FIXED_HOSTNAME} → ${t.expectedTarget}`, t.ingressOk ? "ok" : "fail", t.ingressOk ? `Routes to ${t.localTarget}` : t.ingressNotes.join("; ") || "Not configured", t.ingressOk ? null : "Use Cloudflare → Repair config (a backup is kept).");

    const tun = this.tunnel.info;
    add("tunnel", `Tunnel ${config.TUNNEL_NAME} running`, tun.state === "running" ? "ok" : tun.state === "starting" ? "warn" : "fail", tun.state === "running" ? `${tun.connections || 0} connection(s)` : `State: ${tun.state}`, "Start the tunnel.");

    const bot = this.bot.info;
    add("bot", "Review Bot healthy", bot.state === "running" ? "ok" : "fail", bot.state === "running" ? "Local health check passed" : `State: ${bot.state}`, "Start the Review Bot.");

    if (bot.state === "running") {
      if (!this.webhookAuthCache.value || now - this.webhookAuthCache.at > 30_000) {
        this.webhookAuthCache = { at: now, value: await this.bot.verifyWebhook() };
      }
      const w = this.webhookAuthCache.value;
      add("auth", "Webhook authentication enforced", w.ok ? "ok" : "fail", w.detail);
    } else {
      add("auth", "Webhook authentication enforced", "unknown", "Review Bot is not running");
    }

    const secret = dirs.bot ? config.readWebhookSecret(dirs.bot) : null;
    add("secret", "Webhook secret available", secret ? (bot.secretChangedSinceStart ? "warn" : "ok") : "fail", secret ? (bot.secretChangedSinceStart ? "The secret file changed after the bot started — restart the Review Bot so it uses the new secret." : "Loaded from the Review Bot's .webhook-secret") : "Missing or invalid .webhook-secret", "The Review Bot needs a 64-character hex .webhook-secret.");

    // Public end-to-end proof (secret-free /health) — only when everything local is up.
    let publicCheck = this.tunnel.publicCache.value;

    if (tun.state === "running" && bot.state === "running") {
      publicCheck = await this.tunnel.publicCheck({ force });
    }

    if (publicCheck) {
      add("public", `https://${config.FIXED_HOSTNAME} reaches the Review Bot`, publicCheck.botHealthy ? "ok" : "fail", publicCheck.detail, publicCheck.botHealthy ? null : "DNS/tunnel routing is not complete.");
    } else {
      add("public", `https://${config.FIXED_HOSTNAME} reaches the Review Bot`, "unknown", "Start the tunnel and the Review Bot to run the public check.");
    }

    const ready = items.every((i) => i.status === "ok");
    const dnsMissing = publicCheck && publicCheck.dns && !publicCheck.dns.resolves;

    const value = {
      ready,
      items,
      hostname: config.FIXED_HOSTNAME,
      endpoint: config.WEBHOOK_PATH,
      secretConfigured: Boolean(secret),
      checkedAt: new Date().toISOString(),
      dnsHelp: dnsMissing ? this.tunnel.dnsHelp(t.tunnelId) : null,
    };

    this.readinessCache = { at: Date.now(), value };

    return value;
  }

  // The only place the secret-bearing URL is produced (intentional action).
  webhookUrl() {
    const dir = this.ctx.dirs().bot;
    const secret = dir ? config.readWebhookSecret(dir) : null;

    if (!secret) throw new HttpError(400, "The Review Bot's .webhook-secret is missing or invalid.");

    return `https://${config.FIXED_HOSTNAME}${config.WEBHOOK_PATH}?key=${secret}`;
  }

  // -------------------------------------------------------------
  // Start All / Stop All
  // -------------------------------------------------------------

  beginJob(kind, steps) {
    if (this.job && this.job.running) throw new HttpError(409, `${this.job.kind === "start" ? "Start All" : "Stop All"} is already running`);

    this.job = {
      kind,
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps: steps.map((label, i) => ({ id: i, label, status: "pending", detail: "" })),
    };

    return this.job;
  }

  async runStep(job, index, fn) {
    const step = job.steps[index];
    step.status = "running";
    this.pushJob();

    try {
      const result = await fn();
      step.status = result?.status || "ok";
      step.detail = result?.detail || "";
    } catch (error) {
      step.status = "error";
      step.detail = error.message;
      this.dashLog("error", `${job.kind === "start" ? "Start All" : "Stop All"}: ${step.label}: ${error.message}`);
    }

    this.pushJob();

    return step.status;
  }

  pushJob() {
    this.tickSoon();
  }

  tickSoon() {
    for (const fn of this.listeners) fn({ ...(this.lastState || {}), job: JSON.parse(JSON.stringify(this.job)) , partial: true });
  }

  async startAll() {
    const job = this.beginJob("start", [
      "Check Node.js and project folders",
      "Check OpenWA configuration",
      "Start OpenWA",
      "Start Review Bot",
      "Verify webhook endpoint",
      "Check Cloudflare tunnel configuration",
      "Start Cloudflare tunnel",
      "Verify public webhook route",
    ]);

    this.dashLog("info", "Start All requested");

    (async () => {
      const dirs = this.ctx.dirs();

      await this.runStep(job, 0, async () => {
        const problems = [];
        if (!(this.useGateway ? dirs.gateway : dirs.openwa)) problems.push("OpenWA folder not found");
        if (!dirs.bot) problems.push("Review Bot folder not found");
        if (problems.length) throw new Error(`${problems.join("; ")}. Set the folders in Settings.`);
        return { detail: `Node ${process.version}` };
      });

      const folderOk = job.steps[0].status === "ok";

      await this.runStep(job, 1, async () => {
        if (this.useGateway) {
          if (!dirs.gateway) throw new Error("Skipped: gateway folder missing");
          if (!fs.existsSync(path.join(dirs.gateway, "dist", "main.js"))) throw new Error("Gateway is not built. Settings > Setup check > Install gateway");
          if (!fs.existsSync(path.join(dirs.gateway, "node_modules"))) throw new Error("Gateway dependencies are missing. Settings > Setup check > Install gateway");
          return { detail: "OpenWA gateway is installed (open-source engine)" };
        }
        if (!dirs.openwa) throw new Error("Skipped: OpenWA folder missing");
        const cfg = config.openwaSettings(dirs.openwa);
        const missing = ["PROXY_TOKEN", "WA_API_KEY"].filter((k) => !cfg.env[k]);
        if (missing.length) throw new Error(`.env is missing ${missing.join(", ")}`);
        if (cfg.env.PROXY_TOKEN === cfg.env.WA_API_KEY) throw new Error("PROXY_TOKEN and WA_API_KEY must differ");
        return { detail: "Environment looks complete" };
      });

      const waConfigOk = job.steps[1].status === "ok";

      await this.runStep(job, 2, async () => {
        if (!folderOk || !waConfigOk) throw new Error("Skipped: configuration is not valid");
        const res = await this.openwa.start();
        const wa = this.openwa.wa;
        return {
          detail: res.alreadyRunning ? "Already running" : `API is up — WhatsApp: ${wa.label}`,
        };
      });

      await this.runStep(job, 3, async () => {
        if (!dirs.bot) throw new Error("Skipped: Review Bot folder missing");
        const res = await this.bot.start();
        return { detail: res.alreadyRunning ? "Already running" : "Health check passed" };
      });

      await this.runStep(job, 4, async () => {
        const v = await this.bot.verifyWebhook();
        if (!v.ok) throw new Error(v.detail);
        return { detail: v.detail };
      });

      await this.runStep(job, 5, async () => {
        const t = await this.tunnel.inspect({ force: true, network: true });
        const problems = [];
        if (!t.installed) problems.push("cloudflared not installed");
        if (!t.configExists) problems.push("config.yml missing");
        if (!t.credentialsExists) problems.push("credentials file missing");
        if (t.tunnelFound === false) problems.push(`tunnel ${config.TUNNEL_NAME} not found in account`);
        if (!t.ingressOk) problems.push(...(t.ingressNotes.length ? t.ingressNotes : ["ingress is not valid"]));
        if (problems.length) throw new Error(problems.join("; "));
        return { detail: `${config.FIXED_HOSTNAME} → ${t.localTarget}` };
      });

      const cfOk = job.steps[5].status === "ok";

      await this.runStep(job, 6, async () => {
        if (!cfOk) throw new Error("Skipped: tunnel configuration is not valid");
        const res = await this.tunnel.start();
        return { detail: res.alreadyRunning ? "Already running" : `${this.tunnel.connections} connection(s) registered` };
      });

      await this.runStep(job, 7, async () => {
        if (job.steps[6].status !== "ok") throw new Error("Skipped: tunnel is not running");
        const p = await this.tunnel.publicCheck({ force: true });
        this.readinessCache = { at: 0, value: null };
        if (!p.botHealthy) {
          return { status: "warn", detail: p.detail };
        }
        return { detail: p.detail };
      });

      job.running = false;
      job.finishedAt = new Date().toISOString();
      this.dashLog("info", "Start All finished");
      this.pushJob();
    })().catch((e) => {
      job.running = false;
      this.dashLog("error", `Start All aborted: ${e.message}`);
    });

    return { ok: true, message: "Start All started" };
  }

  async stopAll() {
    const job = this.beginJob("stop", ["Stop Cloudflare tunnel", "Stop Review Bot", "Stop OpenWA"]);

    this.dashLog("info", "Stop All requested");

    (async () => {
      await this.runStep(job, 0, async () => ({ detail: (await this.tunnel.stop()).message }));
      await this.runStep(job, 1, async () => ({ detail: (await this.bot.stop()).message }));
      await this.runStep(job, 2, async () => ({ detail: (await this.openwa.stop()).message }));

      job.running = false;
      job.finishedAt = new Date().toISOString();
      this.dashLog("info", "Stop All finished");
      this.readinessCache = { at: 0, value: null };
      this.pushJob();
    })().catch((e) => {
      job.running = false;
      this.dashLog("error", `Stop All aborted: ${e.message}`);
    });

    return { ok: true, message: "Stop All started" };
  }

  // -------------------------------------------------------------
  // Setup wizard
  // -------------------------------------------------------------

  async setupChecks() {
    const checks = [];
    const add = (id, group, label, status, detail, action) => checks.push({ id, group, label, status, detail: detail || "", action: action || null });

    add("node", "System", "Node.js", "ok", `${process.version}`);

    const npm = await procman.run("cmd.exe", ["/d", "/s", "/c", "npm --version"], { timeout: 15000 });
    add("npm", "System", "npm", npm.ok ? "ok" : "fail", npm.ok ? `v${npm.stdout.trim()}` : "npm was not found on PATH");

    const kinds = ["gateway", ...(this.discovery.found.openwa.ok || !this.discovery.found.gateway.ok ? ["openwa"] : []), "bot"];

    for (const kind of kinds) {
      const found = this.discovery.found[kind];
      const label = config.PROJECTS[kind].label;

      add(`${kind}-dir`, label, "Project folder", found.ok ? "ok" : "fail", found.ok ? `${found.dir} (${found.source === "manual" ? "chosen manually" : "found automatically"})` : found.reason, found.ok ? null : { type: "choose-folder", kind });

      if (!found.ok) continue;

      const dir = found.dir;

      if (kind === "gateway") {
        const built = fs.existsSync(path.join(dir, "dist", "main.js"));
        const mods = fs.existsSync(path.join(dir, "node_modules"));
        const sqlite = fs.existsSync(path.join(dir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"));
        const ok = built && mods && sqlite;
        add("gateway-installed", label, "Installed and built", ok ? "ok" : "fail", ok ? "node_modules, database driver and dist/ present" : "Not installed yet. Uses plain Node; no Visual Studio needed.", ok ? null : { type: "install-gateway" });
        const botEnv = this.ctx.dirs().bot ? readEnvFile(this.ctx.dirs().bot) : {};
        const linked = botEnv.WHATSAPP_PROVIDER === "openwa-gateway" && botEnv.OPENWA_GATEWAY_API_KEY;
        add("gateway-link", label, "Linked to the Review Bot", linked ? "ok" : "warn", linked ? "Review Bot sends through the gateway" : "The Review Bot still uses its previous WhatsApp provider. Start the gateway once, then link it.", linked ? null : { type: "link-gateway" });
        continue;
      }
      const hasModules = fs.existsSync(path.join(dir, "node_modules", "dotenv"));
      const hasLock = fs.existsSync(path.join(dir, "package-lock.json"));

      add(`${kind}-deps`, label, "Dependencies installed", hasModules ? "ok" : "fail", hasModules ? "node_modules present" : hasLock ? "Missing — can be installed with npm ci (uses the lockfile)" : "Missing, and no package-lock.json: npm install would be needed", hasModules ? null : { type: "install", kind });

      if (kind === "bot") {
        add("bot-nodemon", label, "Nodemon available", fs.existsSync(path.join(dir, "node_modules", "nodemon", "bin", "nodemon.js")) ? "ok" : "fail", "Used to run the Review Bot with auto-restart");

        const env = readEnvFile(dir);
        const names = ["ENABLE_WHATSAPP", "OPENWA_BASE_URL", "OPENWA_API_KEY", "ENABLE_EMAIL", "EMAIL_FROM", "MS_CLIENT_ID", "MS_TENANT_ID", "MS_CLIENT_SECRET"];
        const missing = names.filter((n) => !env[n]);
        add("bot-env", label, "Required environment variables", missing.length ? "warn" : "ok", missing.length ? `Not set in .env: ${missing.join(", ")}` : "All present (values are never shown)");

        add("bot-secret", label, "Webhook secret file", config.readWebhookSecret(dir) ? "ok" : "fail", config.readWebhookSecret(dir) ? ".webhook-secret is valid" : ".webhook-secret is missing or not a 64-character hex string");
        add("bot-data", label, "Data directory", fs.existsSync(path.join(dir, "data")) ? "ok" : "warn", fs.existsSync(path.join(dir, "data")) ? "data/ exists" : "Will be created by the Review Bot on first start");
      } else {
        const env = readEnvFile(dir);
        const missing = ["PROXY_TOKEN", "WA_API_KEY"].filter((n) => !env[n]);
        add("openwa-env", label, "Required environment variables", missing.length ? "fail" : "ok", missing.length ? `Not set in .env: ${missing.join(", ")}` : "PROXY_TOKEN and WA_API_KEY present (values are never shown)");
        add("openwa-session", label, "WhatsApp session", fs.existsSync(path.join(dir, ".openwa-session")) ? "ok" : "warn", fs.existsSync(path.join(dir, ".openwa-session")) ? "Browser profile folder exists (a QR scan may still be needed)" : "No saved session yet — you will scan a QR code on first start");
      }
    }

    const t = await this.tunnel.inspect({ force: true });
    add("cf-installed", "Cloudflare", "cloudflared installed", t.installed ? "ok" : "fail", t.installed ? `${t.exePath} (${t.version || "version unknown"})` : "Not found on this computer");
    add("cf-auth", "Cloudflare", "Cloudflare login (cert.pem)", t.authConfigured ? "ok" : "warn", t.authConfigured ? "Present" : "Run `cloudflared tunnel login` once on this computer (only needed to inspect tunnels)");
    add("cf-config", "Cloudflare", `Tunnel config for ${config.TUNNEL_NAME}`, t.configExists && t.credentialsExists && t.ingressOk ? "ok" : "fail", t.configExists ? (t.ingressOk ? `${config.FIXED_HOSTNAME} → ${t.localTarget}` : t.issues.join("; ")) : "config.yml missing");

    return { checks, ready: checks.every((c) => c.status !== "fail") };
  }

  async chooseFolder(kind, dir) {
    const saved = await config.saveProjectDir(kind, dir);
    this.discovery = config.discover();
    this.dashLog("info", `${config.PROJECTS[kind].label} folder set`);
    return saved;
  }

  findChrome() {
    const candidates = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];

    return candidates.find((p) => p && fs.existsSync(p)) || null;
  }

  // Background install of the open-source gateway with plain Node.
  installGateway() {
    const dir = this.ctx.dirs().gateway;

    if (!dir) throw new HttpError(400, "Gateway folder not found");
    if (this.installJob && this.installJob.running) throw new HttpError(409, "Install already running");
    if (this.openwa.info.state !== "stopped") throw new HttpError(409, "Stop OpenWA before installing");

    const chrome = this.findChrome();

    if (!chrome) throw new HttpError(400, "Google Chrome or Microsoft Edge was not found. Install Chrome first.");

    const envFile = path.join(dir, ".env");

    if (!fs.existsSync(envFile)) {
      fs.writeFileSync(
        envFile,
        [
          "# Local single-session setup (generated by the dashboard). No secrets here.",
          "AUTO_START_SESSIONS=true",
          "PORT=2785",
          "NODE_ENV=production",
          "DATABASE_TYPE=sqlite",
          "DATABASE_NAME=./data/openwa.sqlite",
          "DATABASE_SYNCHRONIZE=true",
          "ENGINE_TYPE=whatsapp-web.js",
          "SESSION_DATA_PATH=./data/sessions",
          "PUPPETEER_HEADLESS=true",
          "PUPPETEER_ARGS=--no-sandbox,--disable-gpu",
          "STORAGE_TYPE=local",
          "STORAGE_LOCAL_PATH=./data/media",
          "REDIS_ENABLED=false",
          "QUEUE_ENABLED=false",
          "CACHE_ENABLED=false",
          "# Account-safety pacing built into the gateway, and permission to call the local Review Bot.",
          "SEND_PACING_ENABLED=true",
          "SSRF_ALLOWED_HOSTS=localhost,127.0.0.1",
          "",
        ].join("\n"),
      );
    }

    // The browser path differs per computer, so it lives in the gateway's own .env.
    if (!/^PUPPETEER_EXECUTABLE_PATH=/m.test(fs.readFileSync(envFile, "utf8"))) {
      fs.appendFileSync(envFile, `PUPPETEER_EXECUTABLE_PATH=${chrome}\n`);
    }

    const steps = [
      ["Installing packages (npm ci, scripts deferred)", "npm ci --ignore-scripts --no-audit --no-fund"],
      ["Applying the gateway's compatibility patches", "node scripts/postinstall.js"],
      ["Installing the prebuilt database driver", "npm install better-sqlite3@12.11.1 --no-save --no-audit --no-fund"],
      ["Building the gateway", "npm run build"],
    ];

    const job = { running: true, step: 0, total: steps.length, label: steps[0][0], error: null, startedAt: new Date().toISOString(), finishedAt: null };
    this.installJob = job;

    (async () => {
      for (let i = 0; i < steps.length; i++) {
        job.step = i + 1;
        job.label = steps[i][0];
        this.dashLog("info", `Gateway install: ${steps[i][0]}`);

        const res = await procman.run("cmd.exe", ["/d", "/s", "/c", steps[i][1]], {
          cwd: dir,
          timeout: 1_500_000,
          env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" },
        });

        if (!res.ok) {
          job.error = `${steps[i][0]} failed: ${(res.stderr || res.error || "").split(/\r?\n/).filter((l) => l && !/npm warn/i.test(l)).slice(-2).join(" ")}`;
          this.dashLog("error", job.error);
          break;
        }
      }

      job.running = false;
      job.finishedAt = new Date().toISOString();
      if (!job.error) this.dashLog("info", "Gateway install finished");
    })().catch((e) => {
      job.running = false;
      job.error = e.message;
    });

    return { ok: true, message: "Gateway install started" };
  }

  // Writes the gateway settings into the Review Bot's .env (a backup is kept).
  linkGateway() {
    const botDir = this.ctx.dirs().bot;
    const gwDir = this.ctx.dirs().gateway;

    if (!botDir || !gwDir) throw new HttpError(400, "Both folders must be set");

    const { gatewaySettings } = require("./gateway");
    const gw = gatewaySettings(gwDir, {});

    if (!gw.apiKey) throw new HttpError(400, "The gateway has no API key yet. Start the gateway once (Start All), then link it.");

    const file = path.join(botDir, ".env");
    const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.writeFileSync(`${file}.bak-${Date.now()}`, original);

    // Gateway safety defaults (only added when missing).
    const gwEnvFile = path.join(gwDir, ".env");
    const gwEnv = fs.existsSync(gwEnvFile) ? fs.readFileSync(gwEnvFile, "utf8") : "";
    const gwAdd = [];
    if (!/^SEND_PACING_ENABLED=/m.test(gwEnv)) gwAdd.push("SEND_PACING_ENABLED=true");
    if (!/^SSRF_ALLOWED_HOSTS=/m.test(gwEnv)) gwAdd.push("SSRF_ALLOWED_HOSTS=localhost,127.0.0.1");
    if (gwAdd.length) fs.appendFileSync(gwEnvFile, (gwEnv.endsWith("\n") || !gwEnv ? "" : "\n") + gwAdd.join("\n") + "\n");

    const existingBotEnv = readEnvFile(botDir);
    const replySecret = existingBotEnv.WHATSAPP_REPLY_SECRET || require("node:crypto").randomBytes(24).toString("hex");
    registerSecret(replySecret);

    const values = {
      WHATSAPP_REPLY_SECRET: replySecret,
      WHATSAPP_PROVIDER: "openwa-gateway",
      OPENWA_GATEWAY_URL: `http://127.0.0.1:${gw.port}`,
      OPENWA_GATEWAY_SESSION: "western-cars",
      OPENWA_GATEWAY_API_KEY: gw.apiKey,
    };

    const lines = original.split(/\r?\n/);

    for (const [k, v] of Object.entries(values)) {
      const i = lines.findIndex((l) => l.startsWith(`${k}=`));

      if (i >= 0) lines[i] = `${k}=${v}`;
      else {
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        lines.push(`${k}=${v}`, "");
      }
    }

    fs.writeFileSync(file, lines.join("\n"));
    registerSecret(gw.apiKey);
    this.dashLog("info", "Review Bot .env now uses the OpenWA gateway (backup kept). Restart the Review Bot and reload the dashboard.");

    return { ok: true, message: "Linked. Restart the Review Bot and the dashboard to apply." };
  }

  async installDependencies(kind) {
    const dir = this.ctx.dirs()[kind];

    if (!dir) throw new HttpError(400, "Folder not set");

    const svc = kind === "bot" ? this.bot : this.openwa;
    const running = svc.info.state !== "stopped";

    if (running) throw new HttpError(409, `Stop ${svc.label} before installing dependencies`);

    const hasLock = fs.existsSync(path.join(dir, "package-lock.json"));

    if (!hasLock) throw new HttpError(400, "No package-lock.json: refusing to run an unlocked install");

    this.dashLog("info", `Installing ${config.PROJECTS[kind].label} dependencies with npm ci`);

    // Fixed command string: nothing user-supplied is interpolated.
    const res = await procman.run("cmd.exe", ["/d", "/s", "/c", "npm ci --no-audit --no-fund"], { cwd: dir, timeout: 600_000 });

    for (const line of (res.stdout + res.stderr).split(/\r?\n/).slice(-15)) this.logs.add("dashboard", res.ok ? "info" : "error", `[npm ci] ${line}`);

    if (!res.ok) throw new HttpError(500, `npm ci failed: ${(res.stderr || res.error || "").split(/\r?\n/).filter(Boolean).slice(-3).join(" ")}`);

    return { ok: true, message: "Dependencies installed" };
  }
}

module.exports = { Manager };
