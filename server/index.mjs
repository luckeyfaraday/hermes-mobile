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
const GATEWAY_REQUEST_TIMEOUT_MS = 30_000
const MOBILE_SESSION_IDLE_MS = 60 * 60 * 1000

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

function tokenPreview(token) {
  if (!token) {
    return null
  }

  return token.length <= 10 ? 'set' : `${token.slice(0, 4)}...${token.slice(-4)}`
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

function readRequestJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []

    req.on('data', chunk => {
      size += chunk.length

      if (size > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }

      chunks.push(chunk)
    })

    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()

      if (!text) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
  })
}

function buildBackendWsUrl(backend) {
  const target = new URL('/api/ws', backend.baseUrl)
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'

  if (backend.token) {
    target.searchParams.set('token', backend.token)
  }

  return target.toString()
}

function connectGateway(backend) {
  if (!backend) {
    return Promise.reject(new Error('Hermes backend is not configured'))
  }

  if (typeof WebSocket !== 'function') {
    return Promise.reject(new Error('This Node runtime does not provide WebSocket support. Use Node 22 or newer.'))
  }

  const socket = new WebSocket(buildBackendWsUrl(backend))
  let nextId = 0
  const pending = new Map()
  const eventHandlers = new Set()

  const cleanupPending = (error = new Error('Hermes gateway connection closed')) => {
    for (const [id, call] of pending) {
      clearTimeout(call.timer)
      call.reject(error)
      pending.delete(id)
    }
  }

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('Could not connect to Hermes gateway')), { once: true })
  })

  socket.addEventListener('message', message => {
    let frame

    try {
      frame = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data))
    } catch {
      return
    }

    if (frame.id !== undefined && frame.id !== null) {
      const call = pending.get(frame.id)

      if (!call) {
        return
      }

      clearTimeout(call.timer)
      pending.delete(frame.id)

      if (frame.error) {
        call.reject(new Error(frame.error.message || 'Hermes RPC failed'))
      } else {
        call.resolve(frame.result)
      }

      return
    }

    if (frame.method === 'event' && frame.params?.type) {
      for (const handler of eventHandlers) {
        handler(frame.params)
      }
    }
  })

  socket.addEventListener('close', () => cleanupPending())

  return opened.then(() => ({
    close() {
      cleanupPending()
      socket.close()
    },
    onEvent(handler) {
      eventHandlers.add(handler)
      return () => eventHandlers.delete(handler)
    },
    request(method, params = {}, timeoutMs = GATEWAY_REQUEST_TIMEOUT_MS) {
      const id = ++nextId

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`request timed out: ${method}`))
        }, timeoutMs)

        pending.set(id, { reject, resolve, timer })
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    }
  }))
}

const mobileSessions = new Map()

function rememberMobileSession(sessionId, gateway, storedSessionId = null, runtimeSessionId = sessionId) {
  const existing = mobileSessions.get(sessionId)

  if (existing?.gateway && existing.gateway !== gateway) {
    existing.gateway.close()
  }

  mobileSessions.set(sessionId, {
    gateway,
    lastUsedAt: Date.now(),
    runtimeSessionId,
    storedSessionId
  })
}

function touchMobileSession(sessionId) {
  const session = mobileSessions.get(sessionId)

  if (session) {
    session.lastUsedAt = Date.now()
  }

  return session
}

function pruneMobileSessions() {
  const cutoff = Date.now() - MOBILE_SESSION_IDLE_MS

  for (const [sessionId, session] of mobileSessions) {
    if (session.lastUsedAt < cutoff) {
      session.gateway.close()
      mobileSessions.delete(sessionId)
    }
  }
}

async function createMobileSession(req, res, backend) {
  if (!backend) {
    sendJson(res, 503, { error: 'Hermes backend is not configured' })
    return true
  }

  let gateway

  try {
    const body = await readRequestJson(req)
    gateway = await connectGateway(backend)
    const created = await gateway.request('session.create', {
      cols: 96,
      ...(typeof body.cwd === 'string' && body.cwd.trim() ? { cwd: body.cwd.trim() } : {})
    })
    const sessionId = created?.session_id

    if (!sessionId) {
      throw new Error('Hermes gateway did not return a session id')
    }

    rememberMobileSession(sessionId, gateway, created.stored_session_id ?? null)
    gateway = null

    sendJson(res, 200, {
      id: sessionId,
      session: {
        id: sessionId,
        title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Mobile chat'
      },
      session_id: sessionId,
      stored_session_id: created.stored_session_id ?? null
    })
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    gateway?.close()
  }

  return true
}

async function createGatewaySession(backend, aliasSessionId = null) {
  const gateway = await connectGateway(backend)

  try {
    const created = await gateway.request('session.create', { cols: 96 })
    const runtimeSessionId = created?.session_id

    if (!runtimeSessionId) {
      throw new Error('Hermes gateway did not return a session id')
    }

    rememberMobileSession(aliasSessionId || runtimeSessionId, gateway, created.stored_session_id ?? null, runtimeSessionId)

    return touchMobileSession(aliasSessionId || runtimeSessionId)
  } catch (error) {
    gateway.close()
    throw error
  }
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function gatewayEventToSse(event) {
  const payload = event.payload || {}

  switch (event.type) {
    case 'message.delta':
      return ['assistant.delta', { delta: payload.text ?? payload.delta ?? '' }]
    case 'reasoning.delta':
    case 'reasoning.available':
      return ['tool.progress', { delta: payload.text ?? payload.delta ?? '', tool_name: '_thinking' }]
    case 'tool.start':
    case 'tool.generating':
      return [
        'tool.started',
        {
          args: payload.args ?? payload.input,
          preview: payload.preview ?? payload.text,
          tool_name: payload.tool_name ?? payload.name ?? payload.tool_id ?? 'tool'
        }
      ]
    case 'tool.progress':
      return [
        'tool.progress',
        {
          delta: payload.delta ?? payload.text ?? payload.preview ?? '',
          tool_name: payload.tool_name ?? payload.name ?? payload.tool_id ?? 'tool'
        }
      ]
    case 'tool.complete':
      return [
        'tool.completed',
        {
          preview: payload.preview ?? payload.text ?? payload.result,
          tool_name: payload.tool_name ?? payload.name ?? payload.tool_id ?? 'tool'
        }
      ]
    case 'message.complete':
      return ['assistant.completed', { content: payload.text ?? payload.rendered ?? payload.content ?? '' }]
    case 'error':
      return ['error', { message: payload.message ?? payload.error ?? 'Hermes stream failed' }]
    default:
      return null
  }
}

async function streamMobileChat(req, res, backend, sessionId) {
  if (!backend) {
    sendJson(res, 503, { error: 'Hermes backend is not configured' })
    return true
  }

  let body

  try {
    body = await readRequestJson(req)
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    return true
  }

  const text = typeof body.message === 'string' ? body.message.trim() : typeof body.text === 'string' ? body.text.trim() : ''

  if (!text) {
    sendJson(res, 400, { error: 'Message is required' })
    return true
  }

  const session = touchMobileSession(sessionId) || (await createGatewaySession(backend, sessionId))
  const gateway = session?.gateway
  const runtimeSessionId = session?.runtimeSessionId || sessionId
  let settled = false

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no'
  })

  if (!gateway) {
    writeSse(res, 'error', { message: 'session not found. Start a new mobile chat and try again.' })
    writeSse(res, 'done', { ok: false })
    res.end()
    return true
  }

  const finish = () => {
    if (settled) {
      return
    }

    settled = true
    writeSse(res, 'done', { ok: true })
    res.end()
  }

  let removeEventHandler = null

  req.on('close', () => {
    settled = true
    removeEventHandler?.()
  })

  try {
    removeEventHandler = gateway.onEvent(event => {
      if (settled || (event.session_id && event.session_id !== runtimeSessionId)) {
        return
      }

      touchMobileSession(sessionId)
      const mapped = gatewayEventToSse(event)

      if (!mapped) {
        return
      }

      writeSse(res, mapped[0], mapped[1])

      if (event.type === 'message.complete' || event.type === 'error') {
        removeEventHandler?.()
        finish()
      }
    })

    writeSse(res, 'run.started', { session_id: sessionId })
    await gateway.request('prompt.submit', { session_id: runtimeSessionId, text })
  } catch (error) {
    removeEventHandler?.()
    if (!settled) {
      writeSse(res, 'error', { message: error instanceof Error ? error.message : String(error) })
      finish()
    }
  }

  return true
}

async function handleMobileBackendCompat(req, res, backend) {
  const url = new URL(req.url, 'http://local.invalid')
  const suffix = url.pathname.slice(PROXY_PREFIX.length)

  if (req.method === 'POST' && suffix === '/api/sessions') {
    return createMobileSession(req, res, backend)
  }

  const chatMatch = suffix.match(/^\/api\/sessions\/([^/]+)\/chat\/stream$/)

  if (req.method === 'POST' && chatMatch) {
    return streamMobileChat(req, res, backend, decodeURIComponent(chatMatch[1]))
  }

  return false
}

function safeStaticPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath)
  const normalized = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '')
  const target = path.join(PUBLIC_DIR, normalized === '/' ? 'index.html' : normalized)
  const resolved = path.resolve(target)

  if (!resolved.startsWith(PUBLIC_DIR)) {
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
    ? { baseUrl: service.baseUrl, source: service.source, token: tokenPreview(service.token) }
    : { configured: false }
}

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

const host = resolveHost()
const port = Number.parseInt(process.env.HERMES_MOBILE_PORT || process.env.PORT || String(DEFAULT_PORT), 10)
const backend = resolveBackend()
const control = resolveControl()
const mobileSessionPruneTimer = setInterval(pruneMobileSessions, Math.min(MOBILE_SESSION_IDLE_MS, 5 * 60 * 1000))

mobileSessionPruneTimer.unref?.()

if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid HERMES_MOBILE_PORT: ${process.env.HERMES_MOBILE_PORT}`)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local.invalid')

    if (url.pathname === '/mobile-api/status') {
      sendJson(res, 200, {
        app: 'hermes-mobile',
        bind: { host, port, tailscaleIp: findTailscaleIp() },
        backend: publicServiceDescriptor(backend),
        control: publicServiceDescriptor(control)
      })
      return
    }

    if (url.pathname === '/mobile-api/backend-status') {
      sendJson(res, 200, await proxyBackendFetch('/api/status', backend))
      return
    }

    if (url.pathname.startsWith(`${PROXY_PREFIX}/`) || url.pathname === PROXY_PREFIX) {
      if (await handleMobileBackendCompat(req, res, backend)) {
        return
      }

      proxyToService(req, res, backend, PROXY_PREFIX, 'backend')
      return
    }

    if (url.pathname.startsWith(`${CONTROL_PROXY_PREFIX}/`) || url.pathname === CONTROL_PROXY_PREFIX) {
      proxyToService(req, res, control, CONTROL_PROXY_PREFIX, 'control')
      return
    }

    serveStatic(req, res)
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.on('error', error => {
  if (error.code === 'EADDRNOTAVAIL' && host !== DEFAULT_HOST) {
    console.error(`[hermes-mobile] Cannot bind ${host}:${port}. Is that interface still available?`)
  }

  throw error
})

server.listen({ host, port }, () => {
  const family = net.isIPv6(host) ? `[${host}]` : host
  console.log(`[hermes-mobile] listening on http://${family}:${port}`)
  console.log(`[hermes-mobile] backend ${backend ? `${backend.baseUrl} (${backend.source})` : 'not configured'}`)
  console.log(`[hermes-mobile] control ${control ? `${control.baseUrl} (${control.source})` : 'not configured'}`)

  if (host === DEFAULT_HOST) {
    console.log('[hermes-mobile] Tailscale HTTPS production pattern:')
    console.log(`  tailscale serve --bg https / http://${DEFAULT_HOST}:${port}`)
  }
})

function closeMobileSessions() {
  clearInterval(mobileSessionPruneTimer)

  for (const session of mobileSessions.values()) {
    session.gateway.close()
  }

  mobileSessions.clear()
}

process.once('SIGINT', closeMobileSessions)
process.once('SIGTERM', closeMobileSessions)
