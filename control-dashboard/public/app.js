"use strict";

(() => {
  const TOKEN = document.querySelector('meta[name="dashboard-token"]').content;

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);

    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }

    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }

    return el;
  }

  function fill(root, ...kids) { root.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); }

  const $ = (sel, root = document) => root.querySelector(sel);

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(`/api/${path}`, {
      method,
      headers: { "x-dashboard-token": TOKEN, ...(body !== undefined || method !== "GET" ? { "content-type": "application/json" } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });

    let json = null;

    try {
      json = await res.json();
    } catch {
      json = null;
    }

    if (!res.ok) {
      const err = new Error((json && json.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }

    return json;
  }

  function toast(message, kind = "info", ms = 6000) {
    const t = h("div", { class: `toast ${kind}`, role: "status" }, message);
    $("#toasts").append(t);
    setTimeout(() => t.remove(), ms);
  }

  // Run an async action from a button: disables it, reports errors.
  async function act(btn, fn, okMessage) {
    if (btn) btn.disabled = true;

    try {
      const result = await fn();
      if (okMessage) toast(typeof okMessage === "function" ? okMessage(result) : okMessage, "ok", 3500);
      return result;
    } catch (error) {
      toast(error.message, "bad", 9000);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Two-step confirmation without browser dialogs.
  function armed(btn, label, fn) {
    let timer = null;
    const original = btn.textContent;

    btn.addEventListener("click", () => {
      if (!btn.classList.contains("armed")) {
        btn.classList.add("armed");
        btn.textContent = label;
        timer = setTimeout(() => {
          btn.classList.remove("armed");
          btn.textContent = original;
        }, 4000);
        return;
      }

      clearTimeout(timer);
      btn.classList.remove("armed");
      btn.textContent = original;
      fn(btn);
    });

    return btn;
  }

  const dtf = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium" });
  const df = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
  const tf = new Intl.DateTimeFormat("en-GB", { timeStyle: "medium" });

  const fmtDateTime = (iso) => (iso ? dtf.format(new Date(iso)) : "—");

  function ago(iso) {
    if (!iso) return "never";
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }

  const when = (iso) => (iso ? h("span", { title: fmtDateTime(iso) }, ago(iso)) : h("span", { class: "muted" }, "never"));

  function uptime(iso) {
    if (!iso) return "—";
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
  }

  const badge = (text, kind = "", pulse = false) => h("span", { class: `badge ${kind}${pulse ? " pulse" : ""}` }, text);

  function serviceBadge(info) {
    if (info.busy) return badge({ starting: "Starting…", stopping: "Stopping…", restarting: "Restarting…" }[info.busy] || "Working…", "warn", true);
    const map = {
      running: ["Running", "ok"],
      starting: ["Starting", "warn", true],
      stopping: ["Stopping", "warn", true],
      stopped: ["Stopped", ""],
      error: ["Error", "bad"],
    };
    const [t, k, p] = map[info.state] || [info.state, ""];
    return badge(t, k, p);
  }

  function waBadge(wa) {
    const map = {
      connected: "ok",
      waiting_qr: "info",
      qr_expired: "warn",
      starting: "warn",
      disconnected: "bad",
      error: "bad",
      not_started: "",
    };
    return badge(wa.label, map[wa.state] || "", wa.state === "waiting_qr" || wa.state === "starting");
  }

  function statusBadge(status, label) {
    const map = { submitted: "ok", pending: "warn", failed: "bad", skipped: "", submitting: "info", unknown: "bad" };
    return badge(label, map[status] || "");
  }

  function qrSvg(matrix) {
    const quiet = 4;
    const n = matrix.size + quiet * 2;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "WhatsApp login QR code");

    const bg = document.createElementNS(NS, "rect");
    bg.setAttribute("width", n);
    bg.setAttribute("height", n);
    bg.setAttribute("fill", "#fff");
    svg.append(bg);

    let d = "";

    matrix.rows.forEach((row, r) => {
      let c = 0;
      while (c < row.length) {
        if (row[c] === "1") {
          let end = c;
          while (end < row.length && row[end] === "1") end++;
          d += `M${c + quiet} ${r + quiet}h${end - c}v1h-${end - c}z`;
          c = end;
        } else c++;
      }
    });

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "#000");
    svg.append(path);

    return svg;
  }

  // ------------------------------------------------------------------
  // global state (pushed by the server over SSE)
  // ------------------------------------------------------------------

  let S = null;
  let page = null;
  const PAGES = [];

  function jobRunning() {
    return Boolean(S && S.job && S.job.running);
  }

  function serviceControls(id, compact = false) {
    const info = S.services[id];
    const locked = Boolean(info.busy) || jobRunning();
    const cls = compact ? "btn small" : "btn";
    const label = { openwa: "OpenWA", bot: "Review Bot", tunnel: "tunnel" }[id];

    const start = h("button", { class: `${cls} primary`, disabled: locked || info.state === "running" || info.state === "starting" }, "Start");
    const stop = armed(h("button", { class: `${cls} danger`, disabled: locked || info.state === "stopped" }, "Stop"), "Confirm stop?", (b) =>
      act(b, () => api(`services/${id}/stop`, { method: "POST" }), `${label} stopped`));
    const restart = armed(h("button", { class: cls, disabled: locked || info.state === "stopped" }, "Restart"), "Confirm restart?", (b) =>
      act(b, () => api(`services/${id}/restart`, { method: "POST" }), `${label} restarted`));

    start.addEventListener("click", () => act(start, () => api(`services/${id}/start`, { method: "POST" }), (r) => r.message));

    return h("div", { class: "row" }, start, stop, restart);
  }

  function sendingToggle(channel) {
    const cur = S.sending && S.sending[channel];
    const name = channel === "whatsapp" ? "WhatsApp" : "Email";

    if (!cur) return h("span", { class: "muted" }, "Review Bot folder not set");

    const effective = S.sendingEffective && S.sendingEffective[channel];
    const input = h("input", { type: "checkbox", role: "switch", "aria-label": `${name} sending`, checked: cur.enabled });

    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        await api("sending", { method: "POST", body: { [channel]: input.checked } });
        toast(`${name} sending turned ${input.checked ? "ON" : "OFF"}${input.checked ? "" : " — pending jobs stay pending"}`, "ok", 4000);
      } catch (e) {
        input.checked = !input.checked;
        toast(e.message, "bad");
      } finally {
        input.disabled = false;
      }
    });

    return h("div", { class: "stack", style: "gap:4px" },
      h("label", { class: "switch" }, input, h("span", { class: "track" }), h("span", { class: "text" }, cur.enabled ? "ON" : "OFF"), h("span", {}, `${name} sending`)),
      h("span", { class: "muted", style: "font-size:12px" },
        `Source: ${cur.source}${cur.updatedAt ? ` · changed ${fmtDateTime(cur.updatedAt)}` : ""}`,
        effective !== undefined && effective !== null && effective !== cur.enabled ? h("span", { class: "badge warn", style: "margin-left:8px" }, "bot has not picked it up yet") : null,
        effective !== undefined && effective !== null && effective === cur.enabled ? h("span", { style: "margin-left:8px" }, "· confirmed by running bot") : null,
      ),
    );
  }

  function stat(num, label, kind = "") {
    return h("div", { class: `stat ${kind}` }, h("span", { class: "num" }, num ?? "—"), h("span", { class: "lbl" }, label));
  }

  // Daily WhatsApp cap used by the currently linked number (resets when the number changes).
  function capStat(c) {
    if (c.unlimited) return stat("No cap", "Cap used");
    const full = c.used !== null && c.used >= c.cap;
    return stat(c.used === null ? `— / ${c.cap}` : `${c.used} / ${c.cap}`, c.warmup ? "Cap used (warm-up)" : "Cap used", full ? "bad" : c.used !== null && c.used >= c.cap * 0.8 ? "warn" : "");
  }

  function statsCard(title, st, channelNote) {
    if (!st) return h("div", { class: "card" }, h("h3", {}, title), h("p", { class: "muted" }, "Review Bot folder not set."));

    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", {}, title), channelNote),
      h("div", { class: "grid cols-6" },
        stat(st.totalSubmitted, "Total submitted"),
        stat(st.submittedToday, "Today"),
        st.capUsage ? capStat(st.capUsage) : null,
        stat(st.submittedThisMonth, "This month"),
        stat(st.pending, "Pending", st.pending ? "warn" : ""),
        stat(st.failed, "Failed", st.failed ? "bad" : ""),
        h("div", { class: "stat" }, h("span", { class: "num", style: "font-size:15px;padding-top:7px" }, st.lastSubmissionAt ? when(st.lastSubmissionAt) : "—"), h("span", { class: "lbl" }, "Last submission")),
      ),
      st.needsReview ? h("p", { class: "alert warn", style: "margin:12px 0 0" }, `${st.needsReview} submission(s) were interrupted and need review (outcome unknown, not retried).`) : null,
      st.submittedWithoutTimestamp ? h("p", { class: "muted", style: "margin:10px 0 0;font-size:12px" }, `${st.submittedWithoutTimestamp} older record(s) have no timestamp and are excluded from the date counts.`) : null,
    );
  }

  // ------------------------------------------------------------------
  // QR + WhatsApp connection card
  // ------------------------------------------------------------------

  function whatsappCard(large = false) {
    const wa = S.whatsapp;
    const kids = [];

    kids.push(h("div", { class: "card-head" }, h("h3", {}, "WhatsApp connection"), waBadge(wa)));

    if (wa.state === "connected") {
      kids.push(h("div", { class: "qr-ok" },
        h("div", { class: "tick", "aria-hidden": "true" }, "✓"),
        h("div", {}, h("strong", {}, "Connected"), h("div", { class: "muted" }, wa.account ? `Account ${wa.account}` : "Linked account number not available"), h("div", { class: "muted" }, wa.detail))));
    } else if (wa.qr) {
      kids.push(h("div", { class: "qr-wrap" },
        h("div", { class: `qr-box ${large ? "qr-large" : ""}` }, wa.qr.image ? h("img", { src: wa.qr.image, alt: "WhatsApp login QR code", width: 260, height: 260, style: "display:block;width:260px;height:260px;image-rendering:pixelated" }) : qrSvg(wa.qr)),
        h("div", { class: "stack", style: "gap:8px;max-width:380px" },
          h("strong", {}, "Scan with WhatsApp"),
          h("ol", { style: "margin:0;padding-left:18px" }, h("li", {}, "Open WhatsApp on the phone"), h("li", {}, "Settings → Linked devices → Link a device"), h("li", {}, "Point the camera at this code")),
          h("span", { class: "muted", style: "font-size:12.5px" }, `This code refreshes by itself. Updated ${ago(wa.qr.updatedAt)}.`))));
    } else if (wa.state === "qr_expired") {
      kids.push(h("p", { class: "alert warn" }, wa.detail));
      kids.push(h("button", { class: "btn primary", onclick: (e) => act(e.currentTarget, () => api("services/openwa/restart", { method: "POST" }), "OpenWA restarted") }, "Restart OpenWA for a new QR"));
    } else {
      kids.push(h("p", { class: wa.state === "error" || wa.state === "disconnected" ? "alert bad" : "muted" }, wa.detail || (wa.state === "not_started" ? "OpenWA is not running. Press Start All or start OpenWA." : "")));
    }

    kids.push(h("dl", { class: "kv", style: "margin-top:14px" },
      h("dt", {}, "Last connected"), h("dd", {}, wa.lastConnectedAt ? fmtDateTime(wa.lastConnectedAt) : "—"),
      h("dt", {}, "Last disconnected"), h("dd", {}, wa.lastDisconnectedAt ? fmtDateTime(wa.lastDisconnectedAt) : "—")));

    return h("div", { class: "card" }, kids);
  }

  // ------------------------------------------------------------------
  // iCabbi webhook card
  // ------------------------------------------------------------------

  function webhookCard() {
    const r = S.readiness;
    const urlBox = h("input", { type: "text", readonly: true, class: "mono", style: "display:none;width:100%", "aria-label": "Webhook URL" });
    let hideTimer = null;

    const copy = h("button", { class: "btn primary", disabled: !r.secretConfigured }, "Copy iCabbi Webhook URL");
    copy.addEventListener("click", () => act(copy, async () => {
      const { url } = await api("webhook-url", { method: "POST", body: {} });
      try {
        await navigator.clipboard.writeText(url);
        toast("Webhook URL copied to the clipboard.", "ok", 4000);
      } catch {
        urlBox.value = url;
        urlBox.style.display = "block";
        urlBox.select();
        toast("Clipboard unavailable — the URL is shown below; copy it manually.", "info", 8000);
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { urlBox.value = ""; urlBox.style.display = "none"; }, 20000);
      }
    }));

    const reveal = h("button", { class: "btn" }, "Show URL (15 s)");
    reveal.addEventListener("click", () => act(reveal, async () => {
      const { url } = await api("webhook-url", { method: "POST", body: {} });
      urlBox.value = url;
      urlBox.style.display = "block";
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { urlBox.value = ""; urlBox.style.display = "none"; }, 15000);
    }));

    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", {}, "iCabbi webhook"), badge(r.ready ? "Ready" : "Not ready", r.ready ? "ok" : "warn")),
      h("dl", { class: "kv" },
        h("dt", {}, "Hostname (fixed)"), h("dd", { class: "mono" }, r.hostname),
        h("dt", {}, "Endpoint"), h("dd", { class: "mono" }, r.endpoint),
        h("dt", {}, "Format"), h("dd", { class: "mono" }, `https://${r.hostname}${r.endpoint}?key=•••••`)),
      !r.ready ? h("div", { class: "alert warn", style: "margin-top:12px" }, h("strong", {}, "The webhook URL is not ready yet. "), "Paste it into iCabbi only when every check below is green: ", r.items.filter((i) => i.status !== "ok").map((i) => i.label).join("; "), ".") : null,
      h("div", { class: "row", style: "margin:12px 0" }, copy, reveal, h("button", { class: "btn", onclick: (e) => act(e.currentTarget, () => api("readiness", { method: "POST", body: {} }), "Checks refreshed") }, "Re-check")),
      urlBox,
      h("p", { class: "muted", style: "font-size:12px;margin:8px 0 0" }, "The secret is read from the Review Bot's .webhook-secret on demand and is never logged. You paste the URL into iCabbi yourself; this dashboard never contacts iCabbi."),
    );
  }

  function readinessList() {
    const r = S.readiness;
    const icon = { ok: "✓", warn: "!", fail: "✕", unknown: "?" };
    const kind = { ok: "ok", warn: "warn", fail: "bad", unknown: "" };

    return h("ul", { class: "check-list" }, r.items.map((i) => h("li", {},
      badge(i.status === "ok" ? "OK" : i.status === "warn" ? "Check" : i.status === "fail" ? "Fail" : "Unknown", kind[i.status]),
      h("div", {}, h("div", { class: "what" }, i.label), h("div", { class: "why" }, i.detail, i.status !== "ok" && i.fix ? ` — ${i.fix}` : "")))));
  }

  // ------------------------------------------------------------------
  // message / queue tables
  // ------------------------------------------------------------------

  function messageTable(rows, { showChannel = false } = {}) {
    const head = ["Booking ID", showChannel ? "Channel" : null, "Customer", "Recipient", "Status", "Date", "Time", "Provider response"].filter(Boolean);
    const body = rows.length
      ? rows.map((r) => {
          const d = r.submittedAt ? new Date(r.submittedAt) : null;
          return h("tr", {},
            h("td", { class: "mono" }, r.bookingId),
            showChannel ? h("td", {}, r.channel === "whatsapp" ? "WhatsApp" : "Email") : null,
            h("td", {}, r.customerName || h("span", { class: "muted" }, "—")),
            h("td", { class: "mono nowrap" }, r.recipient || "—"),
            h("td", {}, statusBadge(r.status, r.statusLabel), r.holdReason ? h("div", { class: "muted", style: "font-size:12px" }, r.holdReason) : null, r.error ? h("div", { class: "muted", style: "font-size:12px;max-width:260px" }, r.error) : null),
            h("td", { class: "nowrap" }, d ? df.format(d) : h("span", { class: "muted" }, "—")),
            h("td", { class: "nowrap" }, d ? tf.format(d) : h("span", { class: "muted" }, "—")),
            h("td", { class: "mono", style: "max-width:280px;overflow-wrap:anywhere" }, r.providerResponse || h("span", { class: "muted" }, "—")));
        })
      : [h("tr", {}, h("td", { class: "empty", colspan: head.length }, "No records match."))];

    return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((t) => h("th", {}, t)))), h("tbody", {}, body)));
  }

  function historyView({ channel }) {
    const state = { q: "", status: "all", channel: channel || "all", from: "", to: "" };
    const holder = h("div", {});
    const info = h("div", { class: "muted", style: "margin-bottom:8px" });
    let timer = null;

    const search = h("input", { type: "search", placeholder: "Search booking, customer, phone or email", "aria-label": "Search", oninput: (e) => { state.q = e.target.value; debounce(); } });
    const status = h("select", { "aria-label": "Status", onchange: (e) => { state.status = e.target.value; load(); } },
      [["all", "All statuses"], ["pending", "Pending"], ["submitted", "Submitted"], ["failed", "Failed"], ["skipped", "Skipped"], ["unknown", "Unknown – review"]].map(([v, t]) => h("option", { value: v }, t)));
    const chan = channel ? null : h("select", { "aria-label": "Channel", onchange: (e) => { state.channel = e.target.value; load(); } }, [["all", "All channels"], ["whatsapp", "WhatsApp"], ["email", "Email"]].map(([v, t]) => h("option", { value: v }, t)));
    const from = h("input", { type: "date", "aria-label": "From date", onchange: (e) => { state.from = e.target.value; load(); } });
    const to = h("input", { type: "date", "aria-label": "To date", onchange: (e) => { state.to = e.target.value; load(); } });

    function debounce() { clearTimeout(timer); timer = setTimeout(load, 250); }

    async function load() {
      try {
        const params = new URLSearchParams(Object.entries(state).filter(([, v]) => v && v !== "all"));
        const res = await api(`messages?${params}`);
        info.textContent = `${res.total} record(s)${res.total > res.rows.length ? ` — showing the latest ${res.rows.length}` : ""}. Date filters use the submission date (or the received date for unsent items).`;
        holder.replaceChildren(res.errors.length ? h("div", { class: "alert bad" }, res.errors.join(" · ")) : "", messageTable(res.rows, { showChannel: !channel }));
      } catch (e) {
        holder.replaceChildren(h("div", { class: "alert bad" }, e.message));
      }
    }

    const root = h("div", {}, h("div", { class: "filters" }, search, chan, status, from, to), info, holder);
    root.refresh = load;
    load();

    return root;
  }

  // ------------------------------------------------------------------
  // pages
  // ------------------------------------------------------------------

  function addPage(def) { PAGES.push(def); }

  function jobPanel() {
    const job = S.job;
    if (!job) return null;

    const icon = { pending: "·", running: "…", ok: "✓", warn: "!", error: "✕" };

    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", {}, job.kind === "start" ? "Start All" : "Stop All"), job.running ? badge("Working", "warn", true) : badge(`Finished ${ago(job.finishedAt)}`, job.steps.some((s) => s.status === "error") ? "bad" : "ok")),
      h("ul", { class: "steps" }, job.steps.map((s) => h("li", { class: s.status }, h("span", { class: "mark" }, icon[s.status]), h("div", {}, s.label, s.detail ? h("div", { class: "detail" }, s.detail) : null)))));
  }

  function serviceCard(id, title, desc) {
    const info = S.services[id];

    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", {}, title), serviceBadge(info)),
      h("p", { class: "muted", style: "margin:0 0 10px" }, desc),
      info.error ? h("div", { class: "alert bad" }, info.error) : null,
      h("dl", { class: "kv", style: "margin-bottom:12px" },
        h("dt", {}, "Process ID"), h("dd", { class: "mono" }, info.pid || "—"),
        h("dt", {}, "Uptime"), h("dd", {}, info.state === "running" || info.state === "starting" ? uptime(info.uptimeStartedAt) : "—"),
        id === "tunnel" && info.connections !== undefined ? [h("dt", {}, "Connections"), h("dd", {}, String(info.connections))] : null,
        h("dt", {}, "Control"), h("dd", {}, info.pid ? (info.managed ? "Started by this dashboard" : "Started elsewhere (adopted)") : "—")),
      info.detail ? h("p", { class: "muted", style: "font-size:12.5px;margin:0 0 10px" }, info.detail) : null,
      serviceControls(id, true));
  }

  addPage({
    id: "overview", title: "Overview", icon: "▦",
    render(root) {
      const sendCard = h("div", { class: "card" },
        h("h3", {}, "Sending controls"),
        h("div", { class: "grid cols-2" }, sendingToggle("whatsapp"), sendingToggle("email")),
        h("p", { class: "muted", style: "font-size:12.5px;margin:12px 0 0" }, "OFF keeps jobs pending (never marked sent or skipped). Turning a channel ON again resumes them. Sent messages are never resent."));

      const act2 = S.activity;

      fill(root, 
        S.storageErrors && S.storageErrors.length ? h("div", { class: "alert bad" }, h("strong", {}, "Data file problem: "), S.storageErrors.join(" · ")) : null,
        h("div", { class: "grid cols-3" },
          serviceCard("openwa", "OpenWA", "WhatsApp gateway"),
          serviceCard("bot", "Review Bot", "Webhook receiver and queue"),
          serviceCard("tunnel", "Cloudflare Tunnel", `${S.hostname} → bot`)),
        h("div", { class: "grid cols-2", style: "margin-top:16px;align-items:start" },
          whatsappCard(), h("div", { class: "stack" }, sendCard, jobPanel(), webhookCard())),
        h("div", { class: "grid cols-2", style: "margin-top:16px" },
          statsCard("WhatsApp", S.stats && S.stats.whatsapp),
          statsCard("Email", S.stats && S.stats.email)),
        h("div", { class: "card", style: "margin-top:16px" },
          h("h3", {}, "Review Bot activity"),
          h("dl", { class: "kv" },
            h("dt", {}, "Latest iCabbi webhook"), h("dd", {}, act2 ? [when(act2.lastWebhookAt), act2.lastWebhookSource ? h("span", { class: "muted" }, ` (${act2.lastWebhookSource})`) : null] : "—"),
            h("dt", {}, "Last queue run"), h("dd", {}, act2 ? when(act2.lastQueueRunAt) : "—"),
            h("dt", {}, "Latest activity"), h("dd", {}, act2 && act2.lastActivity ? [act2.lastActivity, h("span", { class: "muted" }, " · "), when(act2.lastActivityAt)] : "—"),
            h("dt", {}, "Queue"), h("dd", {}, S.queueTotals ? `${S.queueTotals.queued} queued · ${S.queueTotals.pendingBookings} pending · ${S.queueTotals.archived} archived` : "—"))));
    },
  });

  addPage({
    id: "services", title: "Services", icon: "⚙",
    mount(root) {
      this.logBox = {};
      this.timer = setInterval(() => this.refreshLogs(), 2000);
    },
    unmount() { clearInterval(this.timer); },
    async refreshLogs() {
      for (const id of ["openwa", "bot", "tunnel"]) {
        const box = this.logBox[id];
        if (!box) continue;
        try {
          const res = await api(`logs?service=${id}`);
          const lines = res.entries.slice(-40);
          box.replaceChildren(...(lines.length ? lines.map((e) => h("span", { class: `l ${e.level}` }, `${tf.format(new Date(e.time))} ${e.message}`)) : [h("span", { class: "muted" }, S.services[id].managed || !S.services[id].pid ? "No output captured yet." : "Started outside the dashboard — output is not captured.")]));
          box.scrollTop = box.scrollHeight;
        } catch { /* ignore */ }
      }
    },
    render(root) {
      const old = this.logBox;
      this.logBox = {};

      const block = (id, title) => {
        const info = S.services[id];
        const box = old[id] || h("div", { class: "log short" });
        this.logBox[id] = box;

        return h("div", { class: "card" },
          h("div", { class: "card-head" }, h("h3", {}, title), serviceBadge(info), serviceControls(id)),
          info.error ? h("div", { class: "alert bad" }, info.error) : null,
          h("dl", { class: "kv", style: "margin-bottom:12px" },
            h("dt", {}, "Process ID(s)"), h("dd", { class: "mono" }, info.pids.length ? info.pids.join(", ") : "—"),
            h("dt", {}, "Running since"), h("dd", {}, info.uptimeStartedAt ? `${fmtDateTime(info.uptimeStartedAt)} (${uptime(info.uptimeStartedAt)})` : "—"),
            h("dt", {}, "Managed"), h("dd", {}, info.pid ? (info.managed ? "Started by this dashboard" : "Started elsewhere — adopted, can be stopped here") : "—"),
            info.conflict ? [h("dt", {}, "Conflict"), h("dd", {}, info.conflict)] : null),
          box);
      };

      const wa = S.whatsapp;

      fill(root, 
        h("div", { class: "stack" },
          block("openwa", "OpenWA"),
          h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, "WhatsApp session"), waBadge(wa)), h("dl", { class: "kv" },
            h("dt", {}, "Account"), h("dd", {}, wa.account || "—"),
            h("dt", {}, "Last connected"), h("dd", {}, wa.lastConnectedAt ? fmtDateTime(wa.lastConnectedAt) : "—"),
            h("dt", {}, "Last disconnected"), h("dd", {}, wa.lastDisconnectedAt ? fmtDateTime(wa.lastDisconnectedAt) : "—"),
            h("dt", {}, "Detail"), h("dd", {}, wa.detail || "—"))),
          block("bot", "Review Bot"),
          block("tunnel", "Cloudflare Tunnel")));

      this.refreshLogs();
    },
  });

  addPage({
    id: "whatsapp", title: "WhatsApp", icon: "✆",
    mount(root) { this.hist = null; this.timer = setInterval(() => this.hist && this.hist.refresh(), 5000); },
    unmount() { clearInterval(this.timer); },
    render(root) {
      if (!this.hist) this.hist = historyView({ channel: "whatsapp" });
      const top = h("div", { class: "stack" },
        h("div", { class: "grid cols-2", style: "align-items:start" }, whatsappCard(true), h("div", { class: "card" }, h("h3", {}, "Sending"), sendingToggle("whatsapp"), h("p", { class: "muted", style: "font-size:12.5px" }, "“Submitted” means OpenWA accepted the message. It does not confirm delivery or reading."))),
        statsCard("WhatsApp activity", S.stats && S.stats.whatsapp),
        h("div", { class: "card" }, h("h3", {}, "WhatsApp message history"), this.hist));
      fill(root, top);
    },
  });

  addPage({
    id: "email", title: "Email", icon: "✉",
    mount() { this.hist = null; this.timer = setInterval(() => this.hist && this.hist.refresh(), 5000); },
    unmount() { clearInterval(this.timer); },
    render(root) {
      if (!this.hist) this.hist = historyView({ channel: "email" });
      fill(root, h("div", { class: "stack" },
        h("div", { class: "card" }, h("h3", {}, "Email sending (Microsoft Graph)"), sendingToggle("email"), h("p", { class: "muted", style: "font-size:12.5px" }, "“Submitted” means Microsoft Graph accepted the request (HTTP 202). Credentials stay inside the Review Bot.")),
        statsCard("Email activity", S.stats && S.stats.email),
        h("div", { class: "card" }, h("h3", {}, "Email history"), this.hist)));
    },
  });

  addPage({
    id: "queue", title: "Booking Queue", icon: "☰",
    mount() { this.q = ""; this.data = null; this.timer = setInterval(() => this.load(), 4000); this.load(); },
    unmount() { clearInterval(this.timer); },
    async load() {
      try { this.data = await api("queue"); this.draw(); } catch (e) { this.err = e.message; this.draw(); }
    },
    render(root) {
      this.root = root;
      if (!this.shell) {
        this.totals = h("div", { class: "grid cols-4" });
        this.tableHolder = h("div", {});
        this.shell = h("div", { class: "stack" },
          h("div", { class: "card" }, h("h3", {}, "Queue status"), this.totals),
          h("div", { class: "card" }, h("h3", {}, "Active bookings"),
            h("div", { class: "filters" }, h("input", { type: "search", placeholder: "Search booking or customer", "aria-label": "Search queue", oninput: (e) => { this.q = e.target.value.toLowerCase(); this.draw(); } })),
            this.tableHolder));
      }
      fill(root, this.shell);
      this.draw();
    },
    draw() {
      if (!this.shell) return;
      const d = this.data;

      if (!d) { this.tableHolder.replaceChildren(h("p", { class: "muted" }, this.err || "Loading…")); return; }

      const t = d.totals;
      this.totals.replaceChildren(
        stat(t.queued, "Queued bookings"), stat(t.pendingBookings, "Pending bookings", t.pendingBookings ? "warn" : ""),
        stat(d.processing ? d.processing.bookingId : "None", "Currently processing"), stat(t.whatsappPending, "WhatsApp pending"),
        stat(t.emailPending, "Email pending"), stat(t.failedChannels, "Failed channels", t.failedChannels ? "bad" : ""),
        stat(t.awaitingArchive, "Complete, awaiting archive"), h("div", { class: "stat" }, h("span", { class: "num", style: "font-size:15px;padding-top:7px" }, when(d.lastQueueRunAt)), h("span", { class: "lbl" }, "Last queue run")));

      const rows = d.bookings.filter((b) => !this.q || String(b.bookingId).toLowerCase().includes(this.q) || String(b.customerName || "").toLowerCase().includes(this.q));
      const ch = (c) => h("td", {}, statusBadge(c.status, c.label), c.hold ? h("div", { class: "muted", style: "font-size:12px" }, c.hold) : null, c.error ? h("div", { class: "muted", style: "font-size:12px;max-width:240px" }, c.error) : null);

      this.tableHolder.replaceChildren(
        d.errors.length ? h("div", { class: "alert bad" }, d.errors.join(" · ")) : "",
        h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Booking ID", "Customer", "Received", "WhatsApp", "Email", "State"].map((x) => h("th", {}, x)))),
          h("tbody", {}, rows.length ? rows.map((b) => h("tr", {},
            h("td", { class: "mono" }, b.bookingId), h("td", {}, b.customerName || "—"), h("td", { class: "nowrap" }, fmtDateTime(b.receivedAt)), ch(b.whatsapp), ch(b.email),
            h("td", {}, b.processing ? badge("Processing", "info", true) : b.alreadyArchived ? badge("Already archived", "warn") : b.complete ? badge("Awaiting archive", "ok") : badge("Pending", "warn"))))
            : [h("tr", {}, h("td", { class: "empty", colspan: 6 }, "The active queue is empty."))]))));
    },
  });

  addPage({
    id: "history", title: "Message History", icon: "⌕",
    mount() { this.hist = null; this.timer = setInterval(() => this.hist && this.hist.refresh(), 5000); },
    unmount() { clearInterval(this.timer); },
    render(root) {
      if (!this.hist) this.hist = historyView({});
      fill(root, h("div", { class: "card" }, h("h3", {}, "All submissions"), this.hist));
    },
  });

  addPage({
    id: "cloudflare", title: "Cloudflare", icon: "☁",
    mount() { this.detail = null; this.busy = false; this.loadDetail(); },
    async loadDetail(path = "tunnel", method = "GET") {
      try {
        this.detail = await api(path, { method, ...(method === "POST" ? { body: {} } : {}) });
        this.err = null;
      } catch (e) { this.err = e.message; }
      if (page === this && this.root) this.render(this.root);
    },
    render(root) {
      this.root = root;
      const d = this.detail;
      const info = S.services.tunnel;

      const checks = h("div", { class: "row" },
        h("button", { class: "btn", onclick: (e) => act(e.currentTarget, () => this.loadDetail("tunnel/check", "POST"), "Installation, authentication and routing re-checked") }, "Check installation"),
        h("button", { class: "btn", onclick: (e) => act(e.currentTarget, () => this.loadDetail("tunnel/check", "POST"), "Authentication re-checked") }, "Check authentication"),
        h("button", { class: "btn", onclick: (e) => act(e.currentTarget, () => this.loadDetail("tunnel"), "Status refreshed") }, "Show tunnel status"));

      const rows = d ? [
        ["cloudflared installed", d.installed ? `${d.exePath} (v${d.version || "?"}${d.outdated ? ", update available" : ""})` : "Not found", d.installed],
        ["Cloudflare authentication", d.authConfigured ? "cert.pem present" : "cert.pem missing (only needed for management commands)", d.authConfigured],
        [`Tunnel "${d.tunnelName}"`, d.tunnelFound === false ? "Not found in this Cloudflare account" : d.tunnelId ? `ID ${d.tunnelId}${d.tunnelFound ? "" : " (from config.yml; not verified with Cloudflare)"}` : "ID not determined", Boolean(d.tunnelId) && d.tunnelFound !== false],
        ["Credentials file", d.credentialsFile ? `${d.credentialsFile} — ${d.credentialsExists ? "found" : "MISSING"}` : "Not set", d.credentialsExists],
        ["Configuration file", `${d.configFile} — ${d.configExists ? "found" : "MISSING"}`, d.configExists],
        ["Configured hostname", d.hostnameConfigured ? d.hostname : `${d.hostname} has no ingress rule`, d.hostnameConfigured],
        ["Local destination", d.localTarget ? `${d.localTarget}${d.ingressOk ? "" : ` (expected ${d.expectedTarget})`}` : "—", d.ingressOk],
      ] : [];

      const pub = d && d.public;

      fill(root, h("div", { class: "stack" },
        h("div", { class: "card" },
          h("div", { class: "card-head" }, h("h3", {}, `Tunnel: ${S.tunnelName}`), serviceBadge(info), serviceControls("tunnel")),
          info.error ? h("div", { class: "alert bad" }, info.error) : null,
          info.lastError ? h("div", { class: "alert warn" }, `Latest tunnel error: ${info.lastError}`) : null,
          h("p", { class: "muted", style: "margin:0 0 10px;font-size:12.5px" }, "Uses the EXISTING tunnel with `cloudflared tunnel run`. This dashboard never creates a tunnel, never edits DNS and never changes the Cloudflare account."),
          checks),
        this.err ? h("div", { class: "alert bad" }, this.err) : null,
        h("div", { class: "grid cols-2", style: "align-items:start" },
          h("div", { class: "card" }, h("h3", {}, "Tunnel configuration"),
            d ? h("ul", { class: "check-list" }, rows.map(([k, v, ok]) => h("li", {}, badge(ok ? "OK" : "Problem", ok ? "ok" : "bad"), h("div", {}, h("div", { class: "what" }, k), h("div", { class: "why mono" }, v))))) : h("p", { class: "muted" }, "Loading…"),
            d && d.issues.length ? h("div", { class: "alert warn", style: "margin-top:12px" }, h("strong", {}, "Configuration problems: "), d.issues.join(" · ")) : null,
            d && (!d.ingressOk || !d.configExists) ? armed(h("button", { class: "btn danger", style: "margin-top:10px" }, "Repair config.yml"), "Confirm: rewrite config.yml (backup kept)", (b) => act(b, async () => { const r = await api("tunnel/repair-config", { method: "POST", body: {} }); await this.loadDetail(); return r; }, (r) => r.message)) : null),
          h("div", { class: "stack" }, webhookCard())),
        h("div", { class: "card" }, h("h3", {}, "Public route"),
          pub ? [
            h("div", { class: `alert ${pub.botHealthy ? "ok" : "warn"}` }, pub.detail),
            d.dnsHelp ? h("div", { class: "alert info" },
              h("strong", {}, "DNS is not set up yet. This dashboard will not change DNS. To fix it, do ONE of these yourself:"),
              h("div", { style: "margin-top:6px" }, "1. In Cloudflare DNS: ", h("span", { class: "code" }, d.dnsHelp.dashboard)),
              h("div", { style: "margin-top:6px" }, "2. Or run once: ", h("span", { class: "code" }, d.dnsHelp.cli))) : null,
          ] : h("p", { class: "muted" }, "Press “Check installation” (with the tunnel and bot running) to test https://" + S.hostname + "/health.")),
        h("div", { class: "card" }, h("h3", {}, "Webhook readiness"), readinessList()),
        h("div", { class: "card" }, h("h3", {}, "Tunnel log"), (this.logBox = h("div", { class: "log short" })))));

      this.refreshLog();
    },
    async refreshLog() {
      try {
        const res = await api("logs?service=tunnel");
        const lines = res.entries.slice(-60);
        this.logBox && this.logBox.replaceChildren(...(lines.length ? lines.map((e) => h("span", { class: `l ${e.level}` }, `${tf.format(new Date(e.time))} ${e.message}`)) : [h("span", { class: "muted" }, S.services.tunnel.pid && !S.services.tunnel.managed ? "Started outside the dashboard — output is not captured." : "No output captured yet.")]));
      } catch { /* ignore */ }
    },
  });

  addPage({
    id: "settings", title: "Settings", icon: "✎",
    mount() { this.data = null; this.load(); },
    async load() {
      try { this.data = await api("setup"); this.err = null; } catch (e) { this.err = e.message; }
      if (page === this && this.root) this.render(this.root);
    },
    render(root) {
      this.root = root;
      const d = this.data;
      const groups = {};
      if (d) for (const c of d.checks) (groups[c.group] = groups[c.group] || []).push(c);
      const kind = { ok: "ok", warn: "warn", fail: "bad" };

      const action = (c) => {
        if (!c.action) return null;
        if (c.action.type === "install") {
          return armed(h("button", { class: "btn small" }, "Install (npm ci)"), "Confirm npm ci", (b) => act(b, async () => { await api("setup/install", { method: "POST", body: { kind: c.action.kind } }); await this.load(); }, "Dependencies installed"));
        }
        if (c.action.type === "install-gateway") {
          return h("button", { class: "btn small primary", onclick: (e) => act(e.currentTarget, async () => { await api("setup/install-gateway", { method: "POST", body: {} }); await this.load(); }, "Gateway install started (several minutes)") }, "Install gateway");
        }
        if (c.action.type === "link-gateway") {
          return armed(h("button", { class: "btn small primary" }, "Link to Review Bot"), "Confirm: edit the bot .env (backup kept)", (b) => act(b, async () => { await api("setup/link-gateway", { method: "POST", body: {} }); await this.load(); }, (r) => r.message));
        }
        if (c.action.type === "choose-folder") {
          const input = h("input", { type: "text", placeholder: "Full path to the folder", "aria-label": "Folder path", style: "flex:1;min-width:260px" });
          return h("div", { class: "field" }, input, h("button", { class: "btn small primary", onclick: (e) => act(e.currentTarget, async () => { await api("setup/folder", { method: "POST", body: { kind: c.action.kind, dir: input.value } }); await this.load(); }, "Folder saved") }, "Use this folder"));
        }
        return null;
      };

      fill(root, h("div", { class: "stack" },
        S.install ? h("div", { class: `alert ${S.install.error ? "bad" : S.install.running ? "info" : "ok"}` }, S.install.running ? `Installing gateway: step ${S.install.step}/${S.install.total} - ${S.install.label}…` : S.install.error ? S.install.error : "Gateway install finished. Re-run the checks.") : null,
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, "Setup check"), h("button", { class: "btn small", onclick: (e) => act(e.currentTarget, () => this.load(), "Re-checked") }, "Run checks again")),
          this.err ? h("div", { class: "alert bad" }, this.err) : null,
          d ? (d.ready ? h("div", { class: "alert ok" }, "All required items are in place.") : h("div", { class: "alert warn" }, "Some required items need attention.")) : h("p", { class: "muted" }, "Checking…"),
          Object.entries(groups).map(([g, items]) => h("div", { style: "margin-top:14px" }, h("h3", {}, g),
            h("ul", { class: "check-list" }, items.map((c) => h("li", {}, badge(c.status === "ok" ? "OK" : c.status === "warn" ? "Check" : "Fix", kind[c.status]), h("div", {}, h("div", { class: "what" }, c.label), h("div", { class: "why" }, c.detail), action(c)))))))),
        h("div", { class: "card" }, h("h3", {}, "Sending controls"), h("div", { class: "grid cols-2" }, sendingToggle("whatsapp"), sendingToggle("email"))),
        h("div", { class: "card" }, h("h3", {}, "Appearance"), h("div", { class: "row" }, ["System", "Light", "Dark"].map((t) => h("button", { class: "btn", onclick: () => setTheme(t.toLowerCase()) }, t)))),
        h("div", { class: "card" }, h("h3", {}, "About"), h("dl", { class: "kv" },
          h("dt", {}, "Dashboard"), h("dd", {}, `http://localhost:${location.port} (127.0.0.1 only)`),
          h("dt", {}, "Public hostname (fixed)"), h("dd", { class: "mono" }, S.hostname),
          h("dt", {}, "Tunnel"), h("dd", { class: "mono" }, S.tunnelName),
          h("dt", {}, "OpenWA folder"), h("dd", { class: "mono" }, S.dirs.openwa.dir || S.dirs.openwa.reason),
          h("dt", {}, "Review Bot folder"), h("dd", { class: "mono" }, S.dirs.bot.dir || S.dirs.bot.reason)))));
    },
  });

  addPage({
    id: "logs", title: "System Logs", icon: "≣",
    mount(root) {
      this.service = "all"; this.level = "info"; this.text = ""; this.auto = true;
      this.timer = setInterval(() => this.load(), 1500);
    },
    unmount() { clearInterval(this.timer); },
    async load() {
      if (!this.box) return;
      try {
        const res = await api(`logs?service=${this.service}&level=${this.level}`);
        const needle = this.text.toLowerCase();
        const entries = res.entries.filter((e) => !needle || e.message.toLowerCase().includes(needle));
        const sig = entries.length ? `${entries[entries.length - 1].id}:${entries.length}` : "0";
        if (sig === this.sig) return;
        this.sig = sig;
        this.box.replaceChildren(...(entries.length ? entries.map((e) => h("span", { class: `l ${e.level}` }, h("span", { class: "t" }, `${tf.format(new Date(e.time))} `), h("span", { class: "s" }, `[${e.service}] `), e.message)) : [h("span", { class: "muted" }, "No log lines.")]));
        if (this.auto) this.box.scrollTop = this.box.scrollHeight;
      } catch { /* ignore */ }
    },
    render(root) {
      if (this.shell) { fill(root, this.shell); return; }
      this.box = h("div", { class: "log", role: "log", "aria-live": "off" });
      const svc = h("select", { "aria-label": "Service", onchange: (e) => { this.service = e.target.value; this.sig = ""; this.load(); } },
        [["all", "All services"], ["dashboard", "Dashboard"], ["openwa", "OpenWA"], ["bot", "Review Bot (incl. queue, WhatsApp, email, webhook)"], ["tunnel", "Cloudflare"]].map(([v, t]) => h("option", { value: v }, t)));
      const lvl = h("select", { "aria-label": "Severity", onchange: (e) => { this.level = e.target.value; this.sig = ""; this.load(); } },
        [["info", "Info and above"], ["debug", "Everything"], ["warn", "Warnings and errors"], ["error", "Errors only"]].map(([v, t]) => h("option", { value: v }, t)));
      const txt = h("input", { type: "search", placeholder: "Filter text (e.g. webhook, queue, WhatsApp, email)", "aria-label": "Filter text", oninput: (e) => { this.text = e.target.value; this.sig = ""; this.load(); } });
      const auto = h("label", { class: "row muted" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { this.auto = e.target.checked; } }), "Auto-scroll");

      this.shell = h("div", { class: "card" },
        h("div", { class: "filters" }, svc, lvl, txt, auto, armed(h("button", { class: "btn" }, "Clear view"), "Clear the visible log?", (b) => act(b, async () => { await api("logs/clear", { method: "POST", body: {} }); this.sig = ""; await this.load(); }, "Log view cleared (application files untouched)"))),
        h("p", { class: "muted", style: "font-size:12.5px;margin:0 0 8px" }, "Secrets, tokens, QR data and customer webhook payloads are redacted. Webhook, queue, WhatsApp and email events appear under Review Bot; use the text filter to narrow them."),
        this.box);
      fill(root, this.shell);
      this.load();
    },
  });

  // ------------------------------------------------------------------
  // router / shell
  // ------------------------------------------------------------------

  const view = $("#view");

  function route() {
    const id = (location.hash || "#overview").slice(1);
    const next = PAGES.find((p) => p.id === id) || PAGES[0];

    if (page && page.unmount) page.unmount();
    page = next;

    $("#page-title").textContent = page.title;
    view.replaceChildren();
    $("#sidebar").classList.remove("open");
    drawNav();
    if (page.mount) page.mount(view);
    if (S) page.render(view);
    window.scrollTo(0, 0);
  }

  function drawNav() {
    const dotFor = (p) => {
      if (!S) return "";
      if (p.id === "services") return S.services.openwa.state === "error" || S.services.bot.state === "error" || S.services.tunnel.state === "error" ? "bad" : [S.services.openwa, S.services.bot, S.services.tunnel].every((x) => x.state === "running") ? "ok" : "warn";
      if (p.id === "whatsapp") return S.whatsapp.state === "connected" ? "ok" : S.whatsapp.state === "not_started" ? "" : S.whatsapp.state === "error" || S.whatsapp.state === "disconnected" ? "bad" : "warn";
      if (p.id === "cloudflare") return S.readiness.ready ? "ok" : S.services.tunnel.state === "error" ? "bad" : "warn";
      return "";
    };

    $("#nav").replaceChildren(...PAGES.map((p) => h("a", { href: `#${p.id}`, "aria-current": page && page.id === p.id ? "page" : false }, h("span", { class: "nav-ico", "aria-hidden": "true" }, p.icon), p.title, h("span", { class: `nav-dot ${dotFor(p)}` }))));
  }

  function drawBanner() {
    const el = $("#banner");
    const msgs = [];

    if (S.dirs && (!S.dirs.openwa.ok || !S.dirs.bot.ok)) {
      msgs.push(h("div", { class: "alert bad", style: "margin-top:14px" }, h("strong", {}, "Project folders not found. "), `${!S.dirs.openwa.ok ? `OpenWA: ${S.dirs.openwa.reason}. ` : ""}${!S.dirs.bot.ok ? `Review Bot: ${S.dirs.bot.reason}. ` : ""}`, h("a", { href: "#settings" }, "Open Settings to choose them.")));
    }

    const bot = S.services.bot;

    if (bot.secretChangedSinceStart && bot.state === "running") {
      msgs.push(h("div", { class: "alert warn", style: "margin-top:14px" }, "The webhook secret file changed after the Review Bot started. Restart the Review Bot so it uses the current secret."));
    }

    el.replaceChildren(...msgs);
  }

  function updateButtons() {
    const run = jobRunning();
    const sa = $("#start-all");
    const xa = $("#stop-all");
    sa.disabled = run;
    xa.disabled = run;
    sa.textContent = run && S.job.kind === "start" ? "Starting…" : "▶ START ALL";
    xa.textContent = run && S.job.kind === "stop" ? "Stopping…" : "■ STOP ALL";
  }

  let lastSig = "";

  function onState(next) {
    S = next;
    if (!S.services) return;

    // Skip re-render when nothing visible changed (the server pushes only changes).
    const sig = JSON.stringify(S, (k, v) => (k === "time" || k === "checkedAt" ? undefined : v));
    if (sig === lastSig) return;
    lastSig = sig;

    drawNav();
    drawBanner();
    updateButtons();
    if (page) page.render(view);
  }

  function connect() {
    const conn = $("#conn");
    const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);

    es.onopen = () => { conn.textContent = "Live"; conn.className = "conn live"; };
    es.onmessage = (ev) => { try { onState(JSON.parse(ev.data)); } catch { /* ignore */ } };
    es.onerror = () => {
      conn.textContent = "Reconnecting…";
      conn.className = "conn down";
    };
  }

  // Refresh relative times ("3 min ago") without a server push.
  setInterval(() => { if (S && page && ["overview", "services"].includes(page.id)) { lastSig = ""; page.render(view); } }, 15000);

  // ------------------------------------------------------------------
  // theme
  // ------------------------------------------------------------------

  function setTheme(t) {
    try {
      if (t === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", t);
    } catch { /* storage may be unavailable */ }
    applyTheme();
  }

  function applyTheme() {
    let t = null;
    try { t = localStorage.getItem("theme"); } catch { /* ignore */ }
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  $("#theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    setTheme(dark ? "light" : "dark");
  });

  $("#menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

  $("#start-all").addEventListener("click", (e) => act(e.currentTarget, () => api("all/start", { method: "POST", body: {} }), "Start All started"));
  armed($("#stop-all"), "Confirm STOP ALL?", (b) => act(b, () => api("all/stop", { method: "POST", body: {} }), "Stop All started"));

  applyTheme();
  window.addEventListener("hashchange", route);

  // initial state, then live stream
  api("state").then((s) => { S = s; route(); onState(s); connect(); }).catch((e) => {
    view.replaceChildren(h("div", { class: "alert bad" }, `Could not load dashboard state: ${e.message}. Reload the page.`));
  });
})();
