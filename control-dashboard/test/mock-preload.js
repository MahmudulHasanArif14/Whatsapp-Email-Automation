"use strict";

// Test-only preload for the Review Bot: replaces every outbound provider call
// (OpenWA and Microsoft Graph/MSAL) with a recorder. Nothing leaves the machine.
// Loaded with:  node -r ./mock-preload.js server.js   (MOCK_LOG = jsonl file)

const fs = require("node:fs");

const logFile = process.env.MOCK_LOG;

function record(entry) {
  if (logFile) {
    fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  }
}

const realFetch = globalThis.fetch;

globalThis.fetch = async function mockFetch(url, options = {}) {
  const target = String(url);

  if (target.includes("/api/messages/sendText")) {
    const body = JSON.parse(options.body || "{}");
    record({ channel: "whatsapp", to: body.to, text: body.content });

    return new Response(
      JSON.stringify({ id: `true_${body.to}_MOCK${Math.random().toString(16).slice(2, 8)}` }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  // OpenWA gateway (rmyndharis/OpenWA) shapes.
  if (target.endsWith("/api/sessions") && (options.method || "GET") === "GET") {
    return new Response(JSON.stringify([{ id: "sess-1", name: "western-cars", status: "ready" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (target.includes("/api/sessions/sess-1/messages/send-text")) {
    const body = JSON.parse(options.body || "{}");
    if (process.env.MOCK_PACE === "1") {
      record({ channel: "paced", to: body.chatId });
      return new Response(JSON.stringify({ code: "SEND_PACING_LIMITED", retryAfterSeconds: 3600 }), { status: 429, headers: { "content-type": "application/json" } });
    }

    record({ channel: "whatsapp", to: body.chatId, text: body.text, via: "gateway", key: options.headers?.["X-API-Key"] ? "present" : "missing" });

    return new Response(JSON.stringify({ messageId: "GWMOCK123", timestamp: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (target.includes("graph.microsoft.com") && target.includes("sendMail")) {
    const body = JSON.parse(options.body || "{}");
    const to = body?.message?.toRecipients?.[0]?.emailAddress?.address;
    record({ channel: "email", to });

    return new Response(null, {
      status: 202,
      headers: { "request-id": "mock-request-id" },
    });
  }

  if (target.startsWith("http://127.0.0.1") || target.startsWith("http://localhost")) {
    return realFetch(url, options);
  }

  throw new Error(`Blocked outbound request in test: ${new URL(target).host}`);
};

try {
  const msal = require("@azure/msal-node");

  msal.ConfidentialClientApplication.prototype.acquireTokenByClientCredential =
    async function () {
      return { accessToken: "mock-token" };
    };
} catch {
  // msal not resolvable: tests that need email will fail loudly.
}
