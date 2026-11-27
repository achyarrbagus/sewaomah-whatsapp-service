# SewaOmah WhatsApp service

WhatsApp channel adapter for Omi (SewaOmah rental-search assistant). It uses the
unofficial [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js/) library
(Puppeteer + Chromium) and contains no conversation logic:

1. incoming WhatsApp text -> `POST {OMI_API_URL}/api/internal/omi/messages`
2. the `replies` Go returns -> sent to the same chat
3. each reply's delivery status -> `POST /api/internal/omi/outbound/:id/status`
4. on start -> `POST /api/internal/omi/outbound/reconcile`

All calls carry `Authorization: Bearer $OMI_GATEWAY_SECRET`. whatsapp-web.js is not
the official WhatsApp Business Platform: WhatsApp Web changes can break it and the
account can be restricted. Use a dedicated Omi number, never the operational one.

## Requirements

Node.js >= 22 and Chromium are required. Run this service as a persistent process on the same host as the Go API; its status endpoint is bound to loopback. The Go API must include the Omi endpoints and use the same gateway secret. The gateway is deployed separately from the Go backend.

```sh
npm ci --omit=dev
npm test          # node:test; uses a fake client and a local fake Go API, no Chromium/network
```

## Running the standalone service

This directory is independent of the backend checkout. The Go API owns Omi's
conversation and database logic; this service only provides the WhatsApp channel.
The API's existing CI/CD does not deploy this service.

```sh
cp .env.example .env
mkdir -p session && chmod 700 session
# Edit .env: use an absolute path for OMI_SESSION_DIR and set the shared secret.
node --env-file=.env src/index.js
```

For PM2, install the environment file at `/etc/sewaomah-whatsapp-service/env`
or set `OMI_GATEWAY_ENV_FILE` to its absolute path before starting
`ecosystem.config.cjs`. Keep the session directory persistent across releases.
Configure the same `OMI_GATEWAY_SECRET` in Go and point its `OMI_GATEWAY_URL`
to the local status endpoint (default `http://127.0.0.1:8095`). This loopback
configuration assumes both processes run on the same host.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `OMI_GATEWAY_SECRET` | required | >= 32 chars, same value as the Go API. Refuses to start otherwise. |
| `OMI_SESSION_DIR` | required | Existing directory, mode `0700`, owned by the gateway user. Holds the `LocalAuth` session (equivalent to a credential) and `.gateway.lock`. Refuses to start otherwise. |
| `OMI_API_URL` | `http://127.0.0.1:8081` | Go API base URL. |
| `OMI_GATEWAY_PORT` | `8095` | Local status server port, bound to `127.0.0.1` only. |
| `OMI_CHROMIUM_PATH` | unset | Path to a system Chromium/Chrome; otherwise Puppeteer's downloaded browser is used. |

Only one gateway may drive a session: an exclusive pid lock
`OMI_SESSION_DIR/.gateway.lock` makes a second process exit with code 1 (a lock
left by a dead pid is taken over).

## Status endpoint (read by the Go admin API)

`GET http://127.0.0.1:$OMI_GATEWAY_PORT/status` with
`Authorization: Bearer $OMI_GATEWAY_SECRET`.

- `401 {"message":"Unauthorized"}` without/with a wrong bearer (checked before routing).
- `200` `{"state", "qr", "reason", "since"}`, always `Cache-Control: no-store`:
  - `state`: `waiting_qr` | `authenticated` | `ready` | `auth_failure` | `disconnected`
    (`authenticated` is not `ready`; only `ready` processes messages).
  - `qr`: the raw QR payload string while `state` is `waiting_qr`, otherwise `null`.
    Render it as a QR code for an authorized admin; never store or log it.
  - `reason`: `null`, or a short safe string: `not_started`, `initialize_failed`,
    `auth_failure`, `reconnect_exhausted`, or a whatsapp-web.js disconnect reason
    (`NAVIGATION`, `LOGOUT`, `CONFLICT`, `UNPAIRED`, ...).
  - `since`: ISO-8601 time the current state/reason began.
- `404` other paths, `405` non-GET.

## Behaviour

- Ignored: `fromMe`, status/broadcast, newsletters, group chats (`@g.us`).
- Every forward carries `message_type` (whatsapp-web.js `msg.type`: `chat` for text,
  else `image`, `video`, `audio`, `ptt`, `ptv`, `document`, `sticker`, `location`,
  `vcard`, `multi_vcard`, `poll_creation`). For media, `body` is the caption or `""`
  (vCard/location bodies are never sent). Go stores it and replies with the non-text
  copy unless the conversation is `waiting_admin`; the gateway never auto-replies
  itself. System message types are ignored.
- `from` sent to Go: digits for `@c.us` (e.g. `6281234567890`). For `@lid` chats the
  phone is resolved with `client.getContactLidAndPhone([id])` (`pn` digits); if that
  fails, `from` is `lid:<lid digits>` (never bare lid digits). Replies go to the
  original chat id.
- Messages of one chat are processed strictly in order; different chats run concurrently.
- Forwarding retries network errors, 429 and 5xx up to 3 times with backoff (Go is
  idempotent on `provider_message_id`); 4xx is not retried.
- Delivery status per reply: `sent` (only with a provider message id), `failed` (never
  handed to WhatsApp, e.g. not ready), `unknown` (send started then threw, timed out
  after 30 s, or returned no message id). `unknown` is never resent.
- `disconnected`: reconnect with exponential backoff 5 s, 10 s, ... capped at 5 min,
  at most 6 attempts, then `disconnected` / `reconnect_exhausted` until an admin acts
  (restart the PM2 process; scan a new QR if asked). `auth_failure` also waits for an admin.
- SIGTERM/SIGINT: `client.destroy()` (closes Chromium), release the lock, exit.
- Logs are JSON lines with ids, counts and states only: never message bodies, phone
  numbers/chat ids, or the QR string.

## Why `--no-sandbox`

Chromium's sandbox needs unprivileged user namespaces or a setuid helper. Those are
commonly unavailable on servers and inside containers (and Ubuntu 23.10+ restricts
them via AppArmor), so Chromium fails to launch. The gateway only loads
`web.whatsapp.com`, runs as a dedicated unprivileged user, and is not reachable from
the network, which is the accepted trade-off. If your host supports the sandbox, you
can remove the flag in `src/client.js`.

## Manual verification

Run against a dedicated test WhatsApp number (never the operational one), with the
Go API running and the same `OMI_GATEWAY_SECRET` on both sides.

- [ ] `pm2 start ecosystem.config.cjs`; `GET /status` shows `waiting_qr` with a `qr`.
- [ ] Scan the QR (WhatsApp > Linked devices); `/status` moves `authenticated` -> `ready`, `qr` becomes `null`.
- [ ] From another phone send "kos jogja 1 juta": Omi replies with results; Go shows the outgoing rows as `sent`.
- [ ] Send an image: exactly one "Omi baru bisa membaca pesan teks." reply (from Go); stored with `message_type='image'`.
- [ ] Type *admin*, then send an image: no reply (waiting_admin), message still stored.
- [ ] Message from a group containing the Omi number: no reply.
- [ ] `pm2 restart omi-gateway`: reaches `ready` again without a new QR (session restored).
- [ ] Start a second gateway with the same `OMI_SESSION_DIR`: it exits 1 (lock held).
- [ ] Log out the linked device from the phone: `/status` shows `disconnected`/`LOGOUT`, then `waiting_qr`.
- [ ] Logs contain no message text, phone numbers or QR payload.

## CI/CD

GitHub Actions tests syntax, gateway behavior, and release rollback on pull
requests and pushes to `main`. Once enabled, a successful push to `main` (or a
manual run on `main`) deploys this service separately over SSH. Deployment is
opt-in: set the repository Actions variable `DEPLOY_ENABLED` to `true` after
the server and secrets are ready. Until then the deploy job is skipped.

Configure these secrets in the GitHub `production` environment:
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (dedicated private key), and
`DEPLOY_KNOWN_HOSTS` (independently verified SSH host key). Optional repository
variable `DEPLOY_PORT` defaults to 22. The deployment user needs write access to
`/opt/sewaomah-whatsapp-service/releases`, Node.js 22+, npm, and PM2. PM2 must
run under the same user for every release. Install system Chromium and configure
its executable path in `/etc/sewaomah-whatsapp-service/env` along with the
shared gateway secret and persistent session directory. The file must be
readable by the deployment user and valid as both a shell and Node env file.

Each deployment installs locked dependencies in a new release directory without
downloading Chromium, switches `current`, and restarts `omi-gateway`. It checks
the authenticated local status endpoint and restores the previous release if
activation fails. A responding status endpoint confirms the process is alive;
it does not imply a WhatsApp account is paired. The first deployment has no
previous release to restore. Session data and the server environment file must
remain outside the release directory. This workflow does not configure a server,
connect WhatsApp, or deploy the Go API.
