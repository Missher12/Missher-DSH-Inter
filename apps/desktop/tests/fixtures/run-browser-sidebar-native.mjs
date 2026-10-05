/** Opt-in macOS Electron 44 carrier: DSH_BROWSER_NATIVE_ELECTRON_APP=/isolated/Electron.app node <this file>. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Reuse the repository's installed tsx compiler dependency without fetching a tool.
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild')

assert.equal(process.platform, 'darwin', 'This native acceptance runner uses a macOS Electron .app carrier')
const sourceApp = process.env.DSH_BROWSER_NATIVE_ELECTRON_APP
assert.ok(sourceApp, 'Set DSH_BROWSER_NATIVE_ELECTRON_APP to an isolated Electron 44 app; the source is copied, never modified')
const fixtures = dirname(fileURLToPath(import.meta.url))
const repository = resolve(fixtures, '../../../..')
const output = await mkdtemp(join(tmpdir(), 'dsh-browser-sidebar-native-'))
const appCopy = join(output, 'SidebarFixture.app')
const copied = spawnSync('/bin/cp', ['-cR', sourceApp, appCopy], { encoding: 'utf8' })
assert.equal(copied.status, 0, copied.stderr)
const plist = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(appCopy, 'Contents/Info.plist')], { encoding: 'utf8' })
assert.equal(plist.status, 0, plist.stderr)
const executable = join(appCopy, 'Contents/MacOS', plist.stdout.trim())
const resources = join(appCopy, 'Contents/Resources/app')
await mkdir(resources, { recursive: true })
await writeFile(join(resources, 'package.json'), '{"name":"dsh-sidebar-native-fixture","version":"1.0.0","main":"index.cjs"}\n')
await copyFile(join(fixtures, 'browser-sidebar-native.cjs'), join(resources, 'index.cjs'))
const imports = ['browser-guests', 'browser-automation', 'browser-reservation-ipc', 'ipc']
await build({ absWorkingDir: repository, stdin: { contents: imports.map(name => `export * from ${JSON.stringify(join(repository, 'apps/desktop/src', `${name}.ts`))};`).join('\n'), resolveDir: repository, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(resources, 'host.cjs') })
await build({ absWorkingDir: repository, entryPoints: [join(fixtures, 'browser-sidebar-preload.ts')], bundle: true, platform: 'node', format: 'cjs',
  external: ['electron'], outfile: join(resources, 'preload.cjs') })
await build({ absWorkingDir: repository, entryPoints: [join(fixtures, 'browser-sidebar-renderer.ts')], bundle: true, platform: 'browser', format: 'iife',
  tsconfig: join(repository, 'tsconfig.base.client.json'), outfile: join(resources, 'renderer.js') })
await writeFile(join(resources, 'renderer.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Owned Sidebar fixture</title><link rel="stylesheet" href="renderer.css"></head><body><h1>Owned Sidebar fixture</h1><script src="renderer.js"></script></body></html>')
await mkdir(join(output, 'home'))
const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
Object.assign(env, { HOME: join(output, 'home'), DSH_HOME: join(output, 'harness'), DSH_BROWSER_NATIVE_FIXTURE: output })
async function run(mode) {
  let log = ''
  const child = spawn(executable, [], { env: { ...env, DSH_BROWSER_NATIVE_MODE: mode }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const logPath = join(output, `${mode}.log`)
  const receive = value => { log += value; appendFileSync(logPath, value) }
  child.stdout.on('data', receive)
  child.stderr.on('data', receive)
  let killTimer
  const timeout = setTimeout(() => {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') }
        catch (error) { if (error.code !== 'ESRCH') throw error }
      }, 5000)
    }
  }, 75000)
  let code
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }) }
  finally {
    clearTimeout(timeout); clearTimeout(killTimer)
    // Helpers may inherit these pipes after the app exits. Only the app's real
    // exit code decides acceptance; close pipes and its remaining process group.
    child.stdout.destroy(); child.stderr.destroy()
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  assert.equal(code, 0, `${mode} failed; see ${join(output, `${mode}.log`)}\n${log.slice(-3000)}`)
  const result = JSON.parse(await readFile(join(output, `${mode}.json`), 'utf8'))
  assert.match(result.electron, /^44\./u)
  return result
}
const results = {}
for (const mode of ['baseline', 'fixed']) {
  try { results[mode] = { status: 'passed', result: await run(mode) } }
  catch (error) {
    console.error(error)
    let assertions
    try { assertions = JSON.parse(await readFile(join(output, `${mode}.json`), 'utf8')) }
    catch { /* A failed fixture may not have completed its assertions. */ }
    results[mode] = { status: 'failed', error: String(error), assertions }
    process.exitCode = 1
  }
}
const summary = { status: process.exitCode ? 'failed' : 'passed', evidence: output, ...results }
await writeFile(join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
