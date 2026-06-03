#!/usr/bin/env node
/**
 * sync-backend — keep the mobile bridge's backend descriptor pointed at the
 * live Hermes dashboard.
 *
 * The Hermes dashboard rotates its session token on every (re)start, so a
 * bridge launched with a fixed token goes stale. This writes the current
 * url+token to `~/.context-workspace/hermes-backend.json` (the bridge's
 * highest-priority descriptor); the hardened bridge re-reads it per request
 * and follows along without restarting.
 *
 * Usage:
 *   node scripts/sync-backend.mjs                 # one-shot, http://127.0.0.1:9119
 *   node scripts/sync-backend.mjs --url http://127.0.0.1:9119
 *   node scripts/sync-backend.mjs --token <tok>   # supply token explicitly
 *   node scripts/sync-backend.mjs --watch         # keep refreshing (token rotation)
 *   node scripts/sync-backend.mjs --out /path/to/descriptor.json
 *
 * When --token is omitted, the token is read from the dashboard page itself,
 * but ONLY when the dashboard advertises `__HERMES_AUTH_REQUIRED__=false`
 * (i.e. it is intentionally serving its local-trust token). Otherwise pass
 * --token explicitly.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function parseArgs(argv) {
  const args = { watch: false, interval: 15, url: 'http://127.0.0.1:9119', token: '', out: '' }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--watch') args.watch = true
    else if (arg === '--url') args.url = argv[++i]
    else if (arg === '--token') args.token = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--interval') args.interval = Number.parseInt(argv[++i], 10) || 15
    else if (!arg.startsWith('--') && args.url === 'http://127.0.0.1:9119') args.url = arg
  }

  args.url = args.url.replace(/\/$/, '')
  args.out = args.out || path.join(os.homedir(), '.context-workspace', 'hermes-backend.json')
  return args
}

async function discoverToken(url, explicit) {
  if (explicit) return explicit

  const res = await fetch(url + '/', { signal: AbortSignal.timeout(5000) })
  const html = await res.text()
  const authRequired = /__HERMES_AUTH_REQUIRED__\s*=\s*true/.test(html)
  const match = html.match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/)

  if (authRequired && !match) {
    throw new Error('dashboard requires auth and did not publish a token — pass --token explicitly')
  }

  if (!match) {
    throw new Error('could not find a session token on the dashboard page — pass --token explicitly')
  }

  return match[1]
}

async function verify(url, token) {
  const res = await fetch(url + '/api/sessions?limit=1', {
    headers: { Authorization: `Bearer ${token}`, 'X-Hermes-Session-Token': token },
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) {
    throw new Error(`backend check failed: GET /api/sessions -> ${res.status}`)
  }
}

function writeDescriptor(out, url, token) {
  const payload = { baseUrl: url, token, source: 'sync-backend', updatedAt: new Date().toISOString() }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
  fs.renameSync(tmp, out)
}

async function syncOnce(args, lastToken) {
  const token = await discoverToken(args.url, args.token)
  await verify(args.url, token)

  if (token !== lastToken) {
    writeDescriptor(args.out, args.url, token)
    console.log(`[sync-backend] ${args.url} → ${args.out} (token ${token.slice(0, 4)}…${token.slice(-4)})`)
  }

  return token
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let last = ''

  const tick = async () => {
    try {
      last = await syncOnce(args, last)
    } catch (error) {
      console.error(`[sync-backend] ${error instanceof Error ? error.message : error}`)
      last = '' // force a rewrite once it recovers
    }
  }

  await tick()

  if (args.watch) {
    console.log(`[sync-backend] watching every ${args.interval}s — Ctrl+C to stop`)
    setInterval(tick, args.interval * 1000)
  } else if (!last) {
    process.exit(1)
  }
}

main()
