/** Launch a packaged community shell in an isolated profile and inspect its actual renderer. */
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (!['linux', 'win32'].includes(process.platform)) throw new Error('Shell smoke requires Linux or Windows')
const windows = process.platform === 'win32'
const executable = resolve(process.argv[2])
const output = resolve(process.argv[3])
const executableStat = await stat(executable)
if (!executableStat.isFile() || (!windows && !(executableStat.mode & 0o111))) throw new Error('Desktop executable must be an executable file')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'missher-desktop-smoke-'))
const diagnostic = join(root, 'fatal.txt')
const child = spawn(executable, ['--remote-debugging-port=0'], {
  detached: !windows,
  env: { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    ...(windows ? { APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'cache') } : {}),
    DSH_HOME: join(root, 'harness'), DSH_DESKTOP_DIAGNOSTIC_FILE: diagnostic, DSH_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let spawnFailure
const closed = once(child, 'close').catch(error => { spawnFailure = error })
let log = ''
child.stdout.on('data', data => { log += data })
child.stderr.on('data', data => { log += data })
let socket
try {
  const deadline = Date.now() + 90_000
  let page
  while (Date.now() < deadline) {
    if (spawnFailure) throw spawnFailure
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Desktop exited: ${log}`)
    const endpoint = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+)\//u.exec(log)?.[1]
    if (endpoint) {
      const targets = await fetch(endpoint.replace('ws:', 'http:') + '/json/list').then(response => response.json())
      page = targets.find(target => target.type === 'page' && target.url !== 'about:blank')
      if (page) break
    }
    await delay(200)
  }
  if (!page) throw new Error(`Desktop did not create a renderer: ${log}`)
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  async function command(method, params = {}) {
    const id = ++nextId
    return new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error(`CDP timeout: ${method}`)) }, 10_000)
      const receive = event => {
        const message = JSON.parse(event.data)
        if (message.id !== id) return
        clearTimeout(timeout)
        socket.removeEventListener('message', receive)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolveResult(message.result)
      }
      socket.addEventListener('message', receive)
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  let document
  while (Date.now() < deadline) {
    const result = await command('Runtime.evaluate', { expression: '({ready:document.readyState,text:document.body?.innerText??"",width:innerWidth,height:innerHeight})', returnByValue: true })
    document = result.result.value
    if (document?.ready === 'complete' && document.text.trim().length > 10) break
    await delay(200)
  }
  if (document?.ready !== 'complete' || document.text.trim().length <= 10 || document.width <= 0 || document.height <= 0) throw new Error('Desktop renderer is empty')
  const failure = await readFile(diagnostic, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  if (failure) throw new Error(failure)
  await command('Page.enable')
  await command('Page.bringToFront')
  const screenshot = await command('Page.captureScreenshot', { format: 'png', fromSurface: false })
  const png = Buffer.from(screenshot.data, 'base64')
  if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.length < 1000) throw new Error('Desktop screenshot is not a usable PNG')
  await writeFile(join(output, 'desktop.png'), Buffer.from(screenshot.data, 'base64'))
  await writeFile(join(output, 'desktop-shell.json'), JSON.stringify({ platform: process.platform, arch: process.arch,
    renderer: page.url.replace(/([?&]token=)[^&]+/gu, '$1[redacted]'), document, sandboxDisabled: false, modelCalled: false }, null, 2) + '\n')
  console.log('Packaged Desktop renderer and PNG verified')
} finally {
  socket?.close()
  if (child.pid !== undefined) {
    if (windows) {
      if (child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const timer = setTimeout(() => { if (!windows) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }, 10_000)
    try { await closed } finally { clearTimeout(timer) }
  }
  await writeFile(join(output, 'desktop-shell.log'), log.replace(/([?&]token=)[^\s&]+/gu, '$1[redacted]'))
  await rm(root, { recursive: true, force: true })
}
