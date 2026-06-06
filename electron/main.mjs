import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { startHermesMobileServer } from '../server/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8642'
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:5274'
const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'
const TAILSCALE_SERVE_PORT = '5274'

let mainWindow
let bridge

function appPath(...parts) {
  return path.join(__dirname, ...parts)
}

function tailscaleBinary() {
  if (process.env.TAILSCALE_PATH) {
    return process.env.TAILSCALE_PATH
  }

  return process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'
}

function execTailscale(args, options = {}) {
  return new Promise(resolve => {
    execFile(
      tailscaleBinary(),
      args,
      {
        timeout: options.timeout || 12_000,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: typeof error?.code === 'number' ? error.code : null,
          error: error ? String(error.message || error) : '',
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        })
      }
    )
  })
}

async function getJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    const text = await response.text()
    let body = text

    try {
      body = text ? JSON.parse(text) : null
    } catch {}

    return { ok: response.ok, status: response.status, body }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function normalizeDnsName(value) {
  return String(value || '').replace(/\.$/, '')
}

async function tailscaleStatus() {
  const result = await execTailscale(['status', '--json'])

  if (!result.ok) {
    return {
      installed: false,
      loggedIn: false,
      error: result.stderr || result.error
    }
  }

  let parsed

  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return {
      installed: true,
      loggedIn: false,
      error: 'Unable to parse tailscale status output.'
    }
  }

  const self = parsed.Self || {}
  const dnsName = normalizeDnsName(self.DNSName)
  const backendState = String(parsed.BackendState || '')

  return {
    installed: true,
    loggedIn: backendState === 'Running',
    backendState,
    deviceName: self.HostName || '',
    tailnet: parsed.CurrentTailnet?.Name || parsed.User?.LoginName || '',
    dnsName,
    httpsUrl: dnsName ? `https://${dnsName}:${TAILSCALE_SERVE_PORT}` : ''
  }
}

async function serveStatus() {
  const result = await execTailscale(['serve', 'status', '--json'])

  if (!result.ok) {
    return { configured: false, error: result.stderr || result.error }
  }

  return { configured: true, raw: result.stdout }
}

async function configureServe() {
  const current = await execTailscale(['serve', '--bg', '--https=' + TAILSCALE_SERVE_PORT, DEFAULT_BRIDGE_URL], { timeout: 20_000 })

  if (current.ok) {
    return current
  }

  const legacy = await execTailscale(['serve', '--bg', 'https:' + TAILSCALE_SERVE_PORT, '/', DEFAULT_BRIDGE_URL], { timeout: 20_000 })

  if (legacy.ok) {
    return legacy
  }

  return {
    ...current,
    error: [current.stderr || current.error, legacy.stderr || legacy.error].filter(Boolean).join('\n')
  }
}

async function writeBackendDescriptor({ baseUrl, token }) {
  const normalizedBaseUrl = String(baseUrl || DEFAULT_BACKEND_URL).trim()
  const normalizedToken = String(token || '').trim()

  if (!normalizedBaseUrl.startsWith('http://') && !normalizedBaseUrl.startsWith('https://')) {
    throw new Error('Backend URL must start with http:// or https://.')
  }

  if (!normalizedToken) {
    throw new Error('API server key is required.')
  }

  const dir = path.join(os.homedir(), '.hermes')
  const filePath = path.join(dir, 'hermes-mobile-backend.json')
  const body = JSON.stringify({ baseUrl: normalizedBaseUrl, token: normalizedToken }, null, 2)

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, `${body}\n`, { mode: 0o600 })

  return { filePath, baseUrl: normalizedBaseUrl }
}

async function collectStatus() {
  const [bridgeStatus, backendStatus, tailscale, serve] = await Promise.all([
    getJson(`${DEFAULT_BRIDGE_URL}/mobile-api/status`),
    getJson(`${DEFAULT_BRIDGE_URL}/mobile-api/backend-status`),
    tailscaleStatus(),
    serveStatus()
  ])

  let qrCode = ''

  if (tailscale.httpsUrl) {
    qrCode = await QRCode.toDataURL(tailscale.httpsUrl, {
      color: {
        dark: '#1c2430',
        light: '#ffffff'
      },
      margin: 1,
      width: 224
    })
  }

  return {
    bridge: bridgeStatus,
    backend: backendStatus,
    tailscale,
    serve,
    qrCode
  }
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: 'Hermes Mobile Host',
    // Matches the onboarding chrome surface (--ui-bg-chrome) per theme so the
    // window doesn't flash a mismatched color before the stylesheet paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d2667' : '#f7f9fe',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: appPath('preload.cjs')
    }
  })

  await mainWindow.loadFile(appPath('onboarding.html'))
}

async function startApp() {
  try {
    bridge = await startHermesMobileServer({ host: '127.0.0.1', port: 5274 })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
  }

  await createMainWindow()
}

ipcMain.handle('status:read', () => collectStatus())
ipcMain.handle('backend:save', (_event, payload) => writeBackendDescriptor(payload || {}))
ipcMain.handle('tailscale:serve', () => configureServe())
ipcMain.handle('tailscale:open-download', () => shell.openExternal(TAILSCALE_DOWNLOAD_URL))
ipcMain.handle('url:open', (_event, url) => {
  const target = String(url || '')

  if (target.startsWith('http://') || target.startsWith('https://')) {
    return shell.openExternal(target)
  }

  return false
})

app.whenReady().then(startApp)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  bridge?.server?.close()
})
