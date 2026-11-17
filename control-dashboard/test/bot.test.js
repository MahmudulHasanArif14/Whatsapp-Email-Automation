"use strict";

// Integration tests for the Review Bot's queue, runtime toggles and storage
// recovery. The bot runs from a temporary copy with fake credentials, a temp
// data folder and all provider calls mocked (see mock-preload.js).
//
//   BOT_SERVER=<path to server.js under test>  (default: sibling project)
//   BOT_DIR=<dir holding node_modules>         (default: sibling project)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BOT_DIR =
  process.env.BOT_DIR || path.resolve(__dirname, "..", "..", "WesternCarsReviewBot");
const BOT_SERVER = process.env.BOT_SERVER || path.join(BOT_DIR, "server.js");
const PRELOAD = path.join(__dirname, "mock-preload.js");
const PORT = 3190 + Math.floor(Math.random() * 50);
const SECRET = "a".repeat(64);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-bot-test-"));
  fs.copyFileSync(BOT_SERVER, path.join(dir, "server.js"));
  fs.writeFileSync(path.join(dir, ".webhook-secret"), SECRET);
  fs.writeFileSync(
    path.join(dir, ".env"),
    [
      "ENABLE_WHATSAPP=true",
      "ENABLE_EMAIL=true",
      "OPENWA_BASE_URL=http://127.0.0.1:1",
      "OPENWA_API_KEY=fake-key",
      "EMAIL_FROM=sender@example.test",
      "MS_CLIENT_ID=x",
      "MS_TENANT_ID=y",
      "MS_CLIENT_SECRET=z",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(dir, "data"));

  return {
    dir,
    data: path.join(dir, "data"),
    mockLog: path.join(dir, "mock.jsonl"),
  };
}

function booking(id, { phone, email } = {}) {
  return {
    eventId: `DISPATCH_BOOKING_COMPLETE:${id}`,
    bookingId: id,
    receivedAt: new Date().toISOString(),
    eligibility: "verified",
    customer: { name: `Test ${id}`, phone: phone || null, email: email || null },
    bookingStatus: "COMPLETED",
    whatsapp: { status: "not_sent", attempts: 0 },
    email: { status: "not_sent", attempts: 0 },
  };
}

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function startBot(sb, extraEnv = {}) {
  const child = spawn(process.execPath, ["-r", PRELOAD, "server.js"], {
    cwd: sb.dir,
    env: {
      ...process.env,
      ...extraEnv,
      PORT: String(PORT),
      QUEUE_INTERVAL_MS: "1000",
      MOCK_LOG: sb.mockLog,
      NODE_PATH: path.join(BOT_DIR, "node_modules"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.output = "";
  child.stdout.on("data", (d) => (child.output += d));
  child.stderr.on("data", (d) => (child.output += d));

  return child;
}

async function waitFor(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // keep waiting
    }
    await sleep(150);
  }

  throw new Error(`Timed out waiting for: ${label}`);
}

const health = () =>
  fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());

function sends(sb) {
  if (!fs.existsSync(sb.mockLog)) return [];

  return fs
    .readFileSync(sb.mockLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function stop(child) {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
}

test("runtime toggles, independence, resume, no duplicates, restart safety", async () => {
  const sb = makeSandbox();

  writeJson(path.join(sb.data, "review-requests.json"), {
    requests: [
      booking("A1", { phone: "447700900001", email: "a1@example.test" }),
      booking("B2", { phone: "447700900002" }),
    ],
  });
  writeJson(path.join(sb.data, "sent-requests.json"), { requests: [] });

  // WhatsApp OFF, email ON.
  writeJson(path.join(sb.data, "runtime-settings.json"), {
    whatsappEnabled: false,
    emailEnabled: true,
  });

  let bot = startBot(sb);

  try {
    await waitFor(async () => (await health()).status === "ok", "bot health");

    const h = await health();
    assert.equal(h.whatsappEnabled, false, "/health reports the runtime override");
    assert.equal(h.emailEnabled, true);

    // Email for A1 goes out; no WhatsApp is submitted.
    await waitFor(() => sends(sb).some((s) => s.channel === "email"), "email sent");
    await sleep(3500);

    assert.equal(sends(sb).filter((s) => s.channel === "whatsapp").length, 0);

    let queue = readJson(path.join(sb.data, "review-requests.json")).requests;
    const a1 = queue.find((b) => b.bookingId === "A1");
    const b2 = queue.find((b) => b.bookingId === "B2");

    assert.ok(a1, "A1 stays in the queue while WhatsApp is pending");
    assert.equal(a1.email.status, "sent");
    assert.equal(a1.email.recipient, "a1@example.test");
    assert.equal(a1.email.providerResponse.requestId, "mock-request-id");
    assert.ok(a1.email.submittedAt);
    assert.equal(a1.whatsapp.status, "not_sent", "pending, not skipped or sent");
    assert.equal(b2.whatsapp.status, "not_sent");

    // Turn WhatsApp ON; pending jobs resume.
    writeJson(path.join(sb.data, "runtime-settings.json"), {
      whatsappEnabled: true,
      emailEnabled: true,
    });

    await waitFor(
      () => sends(sb).filter((s) => s.channel === "whatsapp").length === 2,
      "both WhatsApp messages sent",
    );
    await sleep(2500);

    const archive = readJson(path.join(sb.data, "sent-requests.json")).requests;
    const archivedA1 = archive.find((b) => b.bookingId === "A1");

    assert.ok(archivedA1, "completed booking archived");
    assert.match(archivedA1.whatsapp.providerResponse.messageId, /MOCK/);
    assert.equal(archivedA1.whatsapp.recipient, "447700900001");
    assert.ok(archive.find((b) => b.bookingId === "B2"));
    assert.equal(
      readJson(path.join(sb.data, "review-requests.json")).requests.length,
      0,
      "nothing left in the active queue",
    );

    // Exactly one submission per channel per booking.
    const counts = {};
    for (const s of sends(sb)) counts[`${s.channel}:${s.to}`] = (counts[`${s.channel}:${s.to}`] || 0) + 1;
    assert.ok(Object.values(counts).every((n) => n === 1), JSON.stringify(counts));

    // Restart: nothing is resubmitted.
    await stop(bot);
    const before = sends(sb).length;
    bot = startBot(sb);
    await waitFor(async () => (await health()).status === "ok", "restart health");
    await sleep(3000);
    assert.equal(sends(sb).length, before, "no resend after restart");

    // Status heartbeat exists for the dashboard.
    const status = readJson(path.join(sb.data, "runtime-status.json"));
    assert.ok(status.lastQueueRunAt);
  } finally {
    await stop(bot);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("email OFF keeps email pending while WhatsApp continues", async () => {
  const sb = makeSandbox();

  writeJson(path.join(sb.data, "review-requests.json"), {
    requests: [booking("E1", { phone: "447700900003", email: "e1@example.test" })],
  });
  writeJson(path.join(sb.data, "sent-requests.json"), { requests: [] });
  writeJson(path.join(sb.data, "runtime-settings.json"), {
    whatsappEnabled: true,
    emailEnabled: false,
  });

  const bot = startBot(sb);

  try {
    await waitFor(() => sends(sb).some((s) => s.channel === "whatsapp"), "whatsapp sent");
    await sleep(3000);

    assert.equal(sends(sb).filter((s) => s.channel === "email").length, 0);

    const e1 = readJson(path.join(sb.data, "review-requests.json")).requests[0];
    assert.equal(e1.whatsapp.status, "sent");
    assert.equal(e1.email.status, "not_sent");

    writeJson(path.join(sb.data, "runtime-settings.json"), {
      whatsappEnabled: true,
      emailEnabled: true,
    });

    await waitFor(() => sends(sb).some((s) => s.channel === "email"), "email resumes");
    assert.equal(sends(sb).filter((s) => s.channel === "whatsapp").length, 1);
  } finally {
    await stop(bot);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("stuck/already-archived booking is cleared without sending", async () => {
  const sb = makeSandbox();

  const stuck = booking("S1", { phone: "447700900004" });
  delete stuck.email; // matches the real stuck record: no email object
  stuck.whatsapp = { status: "sent", attempts: 1, sentAt: "2026-01-01T00:00:00.000Z" };

  writeJson(path.join(sb.data, "review-requests.json"), { requests: [stuck] });
  writeJson(path.join(sb.data, "sent-requests.json"), {
    requests: [{ ...stuck, archivedAt: "2026-01-01T00:00:01.000Z" }],
  });

  const bot = startBot(sb);

  try {
    await waitFor(
      () => readJson(path.join(sb.data, "review-requests.json")).requests.length === 0,
      "stuck booking removed from active queue",
    );

    assert.equal(sends(sb).length, 0, "nothing was sent");
    assert.equal(readJson(path.join(sb.data, "sent-requests.json")).requests.length, 1);
  } finally {
    await stop(bot);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("webhook auth is intact; zero-byte archive recovers from backup", async () => {
  const sb = makeSandbox();

  writeJson(path.join(sb.data, "review-requests.json"), { requests: [] });
  writeJson(path.join(sb.data, "sent-requests.json"), {
    requests: [{ bookingId: "OLD1", customer: {}, archivedAt: "x" }],
  });
  fs.copyFileSync(
    path.join(sb.data, "sent-requests.json"),
    path.join(sb.data, "sent-requests.json.bak"),
  );
  writeJson(path.join(sb.data, "runtime-settings.json"), {
    whatsappEnabled: false,
    emailEnabled: false,
  });

  const bot = startBot(sb);
  const url = (key) =>
    `http://127.0.0.1:${PORT}/webhooks/icabbi${key === undefined ? "" : `?key=${key}`}`;
  const post = (key, body) =>
    fetch(url(key), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    await waitFor(async () => (await health()).status === "ok", "bot health");

    assert.equal((await post(undefined, { booking_id: "N1" })).status, 401);
    assert.equal((await post("wrong", { booking_id: "N1" })).status, 401);

    const ok = await post(SECRET, {
      event: "DISPATCH_BOOKING_COMPLETE",
      booking_id: "N1",
      booking_customer_phone: "447700900005",
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).duplicate, false);
    assert.equal((await (await post(SECRET, { booking_id: "N1" })).json()).duplicate, true);
    assert.equal((await (await post(SECRET, { booking_id: "OLD1" })).json()).duplicate, true);

    const status = readJson(path.join(sb.data, "runtime-status.json"));
    assert.ok(status.lastWebhookAt && status.lastWebhookRejectedAt);

    // Truncate the archive to zero bytes while the bot is running.
    fs.writeFileSync(path.join(sb.data, "sent-requests.json"), "");

    // A duplicate check reads the archive; it must recover, not 500.
    const dup = await post(SECRET, { booking_id: "OLD1" });
    assert.equal(dup.status, 200);
    assert.equal((await dup.json()).duplicate, true);
    assert.ok(
      fs.readdirSync(sb.data).some((f) => f.includes(".corrupt-")),
      "corrupt file kept aside, not deleted",
    );
    assert.equal(sends(sb).length, 0, "toggles off: nothing submitted");
  } finally {
    await stop(bot);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("openwa-gateway provider sends through the gateway API and stores the message id", async () => {
  const sb = makeSandbox();

  writeJson(path.join(sb.data, "review-requests.json"), {
    requests: [booking("G1", { phone: "447700900009" })],
  });
  writeJson(path.join(sb.data, "sent-requests.json"), { requests: [] });

  const bot = startBot(sb, {
    WHATSAPP_PROVIDER: "openwa-gateway",
    OPENWA_GATEWAY_URL: "http://127.0.0.1:2785",
    OPENWA_GATEWAY_API_KEY: "test-gateway-key",
    OPENWA_GATEWAY_SESSION: "western-cars",
  });

  try {
    await waitFor(() => sends(sb).some((s) => s.via === "gateway"), "gateway send");

    const sent = sends(sb).find((s) => s.via === "gateway");
    assert.equal(sent.to, "447700900009@c.us");
    assert.equal(sent.key, "present");

    await waitFor(
      () => readJson(path.join(sb.data, "sent-requests.json")).requests.length === 1,
      "archived",
    );

    const done = readJson(path.join(sb.data, "sent-requests.json")).requests[0];
    assert.equal(done.whatsapp.status, "sent");
    assert.equal(done.whatsapp.providerResponse.messageId, "GWMOCK123");
    assert.equal(done.whatsapp.providerResponse.provider, "openwa-gateway");
  } finally {
    await stop(bot);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("safety: age cutoff, name + variants, daily cap, pacing defer, STOP opt-out", async () => {
  const sb = makeSandbox();
  const old = booking("OLD", { phone: "447700900101" });
  old.receivedAt = new Date(Date.now() - 5 * 3600_000).toISOString();
  const fresh = (id, phone, name) => ({ ...booking(id, { phone }), customer: { name, phone, email: null } });

  writeJson(path.join(sb.data, "review-requests.json"), {
    requests: [old, fresh("F1", "447700900102", "marian smith"), fresh("F2", "447700900103", "A1!"), fresh("F3", "447700900104", "Bob")],
  });
  writeJson(path.join(sb.data, "sent-requests.json"), { requests: [] });
  writeJson(path.join(sb.data, "runtime-settings.json"), { whatsappEnabled: true, emailEnabled: false });
  fs.writeFileSync(path.join(sb.dir, ".env"), fs.readFileSync(path.join(sb.dir, ".env"), "utf8") + "\nWA_DAILY_CAP=2\nWA_MAX_AGE_HOURS=2\nWHATSAPP_REPLY_SECRET=reply-secret-123\n");

  const bot = startBot(sb);

  try {
    await waitFor(() => sends(sb).filter((s) => s.channel === "whatsapp").length === 2, "two sends then cap");
    await sleep(3500);

    const msgs = sends(sb).filter((s) => s.channel === "whatsapp");
    assert.equal(msgs.length, 2, "daily cap of 2 respected");
    assert.ok(!msgs.some((m) => m.to.startsWith("447700900101")), "old booking not messaged");
    assert.ok(msgs.every((m) => /Reply STOP/.test(m.text)));
    assert.ok(msgs.some((m) => /Marian/.test(m.text)), "first name personalised");

    const archive = readJson(path.join(sb.data, "sent-requests.json")).requests;
    const oldRec = archive.find((b) => b.bookingId === "OLD");
    assert.equal(oldRec.whatsapp.status, "skipped");
    assert.match(oldRec.whatsapp.reason, /Older than 2/);

    // The third fresh booking waits (cap), neither sent nor skipped.
    const queue = readJson(path.join(sb.data, "review-requests.json")).requests;
    assert.equal(queue.length, 1);
    assert.equal(queue[0].whatsapp.status, "not_sent");

    // STOP opt-out: wrong key refused; right key records the number.
    const url = (k) => `http://127.0.0.1:${PORT}/webhooks/whatsapp-reply?key=${k}`;
    const post = (k, body) => fetch(url(k), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("bad", { data: { from: "447700900104@c.us", body: "STOP" } })).status, 401);
    assert.equal((await post("reply-secret-123", { data: { from: "447700900104@c.us", body: "stop." } })).status, 200);
    await waitFor(() => fs.existsSync(path.join(sb.data, "whatsapp-optout.json")), "opt-out file");
    await waitFor(() => {
      const a = readJson(path.join(sb.data, "sent-requests.json")).requests.find((b) => b.bookingId === "F3");
      return a && a.whatsapp.status === "skipped" && /opted out/.test(a.whatsapp.reason);
    }, "opted-out booking skipped");
    assert.equal(sends(sb).filter((s) => s.to.startsWith("447700900104")).length, 0, "opted-out number never messaged");
  } finally {
    await stop(bot);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("safety: gateway pacing (429) defers without counting a failure", async () => {
  const sb = makeSandbox();
  writeJson(path.join(sb.data, "review-requests.json"), { requests: [booking("P1", { phone: "447700900201" })] });
  writeJson(path.join(sb.data, "sent-requests.json"), { requests: [] });

  const bot = startBot(sb, {
    WHATSAPP_PROVIDER: "openwa-gateway",
    OPENWA_GATEWAY_API_KEY: "k",
    OPENWA_GATEWAY_SESSION: "western-cars",
    MOCK_PACE: "1",
  });

  try {
    await waitFor(() => sends(sb).some((s) => s.channel === "paced"), "paced call");
    await sleep(3500);

    assert.equal(sends(sb).filter((s) => s.channel === "paced").length, 1, "not retried before the wait ends");
    const p1 = readJson(path.join(sb.data, "review-requests.json")).requests[0];
    assert.equal(p1.whatsapp.status, "not_sent");
    assert.equal(p1.whatsapp.attempts, 0, "no failed attempt counted");
    assert.ok(p1.whatsapp.nextRetryAt);
  } finally {
    await stop(bot);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("timing: a webhook booking is held 2-5 minute window (shortened here) then sent", async () => {
  const sb = makeSandbox();
  writeJson(path.join(sb.data, "review-requests.json"), { requests: [] });
  writeJson(path.join(sb.data, "sent-requests.json"), { requests: [] });

  const bot = startBot(sb, { SEND_DELAY_MIN_MS: "4000", SEND_DELAY_MAX_MS: "4000" });

  try {
    await waitFor(async () => (await health()).status === "ok", "bot health");

    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/icabbi?key=${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "DISPATCH_BOOKING_COMPLETE", booking_id: "T1", booking_customer_phone: "447700900301", booking_customer_name: "Tess" }),
    });
    assert.equal(res.status, 200);

    const queued = readJson(path.join(sb.data, "review-requests.json")).requests[0];
    const wait = Date.parse(queued.sendAfter) - Date.parse(queued.receivedAt);
    assert.ok(wait >= 3900 && wait <= 4100, `sendAfter window applied (${wait} ms)`);

    await sleep(2000);
    assert.equal(sends(sb).length, 0, "not sent before its time");

    await waitFor(() => sends(sb).some((s) => s.to.startsWith("447700900301")), "sent after the delay", 12000);
  } finally {
    await stop(bot);
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});
