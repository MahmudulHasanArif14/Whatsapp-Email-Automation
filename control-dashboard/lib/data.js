"use strict";

// Read-only views over the Review Bot's queue and archive files, plus the
// runtime sending toggles. The dashboard NEVER writes the queue or archive:
// the bot's own write queue is the only writer, so no update can be lost.

const fs = require("node:fs");
const path = require("node:path");
const { readJsonSafe, atomicWriteJson, readEnvFile } = require("./util");

function normalisePhone(phone) {
  let number = String(phone || "").replace(/\D/g, "");
  number = number.replace(/^0+(?=880)/, "");
  if (number.startsWith("00")) number = number.slice(2);
  return number;
}

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

function readStoreFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return { ok: false, requests: [], error: "File is empty" };
    const json = JSON.parse(raw);
    if (!Array.isArray(json.requests)) return { ok: false, requests: [], error: "Unexpected structure" };
    return { ok: true, requests: json.requests };
  } catch (error) {
    if (error.code === "ENOENT") return { ok: true, requests: [], missing: true };
    return { ok: false, requests: [], error: error.message };
  }
}

function load(botDir) {
  const dataDir = path.join(botDir, "data");
  const queue = readStoreFile(path.join(dataDir, "review-requests.json"));
  const archive = readStoreFile(path.join(dataDir, "sent-requests.json"));
  const status = readJsonSafe(path.join(dataDir, "runtime-status.json"), null);

  return { queue, archive, status, dataDir };
}

// ---------------------------------------------------------------
// Sending toggles
// ---------------------------------------------------------------

function settingsFile(botDir) {
  return path.join(botDir, "data", "runtime-settings.json");
}

function getSending(botDir) {
  const env = readEnvFile(botDir);
  const rt = readJsonSafe(settingsFile(botDir), {}) || {};

  const channel = (flag, key, updatedKey) => {
    const hasOverride = typeof rt[key] === "boolean";
    return {
      enabled: hasOverride ? rt[key] : env[flag] === "true",
      source: hasOverride ? "runtime setting" : ".env",
      updatedAt: hasOverride ? rt[updatedKey] || null : null,
    };
  };

  return {
    whatsapp: channel("ENABLE_WHATSAPP", "whatsappEnabled", "whatsappUpdatedAt"),
    email: channel("ENABLE_EMAIL", "emailEnabled", "emailUpdatedAt"),
  };
}

async function setSending(botDir, changes) {
  const current = getSending(botDir);
  const existing = readJsonSafe(settingsFile(botDir), {}) || {};
  const now = new Date().toISOString();

  const next = {
    whatsappEnabled: current.whatsapp.enabled,
    emailEnabled: current.email.enabled,
    whatsappUpdatedAt: existing.whatsappUpdatedAt || null,
    emailUpdatedAt: existing.emailUpdatedAt || null,
  };

  if (changes.whatsapp !== undefined) {
    if (typeof changes.whatsapp !== "boolean") throw new Error("whatsapp must be true or false");
    if (changes.whatsapp !== next.whatsappEnabled || existing.whatsappEnabled === undefined) {
      next.whatsappUpdatedAt = now;
    }
    next.whatsappEnabled = changes.whatsapp;
  }

  if (changes.email !== undefined) {
    if (typeof changes.email !== "boolean") throw new Error("email must be true or false");
    if (changes.email !== next.emailEnabled || existing.emailEnabled === undefined) {
      next.emailUpdatedAt = now;
    }
    next.emailEnabled = changes.email;
  }

  fs.mkdirSync(path.join(botDir, "data"), { recursive: true });
  await atomicWriteJson(settingsFile(botDir), next);

  return getSending(botDir);
}

// ---------------------------------------------------------------
// Message rows
// ---------------------------------------------------------------

const STATUS_LABEL = {
  pending: "Pending",
  submitted: "Submitted",
  failed: "Failed",
  skipped: "Skipped",
  submitting: "Submitting",
  unknown: "Unknown – review",
};

function providerText(channel, resp) {
  if (!resp) return null;
  if (typeof resp === "string") return resp;
  if (channel === "whatsapp") return resp.messageId || resp.summary || "Accepted";
  const parts = [];
  if (resp.httpStatus) parts.push(`HTTP ${resp.httpStatus}`);
  if (resp.requestId) parts.push(`request-id ${resp.requestId}`);
  return parts.join(" · ") || "Accepted";
}

function messageRow(booking, channel, where, sending) {
  const state = booking[channel] || {};
  const customer = booking.customer || {};
  const applicable = channel === "whatsapp" ? Boolean(normalisePhone(customer.phone)) : isValidEmail(customer.email);

  let status;

  if (state.status === "sent") status = "submitted";
  else if (state.status === "failed") status = "failed";
  else if (state.status === "skipped" || !applicable) status = "skipped";
  else if (state.status === "submitting") status = "submitting";
  else if (state.status === "unknown") status = "unknown";
  else status = "pending";

  const recipient =
    state.recipient || (channel === "whatsapp" ? normalisePhone(customer.phone) : String(customer.email || "").trim()) || null;

  const submittedAt = state.submittedAt || state.sentAt || null;
  const enabled = sending[channel].enabled;

  return {
    key: `${booking.bookingId}:${channel}`,
    bookingId: booking.bookingId,
    channel,
    customerName: customer.name || null,
    recipient: channel === "whatsapp" && recipient ? `+${recipient.replace(/^\+/, "")}` : recipient,
    status,
    statusLabel: STATUS_LABEL[status],
    submittedAt,
    receivedAt: booking.receivedAt || null,
    providerResponse: providerText(channel, state.providerResponse),
    error: state.lastError || state.reason || null,
    attempts: state.attempts || 0,
    nextRetryAt: state.nextRetryAt || null,
    location: where,
    holdReason: status === "pending" && !enabled ? `${channel === "whatsapp" ? "WhatsApp" : "Email"} sending is OFF` : null,
  };
}

function allRows(botDir) {
  const { queue, archive } = load(botDir);
  const sending = getSending(botDir);
  const rows = [];

  const seen = new Set();

  for (const booking of archive.requests) {
    if (!booking || !booking.bookingId) continue;
    seen.add(booking.bookingId);
    for (const ch of ["whatsapp", "email"]) rows.push(messageRow(booking, ch, "archive", sending));
  }

  for (const booking of queue.requests) {
    if (!booking || !booking.bookingId) continue;
    // A booking present in both stores is the same booking; archive wins.
    if (seen.has(booking.bookingId)) continue;
    for (const ch of ["whatsapp", "email"]) rows.push(messageRow(booking, ch, "queue", sending));
  }

  return { rows, errors: [queue.error && `Queue: ${queue.error}`, archive.error && `Archive: ${archive.error}`].filter(Boolean) };
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function statsFor(rows, channel) {
  const mine = rows.filter((r) => r.channel === channel);
  const now = new Date();
  const submitted = mine.filter((r) => r.status === "submitted" && r.submittedAt);
  const submittedNoDate = mine.filter((r) => r.status === "submitted" && !r.submittedAt).length;

  let last = null;

  for (const r of submitted) {
    if (!last || Date.parse(r.submittedAt) > Date.parse(last)) last = r.submittedAt;
  }

  return {
    totalSubmitted: mine.filter((r) => r.status === "submitted").length,
    submittedToday: submitted.filter((r) => sameLocalDay(new Date(r.submittedAt), now)).length,
    submittedThisMonth: submitted.filter((r) => {
      const d = new Date(r.submittedAt);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length,
    pending: mine.filter((r) => r.status === "pending").length,
    failed: mine.filter((r) => r.status === "failed").length,
    needsReview: mine.filter((r) => r.status === "unknown" || r.status === "submitting").length,
    lastSubmissionAt: last,
    submittedWithoutTimestamp: submittedNoDate,
  };
}

function filterRows(rows, { channel, q, status, from, to } = {}) {
  let out = rows;

  if (channel && channel !== "all") out = out.filter((r) => r.channel === channel);
  if (status && status !== "all") out = out.filter((r) => r.status === status);

  if (q) {
    const needle = String(q).toLowerCase().trim();
    const digits = needle.replace(/\D/g, "");

    out = out.filter(
      (r) =>
        String(r.bookingId).toLowerCase().includes(needle) ||
        String(r.customerName || "").toLowerCase().includes(needle) ||
        String(r.recipient || "").toLowerCase().includes(needle) ||
        (digits.length >= 3 && String(r.recipient || "").replace(/\D/g, "").includes(digits)),
    );
  }

  const dayStart = (s) => {
    const d = new Date(`${s}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  };

  const fromMs = from ? dayStart(from) : null;
  const toMs = to ? dayStart(to) : null;

  if (fromMs !== null || toMs !== null) {
    out = out.filter((r) => {
      const stamp = Date.parse(r.submittedAt || r.receivedAt || "");
      if (Number.isNaN(stamp)) return false;
      if (fromMs !== null && stamp < fromMs) return false;
      if (toMs !== null && stamp >= toMs + 86_400_000) return false;
      return true;
    });
  }

  return out.sort((a, b) => Date.parse(b.submittedAt || b.receivedAt || 0) - Date.parse(a.submittedAt || a.receivedAt || 0));
}

// ---------------------------------------------------------------
// Booking queue panel
// ---------------------------------------------------------------

function queueView(botDir) {
  const { queue, archive, status } = load(botDir);
  const sending = getSending(botDir);

  const done = (b, ch) => {
    const applicable = ch === "whatsapp" ? Boolean(normalisePhone(b.customer?.phone)) : isValidEmail(b.customer?.email);
    return !applicable || ["sent", "skipped"].includes(b[ch]?.status);
  };

  const archivedIds = new Set(archive.requests.map((b) => b.bookingId));
  const bookings = queue.requests.map((b) => {
    const wa = messageRow(b, "whatsapp", "queue", sending);
    const em = messageRow(b, "email", "queue", sending);
    const complete = done(b, "whatsapp") && done(b, "email");

    return {
      bookingId: b.bookingId,
      customerName: b.customer?.name || null,
      receivedAt: b.receivedAt || null,
      whatsapp: { status: wa.status, label: wa.statusLabel, recipient: wa.recipient, error: wa.error, hold: wa.holdReason, attempts: wa.attempts },
      email: { status: em.status, label: em.statusLabel, recipient: em.recipient, error: em.error, hold: em.holdReason, attempts: em.attempts },
      complete,
      alreadyArchived: archivedIds.has(b.bookingId),
      processing: status?.processing?.bookingId === b.bookingId,
    };
  });

  const pendingBookings = bookings.filter((b) => !b.complete && !b.alreadyArchived);

  return {
    errors: [queue.error && `Queue: ${queue.error}`, archive.error && `Archive: ${archive.error}`].filter(Boolean),
    totals: {
      queued: bookings.length,
      pendingBookings: pendingBookings.length,
      whatsappPending: bookings.filter((b) => b.whatsapp.status === "pending").length,
      emailPending: bookings.filter((b) => b.email.status === "pending").length,
      failedChannels: bookings.reduce((n, b) => n + (b.whatsapp.status === "failed" ? 1 : 0) + (b.email.status === "failed" ? 1 : 0), 0),
      awaitingArchive: bookings.filter((b) => b.complete || b.alreadyArchived).length,
      archived: archive.requests.length,
    },
    processing: status?.processing || null,
    lastQueueRunAt: status?.lastQueueRunAt || null,
    bookings,
  };
}

function activity(botDir) {
  const { queue, archive, status } = load(botDir);

  // Latest webhook: the bot's heartbeat if present, otherwise the newest
  // recorded booking arrival (never invented).
  let lastWebhookAt = status?.lastWebhookAt || null;

  if (!lastWebhookAt) {
    for (const b of [...queue.requests, ...archive.requests]) {
      if (b.receivedAt && (!lastWebhookAt || Date.parse(b.receivedAt) > Date.parse(lastWebhookAt))) {
        lastWebhookAt = b.receivedAt;
      }
    }
  }

  return {
    lastWebhookAt,
    lastWebhookSource: status?.lastWebhookAt ? "bot heartbeat" : lastWebhookAt ? "newest booking record" : null,
    lastWebhookRejectedAt: status?.lastWebhookRejectedAt || null,
    lastQueueRunAt: status?.lastQueueRunAt || null,
    lastActivityAt: status?.lastActivityAt || null,
    lastActivity: status?.lastActivity || null,
    processing: status?.processing || null,
    botStartedAt: status?.startedAt || null,
  };
}

module.exports = {
  getSending,
  setSending,
  allRows,
  statsFor,
  filterRows,
  queueView,
  activity,
};
