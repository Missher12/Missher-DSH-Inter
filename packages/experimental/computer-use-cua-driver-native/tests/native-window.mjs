/** Opt-in native SDK acceptance on one disposable Electron app; never selects existing windows. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { CuaDriver, SessionPermissionMode, DriverAuthorizationAction, createTrustedSession } from '@trycua/cua-driver'

if (process.env.DSH_COMPUTER_USE_NATIVE_ACTION_E2E !== '1') throw new Error('Explicit DSH_COMPUTER_USE_NATIVE_ACTION_E2E=1 is required')
if (process.platform !== 'darwin') throw new Error('This owned Electron fixture currently requires macOS')
const application = await realpath(process.env.DSH_NATIVE_ELECTRON_APP ?? '')
const temporary = await realpath(tmpdir())
const sharedTemporary = await realpath('/tmp')
if ((!application.startsWith(`${temporary}${sep}dsh-cbu-`) && !application.startsWith(`${sharedTemporary}${sep}dsh-cbu-`)) || basename(application) !== 'Electron.app') throw new Error('Use only a disposable dsh-cbu-* Electron.app under a temporary directory')
const evidenceDirectory = resolve(process.env.DSH_NATIVE_EVIDENCE_DIR ?? '')
if (!process.env.DSH_NATIVE_EVIDENCE_DIR) throw new Error('An explicit fixture evidence directory is required')
await mkdir(evidenceDirectory, { recursive: true })
const root = await mkdtemp(join(temporary, 'dsh-cbu-native-window-'))
const title = `DSH Native Fixture ${randomUUID()}`
const entry = join(application, 'Contents/Resources/app/index.cjs')
const executableName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(application, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
if (basename(executableName) !== executableName) throw new Error('Invalid disposable application executable')
const original = await readFile(entry)
const fixture = await readFile(new URL('./fixtures/native-window.cjs', import.meta.url))
const sdkManifest = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.resolve('@trycua/cua-driver'))), '../package.json'), 'utf8'))
const evidence = { checkedAt: new Date().toISOString(), sdkVersion: sdkManifest.version, host: { node: process.version, platform: process.platform, architecture: process.arch }, title, checks: [], authorizationRequests: 0, status: 'running' }
let child, driver, surface, target, commandId = 0, childDiagnostics = ''
const record = (check, status, details = {}) => { evidence.checks.push({ check, status, ...details }); console.log(JSON.stringify({ check, status, ...details })) }
const waitUntil = async (read, predicate, timeout = 8_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    let value
    try { value = await read() } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (value !== undefined && predicate(value)) return value
    await delay(100)
  }
  throw new Error('Owned native fixture timed out')
}
const readJson = async name => JSON.parse(await readFile(join(root, name), 'utf8'))
const state = () => readJson('state.json')
const command = async action => {
  const id = ++commandId
  await writeFile(join(root, 'command.json'), JSON.stringify({ id, action }))
  await waitUntil(() => readJson('command-result.json'), value => value.id === id)
}
const metadata = result => ({ isError: result.isError, ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }), ...(result.action === undefined ? {} : { actionEffect: Number(result.action.effect) }) })
const structured = result => result.structuredJson === undefined ? JSON.parse(result.rawJson).structuredContent : JSON.parse(result.structuredJson)
const refused = result => result.isError || result.errorCode !== undefined || Number(result.action?.effect) === 4
const call = async (name, args) => {
  assert.equal(args.pid, evidence.pid, 'Every native operation must select the owned process')
  if (name !== 'list_windows') assert.equal(args.window_id, target, 'Every native operation must select the exact owned window')
  return surface.callTool(name, JSON.stringify(args), { signal: AbortSignal.timeout(25_000) })
}
const snapshot = async (capture = false) => {
  const result = await call('get_window_state', { pid: evidence.pid, window_id: target, include_screenshot: capture, max_elements: 150, max_dimension: 1000 })
  if (refused(result)) { record('owned-window-snapshot', 'blocked', metadata(result)); throw new Error('Owned window snapshot refused') }
  const data = structured(result)
  assert.equal(data.pid, evidence.pid)
  assert.equal(data.window_id, target)
  assert.equal(data.window_title, title)
  if (capture && result.images[0] !== undefined) {
    await writeFile(join(evidenceDirectory, 'p0-native-owned-window.png'), Buffer.from(result.images[0].dataBase64, 'base64'))
    record('exact-window-screenshot', 'passed', { width: data.screenshot_width, height: data.screenshot_height })
  }
  return data
}
const find = (data, label) => {
  const element = data.elements?.find(item => item.label === label)
  if (element === undefined || element.element_token == null) throw new Error(`Owned fixture element unavailable: ${label}`)
  return element
}
const pixel = (data, element) => {
  assert.ok(element.frame && data.window_bounds && data.screenshot_scale)
  return { x: (element.frame.x + element.frame.w / 2 - data.window_bounds.x) * data.screenshot_scale, y: (element.frame.y + element.frame.h / 2 - data.window_bounds.y) * data.screenshot_scale }
}

try {
  await writeFile(entry, fixture)
  const environment = { ...process.env, DSH_NATIVE_WINDOW_ROOT: root, DSH_NATIVE_WINDOW_TITLE: title }
  delete environment.ELECTRON_RUN_AS_NODE
  child = spawn(join(application, 'Contents/MacOS', executableName), [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  evidence.fixturePid = child.pid
  child.once('exit', (code, signal) => { evidence.fixtureExit = { code, signal } })
  child.once('error', error => { evidence.fixtureSpawnError = error.message })
  child.stderr.on('data', data => { childDiagnostics = (childDiagnostics + String(data)).slice(-8_000) })
  child.stdout.on('data', data => { childDiagnostics = (childDiagnostics + String(data)).slice(-8_000) })
  const ready = await waitUntil(async () => {
    if (evidence.fixtureSpawnError !== undefined) throw new Error(evidence.fixtureSpawnError)
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited before ready: ${String(child.exitCode ?? child.signalCode)}`)
    return readJson('ready.json')
  }, value => value.title === title, 20_000)
  assert.equal(ready.pid, child.pid)
  evidence.pid = ready.pid
  evidence.electron = ready.electron
  driver = CuaDriver.createConfiguredWithAuthorizationHost({ claudeCodeCompatibility: false, authorization: { allowedModes: [SessionPermissionMode.Standard], compatibilityMode: SessionPermissionMode.Standard, unrestrictedAcknowledged: false, maxSessionTtlSeconds: 180n, maxIdleTtlSeconds: 90n } }, { authorize: async (request) => { evidence.authorizationRequests++; return { action: DriverAuthorizationAction.Cancel, requestDigest: request.requestDigest } } })
  surface = createTrustedSession(driver, { publicSession: randomUUID(), mode: SessionPermissionMode.Standard, ttlSeconds: 180n, idleTtlSeconds: 90n })
  const listed = await call('list_windows', { pid: evidence.pid })
  assert.equal(refused(listed), false)
  const windows = structured(listed).windows
  assert.ok(windows.every(window => window.pid === evidence.pid))
  const owned = windows.find(window => window.title === title)
  assert.ok(owned, 'Find only the newly created fixture window by exact title and known pid')
  target = owned.window_id
  evidence.windowId = target
  record('pid-filtered-owned-window', 'passed')
  const originalSnapshot = await snapshot(true)
  const originalButton = find(originalSnapshot, 'Record fixture value')
  await snapshot()
  const stale = await call('click', { pid: evidence.pid, window_id: target, element_token: originalButton.element_token, delivery_mode: 'background' })
  record('stale-element-token', refused(stale) ? 'passed' : 'failed', metadata(stale))
  assert.ok(refused(stale))
  assert.equal((await state()).clicks, 0)

  const text = 'native-fixture-verified'
  let latest = await snapshot()
  const typed = await call('type_text', { pid: evidence.pid, window_id: target, element_token: find(latest, 'Fixture input').element_token, text, delivery_mode: 'background' })
  await delay(250)
  let actual = await state()
  record('background-AX-input', actual.value === text ? 'passed' : 'unconfirmed', { ...metadata(typed), independentlyReadBack: actual.value === text })
  if (actual.value !== text) {
    assert.equal(actual.value, '', 'Never repeat input after partial delivery')
    latest = await snapshot(true)
    const typedPixel = await call('type_text', { pid: evidence.pid, window_id: target, ...pixel(latest, find(latest, 'Fixture input')), text, delivery_mode: 'background' })
    await delay(250)
    actual = await state()
    record('background-pixel-input', actual.value === text ? 'passed' : 'unconfirmed', { ...metadata(typedPixel), independentlyReadBack: actual.value === text })
  }
  if (actual.value !== text) {
    assert.equal(actual.value, '', 'Never repeat input after partial delivery')
    latest = await snapshot(true)
    const typedForeground = await call('type_text', { pid: evidence.pid, window_id: target, ...pixel(latest, find(latest, 'Fixture input')), text, delivery_mode: 'foreground' })
    await delay(250)
    actual = await state()
    record('foreground-exact-window-input', actual.value === text ? 'passed' : 'blocked', { ...metadata(typedForeground), independentlyReadBack: actual.value === text })
  }
  assert.equal(actual.value, text, 'Independent fixture DOM must contain the exact native input')
  latest = await snapshot()
  const clicked = await call('click', { pid: evidence.pid, window_id: target, element_token: find(latest, 'Record fixture value').element_token, delivery_mode: 'background' })
  actual = await waitUntil(state, value => value.clicks === 1)
  assert.equal(actual.result, text)
  record('click-and-independent-renderer-readback', 'passed', { ...metadata(clicked), value: actual.result, clicks: actual.clicks })
  await snapshot(true)

  await command('hide')
  await snapshot()
  const hidden = await call('click', { pid: evidence.pid, window_id: target, x: 100, y: 100, delivery_mode: 'background' })
  record('hidden-window-pixel-refusal', refused(hidden) ? 'passed' : 'failed', metadata(hidden))
  assert.ok(refused(hidden), 'An unavailable hidden-window pixel route must fail closed')
  await command('replace')
  const missing = await call('get_window_state', { pid: evidence.pid, window_id: target, include_screenshot: false })
  record('closed-window-target-refusal', refused(missing) ? 'passed' : 'failed', metadata(missing))
  assert.ok(refused(missing))
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'blocked'
  evidence.failure = { message: error.message }
  const fixtureError = await readJson('fixture-error.json').catch(() => undefined)
  if (fixtureError !== undefined) evidence.failure.fixture = fixtureError
  if (childDiagnostics !== '') evidence.failure.fixtureDiagnostics = childDiagnostics
  process.exitCode = 1
} finally {
  const cleanupErrors = []
  const cleanup = async (name, operation) => { try { await operation() } catch (error) { cleanupErrors.push({ stage: name, message: error.message }) } }
  await cleanup('native-session', () => surface?.close())
  if (driver !== undefined) {
    await cleanup('native-shutdown', () => driver.shutdown())
    await cleanup('native-handle', () => driver.uniffiDestroy())
  }
  if (child !== undefined && child.exitCode === null) {
    await writeFile(join(root, 'command.json'), JSON.stringify({ id: ++commandId, action: 'quit' }))
    await delay(250)
    if (child.exitCode === null) child.kill('SIGTERM')
    await waitUntil(async () => child.exitCode !== null || child.signalCode !== null, value => value).catch(() => {})
  }
  await cleanup('fixture-entry-restore', () => writeFile(entry, original))
  await cleanup('fixture-data', () => rm(root, { recursive: true, force: true }))
  if (cleanupErrors.length !== 0) { evidence.status = 'blocked'; evidence.cleanupErrors = cleanupErrors; process.exitCode = 1 }
  evidence.finishedAt = new Date().toISOString()
  evidence.cleanup = { fixtureClosed: child === undefined || child.exitCode !== null || child.signalCode !== null, entryRestored: !cleanupErrors.some(error => error.stage === 'fixture-entry-restore'), nativeSessionClosed: !cleanupErrors.some(error => error.stage === 'native-session') }
  await writeFile(join(evidenceDirectory, 'p0-native-window.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ status: evidence.status, failure: evidence.failure, cleanup: evidence.cleanup }))
}
