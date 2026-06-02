# Hermes Mobile

Mobile web bridge for Hermes Desktop. It follows the Athena Mobile Tailscale pattern: bind locally by default, optionally bind directly to a Tailscale CGNAT address for dev, and keep backend tokens inside the Node server.

## UI

The front-end (`public/`) is a no-build PWA that mirrors the Hermes **desktop** UI, adapted for touch:

- The desktop `nous` theme is ported verbatim (same `--theme-* → --ui-* → --dt-*` token cascade), light + dark, switchable from the top bar and matching the system preference by default.
- The desktop conversation paradigm: user turns render as full-width glass cards, assistant turns as flowing markdown prose, with dimmed tool/thinking scaffolding blocks.
- The desktop sidebar becomes an off-canvas drawer (edge-swipe to open, drag/scrim to close) holding the session list and nav.
- A glass composer with the desktop focus-ring glow, auto-growing input, live streaming, and stop control.

No bundler is involved — the bridge serves `public/` directly. UI glyphs are inline SVG and markdown is rendered client-side, so the shell works offline once cached. The app/PWA icon is the shared Hermes brand mark copied from `apps/desktop/assets/icon.png`.

## Run

```bash
cd apps/desktop/hermes-mobile
HERMES_MOBILE_BACKEND_URL=http://127.0.0.1:9119 \
HERMES_MOBILE_BACKEND_TOKEN=... \
npm run dev
```

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
  "baseUrl": "http://127.0.0.1:9119",
  "token": "session-token"
}
```

The browser never receives this token. Requests go to `/hermes-backend/*`; the bridge injects `Authorization: Bearer ...` and `X-Hermes-Session-Token: ...` server-side.

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

Hermes Desktop's Electron process creates its local dashboard token in memory. This mobile bridge cannot discover that IPC-only connection automatically. Use a separately started Hermes dashboard/API server, a remote desktop gateway config via env, or a descriptor file.
