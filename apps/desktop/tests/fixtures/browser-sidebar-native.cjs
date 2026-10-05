/** Opt-in Electron fixture. Run through run-browser-sidebar-native.mjs, never against daily data. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { app, BrowserWindow, ipcMain, session } = require('electron')
const { DesktopBrowserGuests, DesktopBrowserAutomation, installBrowserReservationIpc, DESKTOP_IPC } = require('./host.cjs')
process.on('uncaughtException', error => { console.error('Uncaught fixture error', error); app.exit(1) })

const root = process.env.DSH_BROWSER_NATIVE_FIXTURE
const mode = process.env.DSH_BROWSER_NATIVE_MODE
assert.ok(root && ['baseline', 'fixed'].includes(mode), 'Only the isolated runner may launch this fixture')
const userData = path.join(root, mode, 'user-data')
fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
app.setPath('userData', userData)
let window, server, automation
const attached = new Map()
const snapshots = new Map()
const published = []
const checks = []
const reservations = new Map()
const creationEvidence = new Map()
const timeout = setTimeout(() => { console.error('Native Sidebar fixture timed out'); app.exit(1) }, 60000)
async function until(predicate, message) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(predicate(), message)
}
app.whenReady().then(async () => {
  const html = '<title>Owned sidebar fixture</title><label>Display name <input aria-label="Display name" id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=\'Saved: \'+document.querySelector(\'#name\').value">Save</button><p id="result">Waiting</p>'
  server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  window = new BrowserWindow({ width: 1000, height: 740, show: true, title: `DSH owned Sidebar fixture ${mode}`,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true } })
  const assertSender = event => { assert.equal(event.sender, window.webContents); assert.equal(event.senderFrame, window.webContents.mainFrame) }
  const guests = new DesktopBrowserGuests(() => 'http://127.0.0.1:19387')
  automation = new DesktopBrowserAutomation({
    reserve: owner => { const reservation = guests.acquire(window.webContents, owner.sessionId); reservations.set(reservation.lease, reservation); return reservation },
    present: (owner, reservation, url) => window.webContents.send(DESKTOP_IPC.browserModelOpen, { sessionId: owner.sessionId, lease: reservation.lease, url }),
    release: lease => guests.release(window.webContents, lease),
    publish: state => { published.push(state); if (!window.webContents.isDestroyed()) window.webContents.send(DESKTOP_IPC.browserState, state) },
    allowed: value => guests.allowedNavigation(value), selectUpload: async () => [],
  })
  installBrowserReservationIpc(ipcMain, assertSender, guests, () => automation)
  // This is the exact old precondition, restored only to establish the failure oracle.
  if (mode === 'baseline') {
    ipcMain.removeHandler(DESKTOP_IPC.browserState)
    ipcMain.handle(DESKTOP_IPC.browserState, (event, lease) => {
      assertSender(event); guests.guest(event.sender, lease); return automation.state(lease)
    })
  }
  let creatingLease
  window.webContents.on('will-attach-webview', (_event, _preferences, params) => {
    creatingLease = typeof params.src === 'string' ? params.src.replace(/^about:blank#/u, '') : undefined
    console.log('Fixture will-attach evidence', JSON.stringify({ lease: creatingLease, partition: params.partition }))
    queueMicrotask(() => { creatingLease = undefined })
  })
  app.on('web-contents-created', (_event, guest) => {
    if (guest.getType() !== 'webview') return
    const reservation = reservations.get(creatingLease)
    const evidence = { guestId: guest.id, type: guest.getType(), creatingLease,
      hostId: guest.hostWebContents?.id, ownerId: window.webContents.id,
      sessionMatches: reservation ? guest.session === session.fromPartition(reservation.partition) : false }
    creationEvidence.set(guest.id, evidence)
    console.log('Fixture creation evidence', JSON.stringify(evidence))
  })
  window.webContents.on('did-attach-webview', (_event, guest) => {
    console.log('Fixture attachment evidence', JSON.stringify({ guestId: guest.id, creationAlreadyObserved: creationEvidence.has(guest.id),
      hostId: guest.hostWebContents?.id, ownerId: window.webContents.id }))
  })
  guests.bind(window, () => () => {}, (lease, guest) => { attached.set(lease, guest); automation.attached(lease, guest) },
    (lease, failure) => automation.failed(lease, failure))
  ipcMain.on('fixture:state', (event, lease, state) => { assertSender(event); snapshots.set(lease, state) })
  const ready = new Promise(resolve => ipcMain.once('fixture:ready', event => { assertSender(event); resolve() }))
  await window.loadFile(path.join(__dirname, 'renderer.html'))
  await ready
  const owner = sessionId => ({ sessionId, activationId: `activation-${sessionId}` })
  const request = (sessionId, operation) => automation.request({ owner: owner(sessionId), operation }, new AbortController().signal)
  const open = async (sessionId, pathname = '/') => {
    const started = performance.now()
    const value = await request(sessionId, { action: 'open', url: origin + pathname })
    return { value, elapsedMs: Math.round(performance.now() - started) }
  }
  if (mode === 'baseline') {
    const result = await open('baseline-session')
    assert.equal(result.value.status, 'unavailable')
    assert.match(result.value.message, /Browser target unavailable/)
    assert.ok(result.elapsedMs < 5000, 'Client failure reporting must terminate the old broken handshake early')
    assert.equal(attached.size, 0)
    await until(() => [...snapshots.values()].some(state => state.error?.description?.includes('Browser target unavailable')), 'Original failure must be visible in the real frame')
    checks.push({ name: 'old state precondition blocks before guest attachment', ...result, attachedGuests: attached.size })
  } else {
    const first = await open('first-session')
    assert.equal(first.value.status, 'delivered', JSON.stringify(first))
    const target = first.value.target
    assert.ok(published.some(state => state.target === target && state.status === 'initializing'))
    assert.ok(attached.has(target))
    const creation = creationEvidence.get(attached.get(target).id)
    assert.equal(creation.creatingLease, target)
    assert.equal(creation.hostId, creation.ownerId)
    assert.equal(creation.sessionMatches, true)
    checks.push({ name: 'public creation event precedes attachment with exact host and partition', ...creation })
    // Opening confirms attachment; the client may still be navigating from its
    // initial about:blank reservation. Wait only on this fixture's native guest.
    await until(() => attached.get(target).getURL() === origin + '/' && !attached.get(target).isLoading(), 'Owned form must finish initial navigation')
    const observation = await request('first-session', { action: 'wait', target, text: 'Display name', timeoutMs: 5000 })
    assert.equal(observation.status, 'observed')
    const input = observation.data.nodes.find(node => node.role === 'textbox' && node.name === 'Display name')
    assert.ok(input)
    const filled = await request('first-session', { action: 'fill', target, snapshot: observation.snapshot, element: input.ref, text: 'Real Sidebar path' })
    assert.equal(filled.status, 'delivered')
    assert.equal(await attached.get(target).executeJavaScript('document.querySelector("#name").value'), 'Real Sidebar path')
    const fresh = await request('first-session', { action: 'observe', target })
    const button = fresh.data.nodes.find(node => node.role === 'button' && node.name === 'Save')
    assert.equal((await request('first-session', { action: 'click', target, snapshot: fresh.snapshot, element: button.ref })).status, 'delivered')
    assert.equal(await attached.get(target).executeJavaScript('document.querySelector("#result").textContent'), 'Saved: Real Sidebar path')
    assert.equal((await request('other-session', { action: 'observe', target })).status, 'stale-target')
    checks.push({ name: 'production client/preload/IPC/guest chain and form readback', target, guestId: attached.get(target).id })
    const concurrent = await Promise.all([open('first-session'), open('second-session')])
    for (const result of concurrent) assert.equal(result.value.status, 'delivered', JSON.stringify(result))
    assert.equal(new Set([target, ...concurrent.map(item => item.value.target)]).size, 3)
    assert.equal(new Set([...attached.values()].map(guest => guest.id)).size, 3)
    checks.push({ name: 'three independent targets including concurrent same-partition guests', guestIds: [...attached.values()].map(guest => guest.id) })
    for (const pathname of ['/client-failure', '/partition-deny']) {
      const before = attached.size
      const result = await open(`failure-${pathname}`, pathname)
      assert.equal(result.value.status, 'unavailable', JSON.stringify(result))
      assert.ok(result.elapsedMs < 5000, 'A known initialization failure must not wait 15 seconds')
      assert.match(result.value.message, pathname === '/client-failure' ? /Fixture presentation container unavailable/ : /partition mismatch/)
      assert.equal(attached.size, before)
      const failed = published.findLast(state => state.sessionId === `failure-${pathname}` && state.failure)
      await until(() => snapshots.get(failed.target)?.error?.description === result.value.message, 'Real frame must retain the Host failure reason')
      assert.equal(snapshots.get(failed.target).loading, false)
      checks.push({ name: pathname.slice(1), ...result })
    }
    fs.writeFileSync(path.join(root, mode, 'owned-window.png'), (await window.webContents.capturePage()).toPNG())
  }
  const result = { status: 'passed', mode, electron: process.versions.electron, platform: process.platform, arch: process.arch,
    completedAt: new Date().toISOString(), checks, boundary: 'Owned Electron window and loopback form; production frame/preload/reservation/guest modules; no account, model, or daily profile' }
  fs.writeFileSync(path.join(root, `${mode}.json`), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}).catch(error => {
  console.error(error)
  fs.writeFileSync(path.join(root, `${mode}.json`), JSON.stringify({ status: 'failed', mode, electron: process.versions.electron,
    completedAt: new Date().toISOString(), error: String(error), checks }, null, 2) + '\n')
  process.exitCode = 1
}).finally(async () => {
  console.log('Fixture cleanup: settling owned automation')
  clearTimeout(timeout)
  await automation?.dispose().catch(error => console.error(error))
  console.log('Fixture cleanup: destroying owned window')
  ipcMain.removeAllListeners('fixture:state')
  window?.destroy()
  console.log('Fixture cleanup: closing loopback server')
  await new Promise(resolve => server?.close(resolve) ?? resolve())
  console.log('Fixture cleanup: complete')
  setImmediate(() => { app.exit(process.exitCode || 0) })
})
