# Western Cars Operations Dashboard

One local browser dashboard to run OpenWA, the Review Bot and the existing Cloudflare tunnel.

## Daily use
1. Double-click `..\Start-Western-Cars-Dashboard.bat` (opens http://localhost:3001).
2. Click **START ALL**.
3. Scan the WhatsApp QR shown on the Overview/WhatsApp page when it appears.

Closing the dashboard window does **not** stop the services (they run independently);
use **STOP ALL**. Re-opening the dashboard re-adopts anything already running.

## Layout (any Windows user / drive)
```
ReviewSetup\  openwa-render-secure\  WesternCarsReviewBot\  control-dashboard\  Start-Western-Cars-Dashboard.bat
```
Folders are found automatically next to `control-dashboard`; otherwise choose them in **Settings -> Setup check**.
No paths or usernames are hard-coded. No `npm install` is needed for the dashboard itself (zero dependencies).

## First run on another computer
Needs Node 18+, cloudflared, and the two project folders with their own `.env`, `.webhook-secret`,
Cloudflare `config.yml` + credentials, and a WhatsApp session. Settings -> Setup check lists what is missing
and can run `npm ci` (lockfile only) for a project. **Never copy** `.env`, `.webhook-secret`, `.openwa-session`,
`~/.cloudflared`, `data/` or customer data into a shared package.

## What it does
- **Services**: start/stop/restart with real PIDs and health checks; Windows process trees are stopped (only this project's processes); existing processes are adopted, never duplicated.
- **QR**: the real QR string from OpenWA's `/health` is rendered locally, refreshes automatically, shows expired/connected states.
- **Sending toggles**: write `WesternCarsReviewBot\data\runtime-settings.json`, read by the bot on every queue run (falls back to `.env`). OFF = jobs stay pending.
- **Webhook URL**: fixed `https://dev.a1airportcarsworthing.co.uk/webhooks/icabbi?key=<.webhook-secret>`; revealed/copied only by explicit button, never logged.
- **Cloudflare**: uses the existing `a1airport-dev` tunnel (`cloudflared --config ... tunnel run a1airport-dev`). Never creates tunnels or touches DNS/iCabbi. If DNS is missing it tells you exactly what to add.
- **Statistics/history**: read-only views of the bot's queue/archive. "Submitted" = provider accepted, not delivered/read.

## Changes made to the Review Bot (`server.js`, original in `..\_backups`)
Runtime toggles; `runtime-status.json` heartbeat (last webhook/queue run); provider response, recipient and timestamp stored per channel;
"submitting" marker written before each send (an interrupted send becomes "unknown" and is never auto-resent);
failed channels back off and stop after 10 attempts; queue sweep archives finished bookings (fixes the stuck booking) and skips blocked ones;
corrupt/empty JSON is quarantined and restored from `.bak`; rename retries on Windows locks. Webhook auth is unchanged.

## Security
127.0.0.1 only; Host/Origin checks; per-launch token; JSON-only mutations; CSP; secrets redacted from logs;
the cloudflared ingress is checked so port 3001 can never be routed publicly.

## Tests
`npm test` (Review Bot tests use a temp copy, fake credentials and mocked providers; nothing is sent).

## WhatsApp account-safety settings (Review Bot `.env`, all optional)
`WA_MAX_AGE_HOURS=2` (older bookings are skipped, never sent late; 0 = off) · `WA_DAILY_CAP=100` (extra messages wait until tomorrow; 0 = off) ·
`QUEUE_JITTER_MIN_MS=40000` / `QUEUE_JITTER_MAX_MS=120000` (random gap between runs). Messages use the customer's first name, 3 wordings and "Reply STOP to opt out".
A STOP reply is received from the OpenWA gateway at `/webhooks/whatsapp-reply` (own secret, `WHATSAPP_REPLY_SECRET`) and the number is never messaged again (`data/whatsapp-optout.json`).
The gateway's own pacing (`SEND_PACING_ENABLED=true`: warm-up and new-chat daily caps) is switched on; when it says "slow down" jobs wait without counting as failures.

**Timing:** each completed booking is messaged 2-5 minutes after it arrives (random per booking, `SEND_DELAY_MIN_MS`/`SEND_DELAY_MAX_MS`);
the queue is checked every 15-25 s and WhatsApp submissions are at least ~40-70 s apart (`WA_MIN_GAP_MS`). During a backlog the wait can be longer.
