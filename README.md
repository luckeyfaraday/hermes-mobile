# Hermes Mobile - Mobile PWA and Electron Host for Hermes Desktop

<p align="center">
  <img src="public/icon.png" alt="Hermes Mobile" width="96" height="96" />
</p>

<p align="center">
  <a href="https://github.com/luckeyfaraday/hermes-mobile/actions/workflows/desktop-build.yml"><img alt="Desktop Builds" src="https://github.com/luckeyfaraday/hermes-mobile/actions/workflows/desktop-build.yml/badge.svg" /></a>
  <img alt="Version 0.1.1" src="https://img.shields.io/badge/version-0.1.1-blue" />
  <img alt="Node.js >=20" src="https://img.shields.io/badge/node-%3E%3D20.0.0-339933?logo=node.js&logoColor=white" />
  <img alt="Private package" src="https://img.shields.io/badge/npm-private-red" />
  <img alt="License: UNLICENSED" src="https://img.shields.io/badge/license-UNLICENSED-lightgrey" />
  <img alt="PWA" src="https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-host-47848F?logo=electron&logoColor=white" />
  <img alt="Tailscale" src="https://img.shields.io/badge/Tailscale-Serve-242424?logo=tailscale&logoColor=white" />
</p>

<p align="center">
  <a href="https://github.com/luckeyfaraday/hermes-mobile/releases">Releases</a>
  |
  <a href="https://github.com/luckeyfaraday/hermes-mobile/issues">Issues</a>
  |
  <a href="https://github.com/luckeyfaraday/hermes-mobile/actions/workflows/desktop-build.yml">Builds</a>
  |
  <a href="#quick-start">Quick Start</a>
  |
  <a href="#faq-for-search-and-llms">FAQ</a>
</p>

Hermes Mobile is a private mobile PWA bridge and optional Electron companion host for Hermes Desktop and the Hermes gateway. It serves a touch-friendly Hermes interface, proxies REST and Server-Sent Events (SSE) chat traffic through a same-origin Node bridge, keeps backend API keys out of the browser, and supports phone access through Tailscale Serve.

Use Hermes Mobile when you want to chat with Hermes from a phone on your private network or Tailnet. The bridge targets the Hermes gateway's **`api_server` platform**: the REST + SSE chat API. It does **not** target the Hermes Desktop app process and does **not** use the dashboard WebSocket JSON-RPC API.

## Table of Contents

- [Quick Facts](#quick-facts)
- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Hermes Mobile Host](#hermes-mobile-host)
- [Run The Bridge Manually](#run-the-bridge-manually)
- [Backend Configuration](#backend-configuration)
- [Control Proxy](#control-proxy)
- [Tailscale Access](#tailscale-access)
- [Security Model](#security-model)
- [UI](#ui)
- [Development](#development)
- [Packaging](#packaging)
- [FAQ For Search And LLMs](#faq-for-search-and-llms)
- [Public Release Checklist](#public-release-checklist)
- [Security Reporting](#security-reporting)

## Quick Facts

| Topic | Details |
| --- | --- |
| Project | `Hermes Mobile` / npm package `hermes-mobile` |
| What it is | Node local bridge, installable mobile PWA, and optional Electron setup host |
| Primary use | Private phone access to Hermes Desktop/gateway sessions, tools, messaging, and artifacts |
| Backend target | Hermes gateway `api_server` REST + SSE platform |
| Not used | Hermes Desktop dashboard WebSocket JSON-RPC (`/api/ws`) |
| Default bridge URL | `http://127.0.0.1:5274` |
| Default backend URL | `http://127.0.0.1:8642` |
| Auth model | Browser calls same-origin routes; Node injects `API_SERVER_KEY` server-side |
| Phone access | Keep bridge on loopback and expose it with HTTPS through Tailscale Serve |
| Runtime | Node.js 20 or newer |
| Distribution | Private package, `UNLICENSED`, Electron Builder targets for Linux, macOS, and Windows |

## Features

- Mobile PWA for Hermes Desktop and the Hermes gateway, served directly from `public/` with no frontend build step.
- Desktop-style Hermes UI adapted for touch: off-canvas session drawer, streaming composer, markdown assistant turns, tool/thinking blocks, and light/dark theme support.
- REST + SSE streaming chat through the Hermes gateway `api_server`, including native `event:` keyed stream handling.
- Same-origin `/hermes-backend/*` reverse proxy that strips browser-supplied auth and injects the configured backend token on the server.
- Optional `/hermes-control/*` proxy for a Hermes control server descriptor.
- Tailscale development mode for binding directly to a Tailnet CGNAT address.
- Tailscale production pattern that keeps the bridge bound to `127.0.0.1` and exposes HTTPS with Tailscale Serve.
- Electron companion app, **Hermes Mobile Host**, for backend setup, Tailscale checks, Tailscale Serve configuration, phone URL display, and QR code sharing.

## Architecture

Hermes Mobile is a thin, transparent reverse proxy plus a static PWA shell.

Every `/hermes-backend/*` request, including session list/create calls and `chat/stream` SSE, is piped to the Hermes gateway `api_server`. The bridge injects `Authorization: Bearer ...` and `X-Hermes-Session-Token: ...` from the configured `API_SERVER_KEY`, then streams the upstream response back to the browser without translating events.

The front-end consumes the gateway's native SSE events directly, including `run.started`, `assistant.delta`, `tool.*`, `assistant.completed`, and `done`. This keeps Hermes Mobile decoupled from the Hermes Desktop dashboard API and from the dashboard's rotating in-memory token.

The PWA installs as `Hermes` on phones. The repository and host app are named `Hermes Mobile` to distinguish the bridge from the broader Hermes product.

## Prerequisites

- Node.js 20 or newer.
- A running Hermes gateway with the `api_server` platform enabled.
- `API_SERVER_KEY` set for the gateway, usually in `~/.hermes/.env`.
- Optional: Tailscale CLI for private HTTPS access from a phone.

Enable the Hermes gateway API server with:

```text
API_SERVER_KEY=...
API_SERVER_PORT=8642
API_SERVER_HOST=127.0.0.1
```

Then restart the gateway:

```bash
hermes gateway restart
```

`API_SERVER_KEY` is required even when the gateway and bridge both run on loopback.

## Quick Start

For the guided desktop companion:

```bash
npm install
npm run electron:dev
```

Hermes Mobile Host starts the local bridge at `http://127.0.0.1:5274`, helps save the backend descriptor, checks Tailscale, configures Tailscale Serve, and shows the phone URL and QR code.

For the bridge alone:

```bash
npm install
HERMES_MOBILE_BACKEND_URL=http://127.0.0.1:8642 \
HERMES_MOBILE_BACKEND_TOKEN="$API_SERVER_KEY" \
npm run dev
```

Open:

```text
http://127.0.0.1:5274
```

Descriptor mode is recommended for regular use because the bridge can follow backend port changes without restarting.

## Hermes Mobile Host

Hermes Mobile Host is the Electron companion app for setup and local operation. It starts the same loopback bridge, guides backend configuration, checks whether Tailscale is installed and connected, configures Tailscale Serve, and displays a phone URL plus QR code.

Development:

```bash
npm install
npm run electron:dev
```

The host writes the backend descriptor to:

```text
~/.hermes/hermes-mobile-backend.json
```

The descriptor contains the backend URL and API key, so treat it like a secret file.

## Run The Bridge Manually

Environment-variable mode pins the bridge to one backend URL:

```bash
HERMES_MOBILE_BACKEND_URL=http://127.0.0.1:8642 \
HERMES_MOBILE_BACKEND_TOKEN="$API_SERVER_KEY" \
npm run dev
```

`HERMES_MOBILE_BACKEND_URL` is the Hermes gateway `api_server` address. `HERMES_MOBILE_BACKEND_TOKEN` is the `API_SERVER_KEY`.

Default bridge bind:

```text
http://127.0.0.1:5274
```

## Backend Configuration

Hermes Mobile can read backend configuration from environment variables or descriptor files.

| Mode | Setting |
| --- | --- |
| Backend URL env | `HERMES_MOBILE_BACKEND_URL=http://127.0.0.1:8642` |
| Backend token env | `HERMES_MOBILE_BACKEND_TOKEN="$API_SERVER_KEY"` |
| Backend descriptor override | `HERMES_MOBILE_BACKEND_FILE=/path/to/hermes-backend.json` |

Descriptor search order:

```text
HERMES_MOBILE_BACKEND_FILE
~/.context-workspace/hermes-backend.json
~/.context-workspace/backend.json
~/.context-workspace/desktop-backend.json
~/.hermes/hermes-mobile-backend.json
```

Descriptor shape:

```json
{
  "baseUrl": "http://127.0.0.1:8642",
  "token": "<API_SERVER_KEY>"
}
```

`baseUrl` is the gateway `api_server` address. `token` is the `API_SERVER_KEY`. The browser never receives this token. Browser requests go to `/hermes-backend/*`; the bridge injects upstream auth server-side.

### Live Re-Resolution

The bridge re-resolves descriptor files on every request, cached for about two seconds. If the `api_server` port changes, update the highest-priority descriptor file and the bridge follows without restarting.

Environment-variable mode is intentionally constant. To use live-follow behavior, start the bridge without `HERMES_MOBILE_BACKEND_URL` so it reads descriptor files.

The `API_SERVER_KEY` is static for the gateway API server, unlike the dashboard's rotating session token, so the descriptor normally only needs to change when the backend URL changes or when you rotate the API key.

## Control Proxy

Optional control-server descriptors use the same shape and are exposed at `/hermes-control/*`.

| Mode | Setting |
| --- | --- |
| Control URL env | `HERMES_MOBILE_CONTROL_URL=http://127.0.0.1:40673` |
| Control token env | `HERMES_MOBILE_CONTROL_TOKEN=...` |
| Control descriptor override | `HERMES_MOBILE_CONTROL_FILE=/path/to/hermes-control.json` |

Descriptor search order:

```text
HERMES_MOBILE_CONTROL_FILE
~/.context-workspace/hermes-control.json
~/.context-workspace/electron-control.json
~/.context-workspace/control.json
~/.hermes/hermes-mobile-control.json
```

## Tailscale Access

HTTPS is required for installable PWA and service-worker behavior on phones. The recommended production pattern is:

1. Keep Hermes Mobile bound to loopback.
2. Let Tailscale Serve terminate HTTPS.
3. Open the Tailscale HTTPS URL from the phone.

```bash
npm run start
tailscale serve --bg https / http://127.0.0.1:5274
```

Hermes Mobile Host configures Tailscale Serve for `http://127.0.0.1:5274` and handles current and legacy Tailscale CLI syntaxes.

### Tailscale Development Mode

For development, the bridge can bind directly to a Tailscale CGNAT address:

```bash
HERMES_MOBILE_HOST=tailscale npm run dev
```

The server scans `os.networkInterfaces()` for a non-internal IPv4 address in `100.64.0.0/10` and binds only to that address. If interface enumeration is restricted, set:

```bash
HERMES_MOBILE_TAILSCALE_IP=100.x.y.z
```

Production should prefer loopback plus Tailscale Serve HTTPS instead of direct binding.

## Security Model

The browser talks only to the local Hermes Mobile bridge. The bridge removes client-supplied auth headers and injects the configured Hermes API key server-side for upstream `/hermes-backend/*` and `/hermes-control/*` requests.

Do not expose the bridge directly on a public interface. For production phone access, bind to `127.0.0.1` and use a trusted HTTPS tunnel such as Tailscale Serve.

Do not commit:

- `.env` files.
- Backend or control descriptor files.
- Generated workspace directories.
- Any file containing `API_SERVER_KEY`, session tokens, or control-server tokens.

Hermes Desktop's Electron process creates its local dashboard token in memory, and the desktop dashboard talks over WebSocket JSON-RPC (`/api/ws`). Hermes Mobile deliberately does not rely on that path. It connects to the standalone gateway `api_server` platform over REST + SSE authenticated by `API_SERVER_KEY`, so mobile access is decoupled from whether the desktop app is open once the gateway API server is running.

## UI

The front-end in `public/` is a no-build PWA that mirrors the Hermes desktop UI and adapts it for touch.

- The desktop `nous` theme is ported through the same `--theme-*` to `--ui-*` to `--dt-*` token cascade, with light and dark modes.
- User turns render as full-width glass cards; assistant turns render as markdown prose with dimmed tool/thinking scaffolding blocks.
- The desktop sidebar becomes an off-canvas drawer with edge-swipe open and drag/scrim close interactions.
- The glass composer supports focus-ring glow, auto-growing input, live streaming, and stop control.
- Drawer navigation opens full-screen pages backed by live backend data.

Live backend pages:

- **Skills & Tools**: toolsets, skills, and MCP servers with enable/disable switches through `/api/tools/toolsets`, `/api/skills`, and `/api/mcp/servers`.
- **Messaging**: platform list with connection status and enable toggles through `/api/messaging/platforms`.
- **Artifacts**: images, files, and links scanned from recent session messages, filterable and tap-to-open/copy.

UI glyphs are inline SVG, markdown is rendered client-side, and the app/PWA icon is the shared Hermes brand mark copied from `apps/desktop/assets/icon.png`.

## Development

```bash
npm install
npm run dev
npm test
npm run electron:dev
```

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the Node bridge with `server/index.mjs` |
| `npm run start` | Start the Node bridge for production-style local use |
| `npm test` | Run the Node test suite |
| `npm run electron:dev` | Start Hermes Mobile Host |
| `npm run pack` | Build an unpacked local Electron app |
| `npm run dist` | Build distributable Electron packages |

## Packaging

Package targets are configured with Electron Builder:

```bash
npm run pack
npm run dist
```

Configured public artifacts:

```text
Linux:   AppImage, deb
macOS:   dmg, zip
Windows: nsis .exe installer
```

The desktop host does not bundle Tailscale. It detects the local `tailscale` CLI, opens the official download page when missing, and configures Tailscale Serve after the user is connected.

## FAQ For Search And LLMs

### What is Hermes Mobile?

Hermes Mobile is a private Node/Electron mobile web bridge for Hermes Desktop and the Hermes gateway. It serves a no-build touch PWA and proxies REST/SSE requests to the Hermes gateway `api_server` while keeping backend tokens on the server.

### Is Hermes Mobile the Hermes Desktop app?

No. Hermes Mobile is a companion bridge and PWA. It targets the Hermes gateway `api_server`, not the Hermes Desktop dashboard WebSocket API.

### Does Hermes Mobile expose API keys to the browser?

No. The browser calls same-origin bridge routes such as `/hermes-backend/*`. The Node bridge injects the configured backend token into upstream requests.

### What is Hermes Mobile Host?

Hermes Mobile Host is the Electron companion app that starts the loopback bridge, saves backend configuration, checks Tailscale, configures Tailscale Serve, and shows the phone URL and QR code.

### Should I use Tailscale dev mode or production mode?

Use Tailscale dev mode when actively testing direct Tailnet binding. For regular phone access, keep the bridge bound to `127.0.0.1` and expose it through HTTPS with Tailscale Serve.

## Public Release Checklist

- Do not commit `.env` files or backend descriptors; they can contain API keys.
- Keep the bridge bound to `127.0.0.1` for production and expose it through HTTPS using a trusted tunnel such as Tailscale Serve.
- Keep the package marked `private` and `UNLICENSED` unless reuse and publishing rights are explicitly decided.
- Run `npm test` before publishing release artifacts.

## Security Reporting

Report security issues privately to the repository owner instead of opening a public issue. If GitHub private vulnerability reporting is enabled for the repository, use that channel.
