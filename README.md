# Hermes Mobile

Mobile web bridge for Hermes. It follows the Athena Mobile Tailscale pattern: bind locally by default, optionally bind directly to a Tailscale CGNAT address for dev, and keep backend tokens inside the Node server.

The bridge is a thin, transparent reverse proxy. It targets the gateway's **`api_server` platform** (`gateway/platforms/api_server.py`) — the REST + SSE chat API — **not** the desktop app and **not** the dashboard's WebSocket JSON-RPC. Every `/hermes-backend/*` request (session list/create and the `chat/stream` SSE) is piped straight through with a server-injected `API_SERVER_KEY`; the front-end (`public/app.js`) consumes the api_server's native SSE (`event:`-keyed `run.started` / `assistant.delta` / `tool.*` / `assistant.completed` / `done`) directly, so the bridge does no event translation.

Enable the platform on the gateway by setting `API_SERVER_KEY` (and optionally `API_SERVER_PORT`, default `8642`; `API_SERVER_HOST`, default `127.0.0.1`) in `~/.hermes/.env`, then `hermes gateway restart`. The key is required even on loopback binds.

## UI

The front-end (`public/`) is a no-build PWA that mirrors the Hermes **desktop** UI, adapted for touch:

- The desktop `nous` theme is ported verbatim (same `--theme-* → --ui-* → --dt-*` token cascade), light + dark, switchable from the top bar and matching the system preference by default.
- The desktop conversation paradigm: user turns render as full-width glass cards, assistant turns as flowing markdown prose, with dimmed tool/thinking scaffolding blocks.
- The desktop sidebar becomes an off-canvas drawer (edge-swipe to open, drag/scrim to close) holding the session list and nav.
- A glass composer with the desktop focus-ring glow, auto-growing input, live streaming, and stop control.
- The drawer's nav opens full-screen pages backed by live backend data:
  - **Skills & Tools** — toolsets, skills, and MCP servers with working enable/disable switches (`/api/tools/toolsets`, `/api/skills`, `/api/mcp/servers`).
  - **Messaging** — platform list with connection status and enable toggles (`/api/messaging/platforms`).
  - **Artifacts** — images/files/links scanned out of recent session messages (same heuristics as the desktop pane), filterable and tap-to-open/copy.

No bundler is involved — the bridge serves `public/` directly. UI glyphs are inline SVG and markdown is rendered client-side, so the shell works offline once cached. The app/PWA icon is the shared Hermes brand mark copied from `apps/desktop/assets/icon.png`.

## Run

```bash
cd apps/desktop/hermes-mobile
HERMES_MOBILE_BACKEND_URL=http://127.0.0.1:8642 \
HERMES_MOBILE_BACKEND_TOKEN="$API_SERVER_KEY" \
npm run dev
```

`HERMES_MOBILE_BACKEND_URL` is the gateway `api_server` address (`API_SERVER_PORT`, default `8642`); the token is the `API_SERVER_KEY`. Or skip env vars and use a descriptor file (below) — recommended, since it lets the bridge follow a port change without restarting.

Default URL:

```text
http://127.0.0.1:5274
```

## Tailscale Dev Mode

```bash
HERMES_MOBILE_HOST=tailscale npm run dev
```

The server scans `os.networkInterfaces()` for a non-internal IPv4 address in `100.64.0.0/10` and binds only to that address.

## Tailscale Production Mode

Keep the bridge on loopback and let Tailscale terminate HTTPS:

```bash
npm run start
tailscale serve --bg https / http://127.0.0.1:5274
```

HTTPS is required for installable PWA/service-worker behavior on phones.

## Backend Descriptor

Instead of env vars, write one of these files:

```text
~/.context-workspace/hermes-backend.json
~/.context-workspace/backend.json
~/.context-workspace/desktop-backend.json
~/.hermes/hermes-mobile-backend.json
```

Shape:

```json
{
  "baseUrl": "http://127.0.0.1:8642",
  "token": "<API_SERVER_KEY>"
}
```

`baseUrl` is the gateway `api_server` address; `token` is the `API_SERVER_KEY`. The browser never receives this token. Requests go to `/hermes-backend/*`; the bridge injects `Authorization: Bearer ...` and `X-Hermes-Session-Token: ...` server-side.

### Live re-resolution (surviving a Hermes restart)

The bridge **re-resolves its backend descriptor on every request** (cached ~2s). The `API_SERVER_KEY` is *static* (unlike the dashboard's rotating session token), so the descriptor normally never needs refreshing — write it once. If the `api_server` port ever changes, just update the highest-priority descriptor and the bridge follows without its own restart.

> Env config (`HERMES_MOBILE_BACKEND_URL`) is intentionally *constant* — it pins the bridge. To get live-follow, run in **descriptor mode**: start the bridge without `HERMES_MOBILE_BACKEND_URL` so it reads the descriptor files above.

> **Note:** `scripts/sync-backend.mjs` (`npm run sync`) predates this and scrapes the **dashboard's** rotating token on `:9119` — that is the *wrong* server for the chat API (the dashboard's `web_server.py` has no `chat/stream` route). It is not needed for the `api_server` flow; write the static descriptor above instead.

## Control Proxy

Optional control-server descriptors use the same shape and are exposed at `/hermes-control/*`:

```text
~/.context-workspace/hermes-control.json
~/.context-workspace/electron-control.json
~/.context-workspace/control.json
~/.hermes/hermes-mobile-control.json
```

Environment override:

```bash
HERMES_MOBILE_CONTROL_URL=http://127.0.0.1:40673
HERMES_MOBILE_CONTROL_TOKEN=...
```

## Notes

Hermes Desktop's Electron process creates its local dashboard token in memory, and the desktop talks to its dashboard over WebSocket JSON-RPC (`/api/ws`). The mobile bridge deliberately does **not** ride on that: it connects to the standalone gateway `api_server` platform over plain REST + SSE, authenticated by the static `API_SERVER_KEY`. That keeps mobile decoupled from whether the desktop app is open and from the dashboard's rotating token. The same `api_server` is what other external REST clients use (e.g. `scripts/setup_open_webui.sh`).
