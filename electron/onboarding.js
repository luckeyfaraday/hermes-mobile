const els = {
  backendDot: document.getElementById('backend-dot'),
  backendForm: document.getElementById('backend-form'),
  backendText: document.getElementById('backend-text'),
  backendToken: document.getElementById('backend-token'),
  backendUrl: document.getElementById('backend-url'),
  bridgeDot: document.getElementById('bridge-dot'),
  bridgeText: document.getElementById('bridge-text'),
  configureServe: document.getElementById('configure-serve'),
  descriptorPath: document.getElementById('descriptor-path'),
  log: document.getElementById('log'),
  openUrl: document.getElementById('open-url'),
  phoneUrl: document.getElementById('phone-url'),
  qrWrap: document.getElementById('qr-wrap'),
  refresh: document.getElementById('refresh'),
  serveState: document.getElementById('serve-state'),
  tailscaleDot: document.getElementById('tailscale-dot'),
  tailscaleDownload: document.getElementById('tailscale-download'),
  tailscaleText: document.getElementById('tailscale-text')
}

let currentPhoneUrl = ''

function log(line) {
  const stamp = new Date().toLocaleTimeString()
  els.log.textContent = [`[${stamp}] ${line}`, els.log.textContent].filter(Boolean).join('\n')
}

function setDot(el, state) {
  el.className = `status-dot ${state}`
}

function setBusy(busy) {
  els.refresh.disabled = busy
  els.configureServe.disabled = busy
}

function renderQr(dataUrl) {
  if (!dataUrl) {
    els.qrWrap.innerHTML = '<div class="qr-empty">No URL yet</div>'
    return
  }

  els.qrWrap.innerHTML = `<img alt="Phone access QR code" src="${dataUrl}">`
}

function renderStatus(status) {
  const bridgeOk = Boolean(status.bridge?.ok)
  setDot(els.bridgeDot, bridgeOk ? 'ok' : 'bad')
  els.bridgeText.textContent = bridgeOk ? 'Local bridge is running on 127.0.0.1:5274.' : status.bridge?.error || 'Local bridge is unavailable.'

  const backendConfigured = Boolean(status.bridge?.body?.backend && status.bridge.body.backend.configured !== false)
  const backendOk = Boolean(status.backend?.ok && status.backend?.body?.ok !== false)
  setDot(els.backendDot, backendOk ? 'ok' : backendConfigured ? 'waiting' : 'bad')
  els.backendText.textContent = backendOk
    ? 'Hermes API server accepted the bridge request.'
    : backendConfigured
      ? `Configured, but not reachable yet (${status.backend?.status || 'pending'}).`
      : 'Save the Hermes API server URL and key.'

  const tailscale = status.tailscale || {}
  setDot(els.tailscaleDot, tailscale.loggedIn ? 'ok' : tailscale.installed ? 'waiting' : 'bad')
  els.tailscaleText.textContent = tailscale.loggedIn
    ? `${tailscale.deviceName || 'This device'} is connected${tailscale.tailnet ? ` to ${tailscale.tailnet}` : ''}.`
    : tailscale.installed
      ? `Installed, but not connected (${tailscale.backendState || 'stopped'}).`
      : 'Tailscale CLI was not found.'

  currentPhoneUrl = tailscale.httpsUrl || ''
  els.phoneUrl.textContent = currentPhoneUrl || 'Connect Tailscale to get a phone URL.'
  els.openUrl.disabled = !currentPhoneUrl
  els.serveState.textContent = status.serve?.configured ? 'Serve configured' : 'Serve not configured'
  els.tailscaleDownload.disabled = Boolean(tailscale.installed)
  renderQr(status.qrCode)
}

async function refreshStatus() {
  setBusy(true)

  try {
    const status = await window.hermesHost.readStatus()
    renderStatus(status)
    log('Status refreshed.')
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
  } finally {
    setBusy(false)
  }
}

els.backendForm.addEventListener('submit', async event => {
  event.preventDefault()
  setBusy(true)

  try {
    const result = await window.hermesHost.saveBackend({
      baseUrl: els.backendUrl.value,
      token: els.backendToken.value
    })
    els.backendToken.value = ''
    els.descriptorPath.textContent = result.filePath
    log(`Backend descriptor saved for ${result.baseUrl}.`)
    await refreshStatus()
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
  } finally {
    setBusy(false)
  }
})

els.configureServe.addEventListener('click', async () => {
  setBusy(true)

  try {
    const result = await window.hermesHost.configureServe()
    log(result.ok ? 'Tailscale HTTPS Serve configured.' : result.stderr || result.error || 'Unable to configure Tailscale Serve.')
    await refreshStatus()
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
  } finally {
    setBusy(false)
  }
})

els.openUrl.addEventListener('click', () => {
  if (currentPhoneUrl) {
    window.hermesHost.openUrl(currentPhoneUrl)
  }
})

els.tailscaleDownload.addEventListener('click', () => {
  window.hermesHost.openDownload()
})

els.refresh.addEventListener('click', refreshStatus)

refreshStatus()
