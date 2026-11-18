"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ConfidentialClientApplication } = require("@azure/msal-node");

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb", strict: true }));

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const PORT = Number(process.env.PORT || 3000);

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "review-requests.json");
const ARCHIVE_FILE = path.join(DATA_DIR, "sent-requests.json");
const SECRET_FILE = path.join(__dirname, ".webhook-secret");

// Written by the local control dashboard (never reachable from the internet).
const SETTINGS_FILE = path.join(DATA_DIR, "runtime-settings.json");
// Written by this process so the dashboard can show real activity.
const STATUS_FILE = path.join(DATA_DIR, "runtime-status.json");

// Default is one booking per minute. The override exists for automated tests.
const QUEUE_INTERVAL_MS =
  Number(process.env.QUEUE_INTERVAL_MS) >= 1000
    ? Number(process.env.QUEUE_INTERVAL_MS)
    : 60_000;

const FIXED_INTERVAL = Number(process.env.QUEUE_INTERVAL_MS) >= 1000;

function numEnv(name, fallback) {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

// WhatsApp account-safety limits (0 disables a limit).
// Bookings older than this are not sent a WhatsApp message (late messages to
// people who have moved on are what get numbers reported).
const WA_MAX_AGE_HOURS = numEnv("WA_MAX_AGE_HOURS", 2);
// Most WhatsApp messages submitted per local calendar day.
const WA_DAILY_CAP = numEnv("WA_DAILY_CAP", 40);
// Warm-up after a ban or new number: the cap starts at WA_WARMUP_START_CAP on
// WA_WARMUP_START_DATE (YYYY-MM-DD) and grows by WA_WARMUP_STEP per day until
// it reaches WA_DAILY_CAP. Leave the date empty to disable warm-up.
const WA_WARMUP_START_DATE = process.env.WA_WARMUP_START_DATE || "";
const WA_WARMUP_START_CAP = numEnv("WA_WARMUP_START_CAP", 10);
const WA_WARMUP_STEP = numEnv("WA_WARMUP_STEP", 5);
// Only send WhatsApp messages during these local hours, e.g. "8-21" (0 disables).
const WA_SEND_HOURS = (process.env.WA_SEND_HOURS || "8-21").match(/^(\d{1,2})-(\d{1,2})$/);

function waEffectiveCap() {
  if (!WA_DAILY_CAP) return 0;
  const start = Date.parse(WA_WARMUP_START_DATE);
  if (!Number.isFinite(start)) return WA_DAILY_CAP;
  const days = Math.max(0, Math.floor((Date.now() - start) / 86_400_000));
  return Math.min(WA_DAILY_CAP, WA_WARMUP_START_CAP + days * WA_WARMUP_STEP);
}

function waWithinSendHours(now = new Date()) {
  if (!WA_SEND_HOURS) return true;
  const h = now.getHours();
  return h >= Number(WA_SEND_HOURS[1]) && h < Number(WA_SEND_HOURS[2]);
}
// Random gap between queue runs (ignored when QUEUE_INTERVAL_MS is set).
const JITTER_MIN_MS = numEnv("QUEUE_JITTER_MIN_MS", 15_000);
const JITTER_MAX_MS = Math.max(JITTER_MIN_MS, numEnv("QUEUE_JITTER_MAX_MS", 25_000));

// A completed booking is messaged 2-5 minutes after it arrives: a random time
// in that window per booking, not instantly and not in a fixed rhythm.
const SEND_DELAY_MIN_MS = numEnv("SEND_DELAY_MIN_MS", 120_000);
const SEND_DELAY_MAX_MS = Math.max(SEND_DELAY_MIN_MS, numEnv("SEND_DELAY_MAX_MS", 300_000));

// Minimum random gap between two WhatsApp submissions (0 in fixed-interval tests).
const WA_MIN_GAP_MS = FIXED_INTERVAL ? 0 : numEnv("WA_MIN_GAP_MS", 40_000);
const WA_GAP_JITTER_MS = FIXED_INTERVAL ? 0 : 30_000;
let nextWhatsAppAllowedAt = 0;

const OPTOUT_FILE = path.join(DATA_DIR, "whatsapp-optout.json");

// A failed channel is retried with exponential back-off, then left for review.
const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 60 * 60_000;

let webhookSecret = "";
let writeQueue = Promise.resolve();
let workerRunning = false;

// --------------------------------------------------
// RUNTIME STATUS (activity heartbeat for the dashboard)
// --------------------------------------------------

const runtimeStatus = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  lastWebhookAt: null,
  lastWebhookResult: null,
  lastWebhookRejectedAt: null,
  lastQueueRunAt: null,
  lastActivityAt: null,
  lastActivity: null,
  processing: null,
};

let statusWriteChain = Promise.resolve();

function recordActivity(text) {
  runtimeStatus.lastActivityAt = new Date().toISOString();
  runtimeStatus.lastActivity = text;
}

function writeStatus() {
  statusWriteChain = statusWriteChain
    .then(() => atomicWrite(STATUS_FILE, runtimeStatus, { backup: false }))
    .catch(() => {});
  return statusWriteChain;
}

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function safeString(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }

  const result = String(value).trim();

  // Reject unresolved iCabbi template placeholders.
  if (/^#[a-z0-9_]+#?$/i.test(result)) {
    return "";
  }

  return result;
}

function normalisePhone(phone) {
  let number = String(phone || "").replace(/\D/g, "");

  // Convert malformed leading zeroes before Bangladesh country code.
  number = number.replace(/^0+(?=880)/, "");

  // Convert international 00 prefix.
  if (number.startsWith("00")) {
    number = number.slice(2);
  }

  return number;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function matchesSecret(candidate) {
  if (!webhookSecret || typeof candidate !== "string") {
    return false;
  }

  const expected = Buffer.from(webhookSecret, "utf8");
  const supplied = Buffer.from(candidate, "utf8");

  return (
    expected.length === supplied.length &&
    crypto.timingSafeEqual(expected, supplied)
  );
}

// Runtime overrides written by the dashboard take priority over .env.
// If the settings file is missing or invalid the .env value is used.
let settingsCache = { mtimeMs: -1, size: -1, value: {} };

function readRuntimeSettings() {
  try {
    const stat = fsSync.statSync(SETTINGS_FILE);

    if (
      stat.mtimeMs === settingsCache.mtimeMs &&
      stat.size === settingsCache.size
    ) {
      return settingsCache.value;
    }

    const parsed = JSON.parse(fsSync.readFileSync(SETTINGS_FILE, "utf8"));

    const value =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};

    settingsCache = { mtimeMs: stat.mtimeMs, size: stat.size, value };

    return value;
  } catch {
    return {};
  }
}

function enabled(name) {
  const runtime = readRuntimeSettings();

  if (name === "ENABLE_WHATSAPP" && typeof runtime.whatsappEnabled === "boolean") {
    return runtime.whatsappEnabled;
  }

  if (name === "ENABLE_EMAIL" && typeof runtime.emailEnabled === "boolean") {
    return runtime.emailEnabled;
  }

  return process.env[name] === "true";
}

// --------------------------------------------------
// JSON STORAGE
// --------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validStore(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(value.requests)
  );
}

// Reads a store file. A zero-byte or corrupt file is never silently
// overwritten: it is renamed aside and the last good backup is restored.
async function readStoreFile(file, label) {
  let raw;

  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { requests: [] };
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(raw);

    if (!validStore(parsed)) {
      throw new Error(`Invalid ${label} store`);
    }

    return parsed;
  } catch (parseError) {
    const quarantine = `${file}.corrupt-${Date.now()}`;

    console.error(
      `${label} file is unreadable (${parseError.message}); moving it to ${path.basename(quarantine)}.`,
    );

    await fs.rename(file, quarantine);

    // Restore the last known good copy, if there is one.
    try {
      const backup = JSON.parse(await fs.readFile(`${file}.bak`, "utf8"));

      if (validStore(backup)) {
        await atomicWrite(file, backup, { backup: false });
        console.error(`${label} restored from backup.`);
        return backup;
      }
    } catch {
      // No usable backup.
    }

    // A zero-byte file held nothing to lose; anything else needs a human.
    if (raw.trim() === "") {
      console.error(`${label} was empty and no backup exists; starting empty.`);
      return { requests: [] };
    }

    throw new Error(
      `${label} file is corrupt and no valid backup exists. ` +
        `The original was kept as ${path.basename(quarantine)}.`,
    );
  }
}

function readStore() {
  return readStoreFile(DATA_FILE, "Review queue");
}

function readArchive() {
  return readStoreFile(ARCHIVE_FILE, "Archive");
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const transient = ["EPERM", "EBUSY", "EACCES"].includes(error.code);

      if (!transient || attempt >= 6) {
        throw error;
      }

      // Antivirus or a reader can briefly lock the file on Windows.
      await sleep(40 * (attempt + 1));
    }
  }
}

async function atomicWrite(file, data, { backup = true } = {}) {
  const tempFile = `${file}.${crypto.randomUUID()}.tmp`;

  try {
    await fs.writeFile(tempFile, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });

    await renameWithRetry(tempFile, file);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }

  if (backup) {
    // Best-effort copy used to recover from a later corrupt/empty file.
    await fs.copyFile(file, `${file}.bak`).catch(() => {});
  }
}

function updateStore(mutator) {
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);

    await atomicWrite(DATA_FILE, store);

    return result;
  });

  writeQueue = operation.catch(() => {});

  return operation;
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "western-cars-review-bot",
    whatsappEnabled: enabled("ENABLE_WHATSAPP"),
    emailEnabled: enabled("ENABLE_EMAIL"),
    queueIntervalMs: QUEUE_INTERVAL_MS,
  });
});

// Old public test endpoint intentionally disabled.
app.all("/test/event", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --------------------------------------------------
// ICABBI WEBHOOK
// --------------------------------------------------

app.post("/webhooks/icabbi", async (req, res) => {
  const suppliedKey = req.query.key;

  console.log("Webhook authentication diagnostics:", {
    keyProvided: typeof suppliedKey === "string",
    suppliedLength: typeof suppliedKey === "string" ? suppliedKey.length : 0,
    expectedLength: webhookSecret.length,
    matches: matchesSecret(suppliedKey),
  });

  if (!matchesSecret(suppliedKey)) {
    runtimeStatus.lastWebhookRejectedAt = new Date().toISOString();
    writeStatus();

    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({
        error: "Expected a JSON object",
      });
    }

    const event = safeString(body.event);

    if (event && event !== "DISPATCH_BOOKING_COMPLETE") {
      return res.status(400).json({
        error: "Unexpected event type",
      });
    }

    const bookingId =
      safeString(body.booking_id) ||
      safeString(body.id) ||
      safeString(body.trip_id) ||
      safeString(body.request_id);

    if (!bookingId) {
      return res.status(400).json({
        error: "No valid booking identifier",
      });
    }

    const result = await updateStore(async (store) => {
      const archive = await readArchive();

      const alreadyArchived = archive.requests.some(
        (item) => item.bookingId === bookingId,
      );

      const alreadyQueued = store.requests.some(
        (item) => item.bookingId === bookingId,
      );

      if (alreadyArchived || alreadyQueued) {
        return { duplicate: true };
      }

      store.requests.push({
        eventId: `DISPATCH_BOOKING_COMPLETE:${bookingId}`,
        bookingId,
        tripId: safeString(body.trip_id) || null,
        requestId: safeString(body.request_id) || null,
        receivedAt: new Date().toISOString(),

        // Earliest time any message may be sent for this booking.
        sendAfter: new Date(
          Date.now() +
            SEND_DELAY_MIN_MS +
            Math.floor(Math.random() * (SEND_DELAY_MAX_MS - SEND_DELAY_MIN_MS + 1)),
        ).toISOString(),

        // Authenticated iCabbi completion webhook.
        eligibility: "verified",

        customer: {
          name: safeString(body.booking_customer_name) || null,
          phone: safeString(body.booking_customer_phone) || null,
          email: safeString(body.booking_customer_email) || null,
        },

        bookingStatus: safeString(body.booking_status) || null,
        completedAtMs: safeString(body.bookingclosedate_ms) || null,

        whatsapp: {
          status: "not_sent",
          attempts: 0,
        },

        email: {
          status: "not_sent",
          attempts: 0,
        },
      });

      return { duplicate: false };
    });

    console.log("iCabbi webhook received:", {
      bookingId,
      duplicate: result.duplicate,
    });

    runtimeStatus.lastWebhookAt = new Date().toISOString();
    runtimeStatus.lastWebhookResult = result.duplicate ? "duplicate" : "queued";
    recordActivity(
      result.duplicate
        ? `Webhook received (duplicate ignored)`
        : `Webhook received; booking queued`,
    );
    writeStatus();

    return res.status(200).json({
      received: true,
      duplicate: result.duplicate,
      messagesSent: false,
    });
  } catch (error) {
    console.error("Webhook processing failed:", error.message);

    return res.status(500).json({
      error: "Webhook processing failed",
    });
  }
});

// --------------------------------------------------
// WHATSAPP REPLIES (opt-out)
// --------------------------------------------------

function safeEqualText(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The gateway reports customers by phone (@c.us) or privacy id (@lid). A
// privacy id is matched to a phone using the message ids we stored when sending.
async function phoneForSender(from) {
  const id = String(from || "");
  if (id.endsWith("@c.us")) return normalisePhone(id.replace(/@.*$/, ""));

  const lid = id.replace(/@.*$/, "");
  if (!lid) return "";

  const [store, archive] = await Promise.all([readStore(), readArchive()]);

  for (const booking of [...store.requests, ...archive.requests]) {
    const messageId = booking.whatsapp && booking.whatsapp.providerResponse && booking.whatsapp.providerResponse.messageId;
    if (messageId && String(messageId).includes(lid)) {
      return normalisePhone(booking.whatsapp.recipient || booking.customer?.phone);
    }
  }

  return "";
}

app.post("/webhooks/whatsapp-reply", async (req, res) => {
  const secret = process.env.WHATSAPP_REPLY_SECRET;

  if (!secret || !safeEqualText(req.query.key, secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const data = body.data || (body.payload && body.payload.data) || {};
    const text = String(data.body || data.text || "").trim();

    if (/^(stop|unsubscribe|opt[\s-]?out|cancel)\W*$/i.test(text)) {
      const phone = await phoneForSender(data.from || data.chatId);

      if (phone && (await addOptOut(phone, "whatsapp-reply"))) {
        console.log("WhatsApp opt-out recorded for a customer.");
        recordActivity("Customer opted out of WhatsApp (STOP)");
        writeStatus();
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Reply webhook failed:", error.message);
    return res.status(200).json({ received: true });
  }
});

// --------------------------------------------------
// OPENWA WHATSAPP
// --------------------------------------------------

let gatewaySessionCache = { name: null, id: null };

async function gatewayFetch(path, options = {}) {
  const base = (process.env.OPENWA_GATEWAY_URL || "http://127.0.0.1:2785").replace(/\/+$/, "");
  const apiKey = process.env.OPENWA_GATEWAY_API_KEY;

  if (!apiKey) throw new Error("OPENWA_GATEWAY_API_KEY is missing");

  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
}

async function gatewaySessionId() {
  const name = process.env.OPENWA_GATEWAY_SESSION || "western-cars";

  if (gatewaySessionCache.name === name && gatewaySessionCache.id) {
    return gatewaySessionCache.id;
  }

  const res = await gatewayFetch("/api/sessions");

  if (!res.ok) {
    throw new Error(`OpenWA gateway HTTP ${res.status} listing sessions`);
  }

  const body = await res.json();
  const list = Array.isArray(body) ? body : body.data || body.sessions || [];
  const session = list.find((item) => item.name === name || item.id === name);

  if (!session) {
    throw new Error(`OpenWA gateway session "${name}" does not exist`);
  }

  if (session.status !== "ready") {
    throw new Error(`OpenWA gateway session is not ready (status: ${session.status})`);
  }

  gatewaySessionCache = { name, id: session.id };

  return session.id;
}

async function sendViaGateway(number, message) {
  let sessionId;

  try {
    sessionId = await gatewaySessionId();
  } catch (error) {
    gatewaySessionCache = { name: null, id: null };
    throw error;
  }

  const response = await gatewayFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`,
    {
      method: "POST",
      body: JSON.stringify({ chatId: `${number}@c.us`, text: message }),
    },
  );

  if (response.status === 429) {
    const details = await response.json().catch(() => ({}));
    const seconds = Number(details.retryAfterSeconds) || 300;
    const paced = new Error("OpenWA gateway pacing limit reached");
    paced.paced = true;
    paced.retryAfterMs = Math.min(Math.max(seconds, 30), 6 * 3600) * 1000;
    throw paced;
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    gatewaySessionCache = { name: null, id: null };
    throw new Error(`OpenWA gateway HTTP ${response.status}: ${details.slice(0, 300)}`);
  }

  const result = await response.json();

  return { status: "submitted", result: { ...result, provider: "openwa-gateway" } };
}

async function sendWhatsApp(phone, message) {
  if (!enabled("ENABLE_WHATSAPP")) {
    return { status: "disabled" };
  }

  const number = normalisePhone(phone);

  if (!number) {
    return {
      status: "failed",
      reason: "Missing phone number",
    };
  }

  // Optional provider: the open-source OpenWA gateway (rmyndharis/OpenWA).
  // Selected with WHATSAPP_PROVIDER=openwa-gateway; otherwise the original
  // OpenWA endpoint below is used unchanged.
  if (process.env.WHATSAPP_PROVIDER === "openwa-gateway") {
    return sendViaGateway(number, message);
  }

  const baseUrl = process.env.OPENWA_BASE_URL;
  const apiKey = process.env.OPENWA_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error("OpenWA configuration is missing");
  }

  const response = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/api/messages/sendText`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        to: `${number}@c.us`,
        content: message,
        options: {},
      }),
      signal: AbortSignal.timeout(30000),
    },
  );

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`OpenWA HTTP ${response.status}: ${details.slice(0, 300)}`);
  }

  return {
    status: "submitted",
    result: await response.json(),
  };
}

// Reduce the provider reply to a small, storable record.
function summariseWhatsAppResponse(result) {
  const data = result && typeof result === "object" ? result : {};

  const messageId =
    (typeof data.id === "string" && data.id) ||
    (typeof data.messageId === "string" && data.messageId) ||
    (data.data && typeof data.data.id === "string" && data.data.id) ||
    (data.data && typeof data.data.messageId === "string" && data.data.messageId) ||
    (typeof data.response === "string" && data.response) ||
    null;

  let text = "";

  try {
    text = JSON.stringify(data);
  } catch {
    text = "";
  }

  return {
    provider: data.provider || "openwa",
    messageId,
    accepted: true,
    summary: text.slice(0, 300),
  };
}

// --------------------------------------------------
// MICROSOFT GRAPH EMAIL
// --------------------------------------------------

function createMsalClient() {
  const { MS_CLIENT_ID, MS_TENANT_ID, MS_CLIENT_SECRET } = process.env;

  if (!MS_CLIENT_ID || !MS_TENANT_ID || !MS_CLIENT_SECRET) {
    throw new Error("Microsoft Graph configuration is missing");
  }

  return new ConfidentialClientApplication({
    auth: {
      clientId: MS_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${MS_TENANT_ID}`,
      clientSecret: MS_CLIENT_SECRET,
    },
  });
}

async function sendReviewEmail(email, name) {
  if (!enabled("ENABLE_EMAIL")) {
    return { status: "disabled" };
  }

  if (!isValidEmail(email)) {
    return {
      status: "failed",
      reason: "Invalid email address",
    };
  }

  const emailFrom = process.env.EMAIL_FROM;

  if (!emailFrom) {
    throw new Error("EMAIL_FROM is missing");
  }

  const msal = createMsalClient();

  const token = await msal.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });

  if (!token?.accessToken) {
    throw new Error("Could not obtain Microsoft Graph access token");
  }

  const customerName = safeString(name) || "there";

  const reviewUrl = "https://g.page/r/CW8I7lfBBbQnEBM/review";

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(emailFrom)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: "Thank you for travelling with Western Cars",
          body: {
            contentType: "Text",
            content:
              `Hello ${customerName},\n\n` +
              "Thank you for travelling with Western Cars. " +
              "We would appreciate it if you could share your feedback " +
              "about your journey.\n\n" +
              `Leave your review here: ${reviewUrl}\n\n` +
              "Thank you,\nWestern Cars",
          },
          toRecipients: [
            {
              emailAddress: {
                address: email,
              },
            },
          ],
        },
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(30000),
    },
  );

  if (!response.ok) {
    const details = await response.text().catch(() => "");

    throw new Error(
      `Microsoft Graph HTTP ${response.status}: ${details.slice(0, 500)}`,
    );
  }

  return {
    status: "submitted",
    providerResponse: {
      provider: "microsoft-graph",
      httpStatus: response.status,
      requestId: response.headers.get("request-id") || null,
      accepted: true,
    },
  };
}

// --------------------------------------------------
// CHANNEL STATE HELPERS
// --------------------------------------------------

const FINISHED = new Set(["sent", "skipped"]);

function channelOf(booking, channel) {
  if (!booking[channel] || typeof booking[channel] !== "object") {
    booking[channel] = { status: "not_sent", attempts: 0 };
  }

  return booking[channel];
}

function channelRecipient(booking, channel) {
  return channel === "whatsapp"
    ? normalisePhone(booking.customer?.phone)
    : String(booking.customer?.email || "").trim();
}

function channelApplicable(booking, channel) {
  return channel === "whatsapp"
    ? Boolean(normalisePhone(booking.customer?.phone))
    : isValidEmail(booking.customer?.email);
}

function channelDone(booking, channel) {
  if (!channelApplicable(booking, channel)) return true;

  return FINISHED.has(booking[channel]?.status);
}

function retryDue(state, now) {
  if (state.status !== "failed") {
    // A deferred job (e.g. the gateway asked us to slow down) waits its turn.
    return !state.nextRetryAt || Date.parse(state.nextRetryAt) <= now;
  }

  if ((state.attempts || 0) >= MAX_ATTEMPTS) return false;

  return !state.nextRetryAt || Date.parse(state.nextRetryAt) <= now;
}

let waSentToday = 0;

function sameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

async function refreshWhatsAppSentToday() {
  const [store, archive] = await Promise.all([readStore(), readArchive()]);
  const now = new Date();
  const seen = new Set();
  let count = 0;

  for (const booking of [...archive.requests, ...store.requests]) {
    if (!booking || seen.has(booking.bookingId)) continue;
    seen.add(booking.bookingId);

    const at = booking.whatsapp && booking.whatsapp.sentAt;
    if (at && sameLocalDay(new Date(at), now)) count += 1;
  }

  waSentToday = count;
}

let optOutCache = { mtimeMs: -1, numbers: {} };

function readOptOuts() {
  try {
    const stat = fsSync.statSync(OPTOUT_FILE);
    if (stat.mtimeMs === optOutCache.mtimeMs) return optOutCache.numbers;
    const parsed = JSON.parse(fsSync.readFileSync(OPTOUT_FILE, "utf8"));
    optOutCache = { mtimeMs: stat.mtimeMs, numbers: (parsed && parsed.numbers) || {} };
    return optOutCache.numbers;
  } catch {
    return {};
  }
}

function isOptedOut(phone) {
  return Boolean(phone) && Object.prototype.hasOwnProperty.call(readOptOuts(), phone);
}

async function addOptOut(phone, via) {
  const numbers = { ...readOptOuts() };
  if (numbers[phone]) return false;
  numbers[phone] = { at: new Date().toISOString(), via };
  await atomicWrite(OPTOUT_FILE, { numbers }, { backup: false });
  optOutCache = { mtimeMs: -1, numbers: {} };
  return true;
}

function waTooOld(booking, now) {
  if (!WA_MAX_AGE_HOURS) return false;
  const received = Date.parse(booking.receivedAt || "");
  return Number.isFinite(received) && now - received > WA_MAX_AGE_HOURS * 3_600_000;
}

function firstName(name) {
  const token = String(name || "").trim().split(/\s+/)[0] || "";
  if (!/^[\p{L}][\p{L}'’-]{1,19}$/u.test(token)) return null;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

const REVIEW_URL = "https://g.page/r/CW8I7lfBBbQnEBM/review";

function buildReviewMessage(booking) {
  const n = firstName(booking.customer && booking.customer.name);
  const hello = n ? `Hi ${n}` : "Hello";
  const variants = [
    `${hello}, thank you for travelling with Western Cars. We'd really appreciate your feedback on your journey: ${REVIEW_URL}`,
    `${hello}, thanks for choosing Western Cars today. If you have a moment, we'd love a quick review: ${REVIEW_URL}`,
    `${hello}, it was a pleasure to take you with Western Cars. Would you mind sharing your feedback here? ${REVIEW_URL}`,
  ];
  let h = 0;
  for (const ch of String(booking.bookingId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${variants[h % variants.length]} (Reply STOP to opt out.)`;
}

// A channel the worker may act on right now, honouring the toggles.
function channelActionable(booking, channel, now) {
  if (!channelApplicable(booking, channel)) return false;

  const state = booking[channel] || { status: "not_sent" };

  // "submitting" / "unknown" mean a previous send may have been accepted.
  // Never resend those automatically.
  if (FINISHED.has(state.status)) return false;
  if (state.status === "submitting" || state.status === "unknown") return false;

  const flag = channel === "whatsapp" ? "ENABLE_WHATSAPP" : "ENABLE_EMAIL";

  if (!enabled(flag)) return false;

  // Not due yet (records created before this feature have no sendAfter: due now).
  if (booking.sendAfter && Date.parse(booking.sendAfter) > now) return false;

  // Keep WhatsApp submissions a little apart.
  if (channel === "whatsapp" && now < nextWhatsAppAllowedAt) return false;

  // Daily cap: jobs simply wait until tomorrow (never marked sent or skipped).
  if (channel === "whatsapp" && waEffectiveCap() && waSentToday >= waEffectiveCap()) return false;

  // Outside sending hours: wait (the age limit still skips stale bookings).
  if (channel === "whatsapp" && !waWithinSendHours()) return false;

  return retryDue(state, now);
}

// --------------------------------------------------
// UPDATE INDIVIDUAL MESSAGE STATUS
// --------------------------------------------------

async function updateMessageStatus(
  bookingId,
  channel,
  status,
  errorMessage = null,
  extra = {},
) {
  return updateStore((store) => {
    const booking = store.requests.find((item) => item.bookingId === bookingId);

    if (!booking) return;

    const state = channelOf(booking, channel);
    const now = new Date().toISOString();

    state.status = status;
    state.channel = channel;

    if (status === "submitting") {
      // Written BEFORE the provider call so a crash cannot cause a resend.
      state.submittingAt = now;
      state.recipient = channelRecipient(booking, channel);
      return;
    }

    state.attempts = (state.attempts || 0) + 1;
    delete state.submittingAt;

    if (status === "sent") {
      state.sentAt = now;
      state.submittedAt = now;
      state.recipient = channelRecipient(booking, channel);
      state.providerResponse = extra.providerResponse || null;
      delete state.lastError;
      delete state.nextRetryAt;
    }

    if (status === "failed") {
      state.lastError = errorMessage;
      state.lastAttemptAt = now;
      state.recipient = channelRecipient(booking, channel);

      const delay = Math.min(
        MAX_BACKOFF_MS,
        60_000 * 2 ** Math.max(0, state.attempts - 1),
      );

      state.nextRetryAt = new Date(Date.now() + delay).toISOString();
    }
  });
}

// --------------------------------------------------
// ARCHIVE COMPLETED BOOKINGS
// --------------------------------------------------

// Normalises every queued booking, then archives each one whose applicable
// channels are all finished. Bookings that were already archived are dropped
// from the active queue without sending anything.
async function sweepQueue() {
  await updateStore(async (store) => {
    const archive = await readArchive();
    let archiveChanged = false;
    const keep = [];

    for (const booking of store.requests) {
      channelOf(booking, "whatsapp");
      channelOf(booking, "email");

      if (!channelApplicable(booking, "whatsapp") && !FINISHED.has(booking.whatsapp.status)) {
        booking.whatsapp.status = "skipped";
        booking.whatsapp.reason = "No valid phone number";
      }

      if (!channelApplicable(booking, "email") && !FINISHED.has(booking.email.status)) {
        booking.email.status = "skipped";
        booking.email.reason = "No valid email address";
      }

      const waState = booking.whatsapp.status;
      const waOpen = !FINISHED.has(waState) && waState !== "submitting" && waState !== "unknown";

      if (waOpen && channelApplicable(booking, "whatsapp")) {
        if (isOptedOut(normalisePhone(booking.customer && booking.customer.phone))) {
          booking.whatsapp.status = "skipped";
          booking.whatsapp.reason = "Customer opted out (STOP)";
        } else if (waTooOld(booking, Date.now())) {
          booking.whatsapp.status = "skipped";
          booking.whatsapp.reason = `Older than ${WA_MAX_AGE_HOURS} hour(s); not sent to protect the WhatsApp number`;
        }
      }

      const alreadyArchived = archive.requests.some(
        (item) => item.bookingId === booking.bookingId,
      );

      if (alreadyArchived) {
        console.log(
          `Booking ${booking.bookingId} was already archived; removed from queue.`,
        );
        continue;
      }

      if (channelDone(booking, "whatsapp") && channelDone(booking, "email")) {
        archive.requests.push({
          ...booking,
          archivedAt: new Date().toISOString(),
        });

        archiveChanged = true;

        console.log(`Booking ${booking.bookingId} archived.`);
        continue;
      }

      keep.push(booking);
    }

    if (archiveChanged) {
      await atomicWrite(ARCHIVE_FILE, archive);
    }

    store.requests.length = 0;
    store.requests.push(...keep);
  });
}

// --------------------------------------------------
// PROCESS ONE BOOKING
// --------------------------------------------------

const REVIEW_MESSAGE =
  "Thank you for travelling with Western Cars. " +
  "We would appreciate your feedback about your journey. " +
  "You can leave your review here: " +
  "https://g.page/r/CW8I7lfBBbQnEBM/review";

async function currentBooking(bookingId) {
  const store = await readStore();

  return store.requests.find((item) => item.bookingId === bookingId) || null;
}

async function processNextBooking() {
  if (workerRunning) {
    console.log("Queue worker is already running.");
    return;
  }

  workerRunning = true;

  try {
    // Archive anything already complete before choosing new work.
    await sweepQueue();
    await refreshWhatsAppSentToday();

    const store = await readStore();
    const now = Date.now();

    // Oldest booking (by receivedAt) with a channel that can be acted on under
    // the current toggles, so messages go out in the order bookings arrived.
    // A blocked or failing booking never holds up the ones behind it.
    const candidate = store.requests
      .filter(
        (item) =>
          channelActionable(item, "whatsapp", now) ||
          channelActionable(item, "email", now),
      )
      .reduce((oldest, item) => {
        if (!oldest) return item;
        const a = Date.parse(item.receivedAt || "") || Infinity;
        const b = Date.parse(oldest.receivedAt || "") || Infinity;
        return a < b ? item : oldest;
      }, null);

    runtimeStatus.lastQueueRunAt = new Date().toISOString();

    if (!candidate) {
      runtimeStatus.processing = null;
      recordActivity("Queue checked; nothing to send");
      writeStatus();

      console.log("Review queue empty or nothing actionable.");
      return;
    }

    const bookingId = candidate.bookingId;

    runtimeStatus.processing = {
      bookingId,
      startedAt: new Date().toISOString(),
    };
    recordActivity(`Processing booking ${bookingId}`);
    writeStatus();

    console.log(`Processing booking ${bookingId}`);

    // ----------------------------------------------
    // WHATSAPP
    // ----------------------------------------------

    if (channelActionable(candidate, "whatsapp", Date.now())) {
      const phone = normalisePhone(candidate.customer?.phone);

      nextWhatsAppAllowedAt =
        Date.now() + WA_MIN_GAP_MS + Math.floor(Math.random() * (WA_GAP_JITTER_MS + 1));

      try {
        // Recorded before sending; never retried automatically if we crash.
        await updateMessageStatus(bookingId, "whatsapp", "submitting");

        const result = await sendWhatsApp(phone, buildReviewMessage(candidate));

        if (result.status === "submitted") {
          await updateMessageStatus(bookingId, "whatsapp", "sent", null, {
            providerResponse: summariseWhatsAppResponse(result.result),
          });

          recordActivity(`WhatsApp accepted for ${bookingId}`);
          console.log(`WhatsApp accepted for ${bookingId}.`);
        } else {
          // Toggled off mid-run: keep the job pending.
          await updateStore((s) => {
            const item = s.requests.find((r) => r.bookingId === bookingId);
            if (item) channelOf(item, "whatsapp").status = "not_sent";
          });
        }
      } catch (error) {
        if (error.paced) {
          // The gateway is pacing us: wait, without counting a failed attempt.
          await updateStore((s2) => {
            const item = s2.requests.find((r) => r.bookingId === bookingId);
            if (!item) return;
            const st = channelOf(item, "whatsapp");
            st.status = "not_sent";
            delete st.submittingAt;
            st.nextRetryAt = new Date(Date.now() + error.retryAfterMs).toISOString();
            st.reason = "Waiting: WhatsApp pacing limit";
          });
          console.warn(`WhatsApp paced for ${bookingId}; retrying later.`);
        } else {
          await updateMessageStatus(
            bookingId,
            "whatsapp",
            "failed",
            error.message,
          );

          console.error(`WhatsApp failed for ${bookingId}:`, error.message);
        }
      }
    } else if (!enabled("ENABLE_WHATSAPP")) {
      console.log("WhatsApp disabled; leaving message pending.");
    }

    // ----------------------------------------------
    // EMAIL
    // ----------------------------------------------

    const afterWhatsApp = await currentBooking(bookingId);

    if (afterWhatsApp && channelActionable(afterWhatsApp, "email", Date.now())) {
      const email = String(afterWhatsApp.customer?.email || "").trim();

      try {
        await updateMessageStatus(bookingId, "email", "submitting");

        const result = await sendReviewEmail(
          email,
          afterWhatsApp.customer?.name || "there",
        );

        if (result.status === "submitted") {
          await updateMessageStatus(bookingId, "email", "sent", null, {
            providerResponse: result.providerResponse,
          });

          recordActivity(`Email accepted for ${bookingId}`);
          console.log(`Email accepted for ${bookingId}.`);
        } else {
          await updateStore((s) => {
            const item = s.requests.find((r) => r.bookingId === bookingId);
            if (item) channelOf(item, "email").status = "not_sent";
          });
        }
      } catch (error) {
        await updateMessageStatus(bookingId, "email", "failed", error.message);

        console.error(`Email failed for ${bookingId}:`, error.message);
      }
    } else if (!enabled("ENABLE_EMAIL")) {
      console.log("Email disabled; leaving message pending.");
    }

    // ----------------------------------------------
    // ARCHIVE IF ALL APPLICABLE CHANNELS ARE DONE
    // ----------------------------------------------

    await sweepQueue();

    runtimeStatus.processing = null;
    runtimeStatus.lastQueueRunAt = new Date().toISOString();
    writeStatus();
  } catch (error) {
    console.error("Queue worker error:", error.message);

    runtimeStatus.processing = null;
    recordActivity(`Queue worker error: ${error.message.slice(0, 120)}`);
    writeStatus();
  } finally {
    workerRunning = false;
  }
}

// A previous run may have died between "submitting" and the provider reply.
// Mark those as unknown so they are never sent a second time automatically.
async function markInterruptedSubmissions() {
  await updateStore((store) => {
    for (const booking of store.requests) {
      for (const channel of ["whatsapp", "email"]) {
        const state = booking[channel];

        if (state && state.status === "submitting") {
          state.status = "unknown";
          state.reason =
            "Process stopped while submitting; outcome unknown. Not retried.";
          console.warn(
            `Booking ${booking.bookingId}: ${channel} submission outcome unknown; not retrying.`,
          );
        }
      }
    }
  });
}

// --------------------------------------------------
// START SERVER AND QUEUE
// --------------------------------------------------

async function start() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });

    webhookSecret = (await fs.readFile(SECRET_FILE, "utf8")).trim();

    if (!/^[a-f0-9]{64}$/.test(webhookSecret)) {
      throw new Error("Invalid webhook secret format");
    }

    // Ensure both JSON files exist.
    try {
      await fs.access(DATA_FILE);
    } catch {
      await atomicWrite(DATA_FILE, { requests: [] });
    }

    try {
      await fs.access(ARCHIVE_FILE);
    } catch {
      await atomicWrite(ARCHIVE_FILE, { requests: [] });
    }

    await markInterruptedSubmissions();

    app.listen(PORT, "127.0.0.1", () => {
      console.log("------------------------------------");
      console.log("Western Cars Review Bot started");
      console.log(`Server: http://127.0.0.1:${PORT}`);
      console.log(`Webhook secret loaded: ${Boolean(webhookSecret)}`);
      console.log(`WhatsApp enabled: ${enabled("ENABLE_WHATSAPP")}`);
      console.log(`Email enabled: ${enabled("ENABLE_EMAIL")}`);
      console.log("Queue interval: 60 seconds");
      console.log("One booking per queue run");
      console.log("------------------------------------");

      recordActivity("Review Bot started");
      writeStatus();

      // First run after the normal wait, then a random gap between runs so the
      // sending pattern is not a fixed robotic rhythm (QUEUE_INTERVAL_MS pins it).
      const nextDelay = () =>
        FIXED_INTERVAL
          ? QUEUE_INTERVAL_MS
          : JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1));

      const scheduleNext = (delay) => {
        runtimeStatus.nextRunAt = new Date(Date.now() + delay).toISOString();

        setTimeout(async () => {
          await processNextBooking();
          scheduleNext(nextDelay());
        }, delay);
      };

      scheduleNext(FIXED_INTERVAL ? QUEUE_INTERVAL_MS : 15_000);
    });
  } catch (error) {
    console.error("Startup failed:", error.message);
    process.exit(1);
  }
}

start();
