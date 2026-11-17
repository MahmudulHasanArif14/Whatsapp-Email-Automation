"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { redact, registerSecret, parseEnv } = require("../lib/util");
const { parseConfig } = require("../lib/tunnel");
const { qrMatrix } = require("../lib/openwa");
const data = require("../lib/data");
const config = require("../lib/config");

test("redaction hides secrets, QR links, keys and numbers", () => {
  registerSecret("super-secret-value-123");
  const out = redact(
    "key=" + "a".repeat(64) + " Bearer abcdefghijklmnop https://wa.me/settings/linked_devices#2@abcdef " +
      "super-secret-value-123 447700900001@c.us X-API-Key: hunter2hunter2",
  );
  assert.doesNotMatch(out, /a{20}|abcdefghijklmnop|2@abcdef|super-secret|447700900001|hunter2/);
});

test("env parser reads values without evaluating", () => {
  assert.deepEqual(parseEnv('A=1\n# c\nB="x y"\nC=z # note'), { A: "1", B: "x y", C: "z" });
});

test("cloudflared config parser finds ingress rules", () => {
  const c = parseConfig(
    "tunnel: abc\ncredentials-file: C:/x/abc.json\n\ningress:\n  - hostname: h.example\n    service: http://127.0.0.1:3000\n\n  - service: http_status:404\n",
  );
  assert.equal(c.scalars.tunnel, "abc");
  assert.equal(c.ingress.length, 2);
  assert.equal(c.ingress[0].service, "http://127.0.0.1:3000");
  assert.equal(c.ingress[1].hostname, undefined);
});

test("QR matrix is square with finder patterns", () => {
  const m = qrMatrix("https://wa.me/settings/linked_devices#" + "x".repeat(200));
  assert.equal(m.rows.length, m.size);
  assert.ok(m.rows.every((r) => r.length === m.size));
  assert.equal(m.rows[0].slice(0, 7), "1111111"); // top-left finder
});

test("fixed hostname and tunnel are the required values", () => {
  assert.equal(config.FIXED_HOSTNAME, "dev.a1airportcarsworthing.co.uk");
  assert.equal(config.TUNNEL_NAME, "a1airport-dev");
});

test("stats, filters and toggles use real records only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-data-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, ".env"), "ENABLE_WHATSAPP=true\nENABLE_EMAIL=true\n");
  const now = new Date().toISOString();
  const b = (id, wa, em) => ({ bookingId: id, receivedAt: now, customer: { name: "N" + id, phone: "07700900" + id, email: `${id}@x.test` }, whatsapp: wa, email: em });
  fs.writeFileSync(path.join(dir, "data", "sent-requests.json"), JSON.stringify({ requests: [b("111", { status: "sent", sentAt: now, recipient: "447700900111" }, { status: "sent", sentAt: now })] }));
  fs.writeFileSync(path.join(dir, "data", "review-requests.json"), JSON.stringify({ requests: [b("222", { status: "not_sent" }, { status: "failed", lastError: "boom" }), b("111", { status: "sent" }, { status: "sent" })] }));

  const { rows } = data.allRows(dir);
  assert.equal(rows.filter((r) => r.bookingId === "111").length, 2, "duplicate booking counted once per channel");
  const wa = data.statsFor(rows, "whatsapp");
  assert.equal(wa.totalSubmitted, 1);
  assert.equal(wa.submittedToday, 1);
  assert.equal(wa.pending, 1);
  assert.equal(data.statsFor(rows, "email").failed, 1);
  assert.equal(data.filterRows(rows, { q: "7700900222" }).length, 1);
  assert.equal(data.filterRows(rows, { status: "failed" })[0].error, "boom");

  const s = await data.setSending(dir, { whatsapp: false });
  assert.equal(s.whatsapp.enabled, false);
  assert.equal(s.email.enabled, true);
  await assert.rejects(() => data.setSending(dir, { email: "yes" }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("API security: host, token, origin and content-type checks", async () => {
  const port = 3090 + Math.floor(Math.random() * 9);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, DASHBOARD_PORT: String(port) }, stdio: "ignore", windowsHide: true });
  const base = `http://127.0.0.1:${port}`;

  try {
    let html;
    for (let i = 0; i < 40 && !html; i++) {
      try { html = await (await fetch(base + "/")).text(); } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    const token = /dashboard-token" content="([a-f0-9]+)"/.exec(html)[1];
    const J = { "content-type": "application/json" };

    assert.equal((await fetch(base + "/api/state")).status, 401);
    const badHost = await new Promise((res, rej) => require("node:http").get({ host: "127.0.0.1", port, path: "/", headers: { host: "evil.example" } }, (r) => { r.resume(); res(r.statusCode); }).on("error", rej));
    assert.equal(badHost, 421);
    assert.equal((await fetch(base + "/api/webhook-url", { method: "POST", headers: { ...J, "x-dashboard-token": token, origin: "http://evil.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(base + "/api/webhook-url", { method: "POST", headers: { "x-dashboard-token": token }, body: "{}" })).status, 415);
    assert.equal((await fetch(base + "/api/state", { headers: { "x-dashboard-token": token } })).status, 200);
    assert.equal((await fetch(base + "/../lib/config.js")).status, 404);
  } finally {
    child.kill();
  }
});
