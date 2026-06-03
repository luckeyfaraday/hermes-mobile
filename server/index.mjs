#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')
const DEFAULT_PORT = 5274
const DEFAULT_HOST = '127.0.0.1'
const PROXY_PREFIX = '/hermes-backend'
const CONTROL_PROXY_PREFIX = '/hermes-control'

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8']
])

function isCgnat(address) {
  const parts = String(address).split('.').map(part => Number.parseInt(part, 10))

  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

function findTailscaleIp() {
  const override = String(process.env.HERMES_MOBILE_TAILSCALE_IP || '').trim()

  if (override) {
    if (!isCgnat(override)) {
      throw new Error(`HERMES_MOBILE_TAILSCALE_IP must be in 100.64.0.0/10, got ${override}.`)
    }

    return override
  }

  let interfaces

  try {
    interfaces = os.networkInterfaces()
  } catch {
    return null
  }

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : entry.family === 4 ? 'IPv4' : String(entry.family)

      if (family === 'IPv4' && !entry.internal && isCgnat(entry.address)) {
        return entry.address
      }
    }
  }

  return null
}

function resolveHost() {
  const mode = String(process.env.HERMES_MOBILE_HOST || process.env.HERMES_HOST || process.env.APP_HOST || '').trim()

  if (!mode) {
    return DEFAULT_HOST
  }

  if (mode.toLowerCase() === 'tailscale') {
    const tailscaleIp = findTailscaleIp()

    if (!tailscaleIp) {
      throw new Error(
        'HERMES_MOBILE_HOST=tailscale was requested, but no 100.64.0.0/10 Tailscale IPv4 address was found. ' +
          'If interface enumeration is restricted, set HERMES_MOBILE_TAILSCALE_IP=100.x.y.z.'
      )
    }

    return tailscaleIp
  }

  return mode
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function candidateBackendDescriptorPaths() {
  const home = os.homedir()

  return [
    process.env.HERMES_MOBILE_BACKEND_FILE,
    path.join(home, '.context-workspace', 'hermes-backend.json'),
    path.join(home, '.context-workspace', 'backend.json'),
    path.join(home, '.context-workspace', 'desktop-backend.json'),
    path.join(home, '.hermes', 'hermes-mobile-backend.json')
  ].filter(Boolean)
}

function candidateControlDescriptorPaths() {
  const home = os.homedir()

  return [
    process.env.HERMES_MOBILE_CONTROL_FILE,
    path.join(home, '.context-workspace', 'hermes-control.json'),
    path.join(home, '.context-workspace', 'electron-control.json'),
    path.join(home, '.context-workspace', 'control.json'),
    path.join(home, '.hermes', 'hermes-mobile-control.json')
  ].filter(Boolean)
}

function stringField(source, keys) {
  for (const key of keys) {
    const value = source?.[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

function normalizeBackendDescriptor(raw, source) {
  const baseUrl = stringField(raw, ['baseUrl', 'base_url', 'url', 'origin', 'target', 'targetUrl'])
  const token = stringField(raw, ['token', 'bearerToken', 'bearer_token', 'sessionToken', 'session_token', 'authToken'])

  if (!baseUrl) {
    return null
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    source,
    token
  }
}

function resolveBackend() {
  if (process.env.HERMES_MOBILE_BACKEND_URL || process.env.HERMES_DESKTOP_REMOTE_URL) {
    return {
      baseUrl: normalizeBaseUrl(process.env.HERMES_MOBILE_BACKEND_URL || process.env.HERMES_DESKTOP_REMOTE_URL),
      source: 'env',
      token: String(process.env.HERMES_MOBILE_BACKEND_TOKEN || process.env.HERMES_DESKTOP_REMOTE_TOKEN || '').trim()
    }
  }

  for (const filePath of candidateBackendDescriptorPaths()) {
    const descriptor = normalizeBackendDescriptor(readJsonFile(filePath), filePath)

    if (descriptor) {
      return descriptor
    }
  }

  return null
}

function resolveControl() {
  if (process.env.HERMES_MOBILE_CONTROL_URL) {
    return {
      baseUrl: normalizeBaseUrl(process.env.HERMES_MOBILE_CONTROL_URL),
      source: 'env',
      token: String(process.env.HERMES_MOBILE_CONTROL_TOKEN || '').trim()
    }
  }

  for (const filePath of candidateControlDescriptorPaths()) {
    const descriptor = normalizeBackendDescriptor(readJsonFile(filePath), filePath)

    if (descriptor) {
      return descriptor
    }
  }

  return null
}

function normalizeBaseUrl(value) {
  const url = new URL(value)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported backend protocol: ${url.protocol}`)
  }

  url.hash = ''
  url.search = ''

  return url.toString().replace(/\/$/, '')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8'
  })
  res.end(body)
}

function safeStaticPath(urlPath) {
  let decodedPath

  try {
    decodedPath = decodeURIComponent(urlPath)
  } catch {
    return null
  }

  const normalized = path.normalize(decodedPath).replace(/^[/\\]+/, '').replace(/^(\.\.[/\\])+/, '')
  const target = path.resolve(PUBLIC_DIR, normalized || 'index.html')
  const resolved = path.resolve(target)
  const relative = path.relative(PUBLIC_DIR, resolved)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }

  return resolved
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://local.invalid')
  const filePath = safeStaticPath(url.pathname)

  if (!filePath) {
    sendJson(res, 403, { error: 'Forbidden' })
    return
  }

  const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() ? path.join(filePath, 'index.html') : filePath

  fs.readFile(finalPath, (error, data) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (fallbackError, fallback) => {
        if (fallbackError) {
          sendJson(res, 404, { error: 'Not found' })
          return
        }

        res.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/html; charset=utf-8'
        })
        res.end(fallback)
      })
      return
    }

    const contentType = MIME_TYPES.get(path.extname(finalPath).toLowerCase()) || 'application/octet-stream'
    res.writeHead(200, {
      'Cache-Control': finalPath.endsWith('service-worker.js') ? 'no-store' : 'public, max-age=60',
      'Content-Type': contentType
    })
    res.end(data)
  })
}

function publicServiceDescriptor(service) {
  return service
    ? { baseUrl: service.baseUrl, source: publicServiceSource(service), tokenConfigured: Boolean(service.token) }
    : { configured: false }
}

function publicServiceSource(service) {
  return service.source === 'env' ? 'env' : 'descriptor'
}

// Transparent reverse proxy to the resolved Hermes backend. The browser never
// sees the token; we strip any client-supplied auth and inject the descriptor's
// key as `Authorization: Bearer …` + `X-Hermes-Session-Token` server-side.
//
// Every `/hermes-backend/*` request — including `POST /api/sessions` and the
// `POST /api/sessions/{id}/chat/stream` SSE stream — flows through here to the
// gateway's api_server platform (gateway/platforms/api_server.py), which serves
// the REST + SSE contract the front-end (`public/app.js`) is written against.
// The response (text/event-stream included) is piped straight back, so no
// event translation lives in the bridge.
function proxyToService(req, res, service, prefix, name) {
  if (!service) {
    sendJson(res, 503, {
      error: `Hermes ${name} is not configured`,
      hint: `Set HERMES_MOBILE_${name.toUpperCase()}_URL and HERMES_MOBILE_${name.toUpperCase()}_TOKEN, or write a ~/.context-workspace descriptor.`
    })
    return
  }

  const incomingUrl = new URL(req.url, 'http://local.invalid')
  const suffix = incomingUrl.pathname.slice(prefix.length) || '/'
  const target = new URL(suffix + incomingUrl.search, service.baseUrl)
  const client = target.protocol === 'https:' ? https : http
  const headers = { ...req.headers }

  delete headers.host
  delete headers.authorization
  delete headers['x-hermes-session-token']
  delete headers['content-length']
  // This bridge is a server-side proxy client, not a browser, and the
  // browser→bridge hop is same-origin — so the upstream must not treat us as a
  // cross-origin browser. The gateway api_server's CORS guard returns 403 for
  // any forwarded `Origin` when API_SERVER_CORS_ORIGINS is unset, which would
  // break every POST/PUT (chat, session create, toggles) while same-origin GETs
  // (no Origin header) slip through. Strip Origin/Referer so we present as the
  // non-browser client we actually are.
  delete headers.origin
  delete headers.referer

  if (service.token) {
    headers.authorization = `Bearer ${service.token}`
    headers['x-hermes-session-token'] = service.token
  }

  const upstream = client.request(
    target,
    {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(10 * 60 * 1000)
    },
    upstreamRes => {
      const responseHeaders = { ...upstreamRes.headers }
      delete responseHeaders['content-security-policy']
      delete responseHeaders['content-length']
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders)
      upstreamRes.pipe(res)
    }
  )

  upstream.on('error', error => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: error.message })
    } else {
      res.destroy(error)
    }
  })

  req.pipe(upstream)
}

async function proxyBackendFetch(pathname, backend) {
  if (!backend) {
    return { ok: false, error: 'backend not configured' }
  }

  const target = new URL(pathname, backend.baseUrl)
  const headers = backend.token
    ? {
        Authorization: `Bearer ${backend.token}`,
        'X-Hermes-Session-Token': backend.token
      }
    : {}

  const response = await fetch(target, { headers, signal: AbortSignal.timeout(8_000) })
  const text = await response.text()
  let body = text

  try {
    body = text ? JSON.parse(text) : null
  } catch {}

  return { ok: response.ok, status: response.status, body }
}

// Re-resolve the backend/control descriptors on a short TTL so the bridge
// follows a Hermes restart (new port/token written to a descriptor) without
// needing its own restart. Env-var config is constant, so it stays pinned by
// design; descriptor-file config becomes live. Resolution never throws — a
// half-written or invalid descriptor keeps the last known-good value.
const RESOLVE_TTL_MS = 2000

function makeResolver(resolve, label) {
  let cache = { at: 0, value: undefined }
  let lastKey

  return function getService() {
    const now = Date.now()

    if (cache.value !== undefined && now - cache.at < RESOLVE_TTL_MS) {
      return cache.value
    }

    let value

    try {
      value = resolve()
    } catch {
      value = cache.value ?? null
    }

    cache = { at: now, value }
    const key = value ? `${value.baseUrl}|${value.source}` : 'none'

    if (key !== lastKey) {
      lastKey = key
      console.log(`[hermes-mobile] ${label} → ${value ? `${value.baseUrl} (${publicServiceSource(value)})` : 'not configured'}`)
    }

    return value
  }
}

const getBackend = makeResolver(resolveBackend, 'backend')
const getControl = makeResolver(resolveControl, 'control')

function createRequestHandler({ host, port }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local.invalid')

      if (url.pathname === '/mobile-api/status') {
        sendJson(res, 200, {
          app: 'hermes-mobile',
          bind: { host, port, tailscaleIp: findTailscaleIp() },
          backend: publicServiceDescriptor(getBackend()),
          control: publicServiceDescriptor(getControl())
        })
        return
      }

      if (url.pathname === '/mobile-api/backend-status') {
        sendJson(res, 200, await proxyBackendFetch('/api/status', getBackend()))
        return
      }

      if (url.pathname.startsWith(`${PROXY_PREFIX}/`) || url.pathname === PROXY_PREFIX) {
        proxyToService(req, res, getBackend(), PROXY_PREFIX, 'backend')
        return
      }

      if (url.pathname.startsWith(`${CONTROL_PROXY_PREFIX}/`) || url.pathname === CONTROL_PROXY_PREFIX) {
        proxyToService(req, res, getControl(), CONTROL_PROXY_PREFIX, 'control')
        return
      }

      serveStatic(req, res)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function startHermesMobileServer(options = {}) {
  const host = options.host || resolveHost()
  const port = Number.parseInt(String(options.port || process.env.HERMES_MOBILE_PORT || process.env.PORT || DEFAULT_PORT), 10)

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid HERMES_MOBILE_PORT: ${process.env.HERMES_MOBILE_PORT}`)
  }

  const server = http.createServer(createRequestHandler({ host, port }))

  return new Promise((resolve, reject) => {
    const handleListenError = error => {
      if (error.code === 'EADDRNOTAVAIL' && host !== DEFAULT_HOST) {
        console.error(`[hermes-mobile] Cannot bind ${host}:${port}. Is that interface still available?`)
      }

      reject(error)
    }

    server.once('error', handleListenError)
    server.listen({ host, port }, () => {
      server.off('error', handleListenError)
      server.on('error', error => {
        console.error(error instanceof Error ? error.message : String(error))
      })

      const family = net.isIPv6(host) ? `[${host}]` : host
      const backend = getBackend()
      const control = getControl()
      const url = `http://${family}:${port}`

      console.log(`[hermes-mobile] listening on ${url}`)
      console.log(`[hermes-mobile] backend ${backend ? `${backend.baseUrl} (${publicServiceSource(backend)})` : 'not configured'}`)
      console.log(`[hermes-mobile] control ${control ? `${control.baseUrl} (${publicServiceSource(control)})` : 'not configured'}`)
      console.log('[hermes-mobile] backend re-resolves per request — update a descriptor to follow a Hermes restart without restarting the bridge.')

      if (host === DEFAULT_HOST) {
        console.log('[hermes-mobile] Tailscale HTTPS production pattern:')
        console.log(`  tailscale serve --bg https / http://${DEFAULT_HOST}:${port}`)
      }

      resolve({ server, host, port, url })
    })
  })
}

async function runCli() {
  try {
    await startHermesMobileServer()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli()
}
