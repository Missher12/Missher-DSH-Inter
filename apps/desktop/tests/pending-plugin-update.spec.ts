/** Real temporary profile bytes exercise activation, failed moves and interrupted-journal recovery. */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import {
  PENDING_UPDATE_PATH, UPDATE_BASE_FILES, UPDATE_REPLACEMENT_FILES, readUpdateBaseBindings,
  readUpdateCandidateBindings, type PendingBundleUpdate,
} from '@deepseek-ai/dsh-plugin-manager/pending-update'
import { capturePendingPluginStop, consumePendingPluginUpdate, recordPendingPluginCleanStop } from '../src/pending-plugin-update.ts'
import { DesktopBackendController } from '../src/backend-controller.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const rename = vi.mocked(fs.rename)
afterEach(() => { rename.mockImplementation(actualFs.rename); vi.mocked(fs.unlink).mockImplementation(actualFs.unlink) })
const journalPath = (root: string) => join(root, '.plugin-manager/desktop-activation.json')
const receiptPath = (root: string) => join(root, '.plugin-manager/desktop-clean-stop.json')
const signal = () => AbortSignal.timeout(30_000)
const packageMove = (from: string, to: string) => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'node_modules'].includes(basename(from)) && basename(from) === basename(to)

async function fixture(publish = true) {
  const temp = await fs.mkdtemp(join(tmpdir(), 'dsh-pending-update-'))
  onTestFinished(async () => { await fs.rm(temp, { recursive: true, force: true }) })
  await fs.mkdir(join(temp, 'profile'))
  const root = await fs.realpath(join(temp, 'profile'))
  await fs.mkdir(join(root, 'node_modules/extra'), { recursive: true })
  await fs.writeFile(join(root, 'node_modules/extra/code.js'), 'old implementation\n')
  for (const file of UPDATE_BASE_FILES) await fs.writeFile(join(root, file), `old ${file}\n`)
  await fs.writeFile(join(root, 'sessions-kept.json'), '{"user":"history kept"}\n')
  await fs.mkdir(join(temp, 'linked'))
  await fs.writeFile(join(temp, 'linked/code.js'), 'external dependency\n')
  await fs.symlink(process.platform === 'win32' ? await fs.realpath(join(temp, 'linked')) : '../../linked', join(root, 'node_modules/linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const id = randomUUID()
  const relativePath = `.plugin-manager/updates/${id}/candidate`
  const candidate = join(root, relativePath)
  await fs.mkdir(join(candidate, 'node_modules/extra'), { recursive: true, mode: 0o700 })
  for (const file of UPDATE_REPLACEMENT_FILES) await fs.writeFile(join(candidate, file), `new ${file}\n`)
  await fs.writeFile(join(candidate, 'node_modules/extra/code.js'), 'new implementation\n')
  // Staging anchors external links; the old backup must preserve its original relative link bytes.
  await fs.symlink(await fs.realpath(join(temp, 'linked')), join(candidate, 'node_modules/linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const pending: PendingBundleUpdate = {
    schema: 1, id, profileRealPath: root, producerPid: 0x7ffffffe, target: 'extra', beforeVersion: '1.0.0', nextVersion: '2.0.0',
    baseBindings: await readUpdateBaseBindings(root, signal()), candidateRelativePath: relativePath,
    candidateBindings: await readUpdateCandidateBindings(candidate, signal()), createdAt: Date.now(),
  }
  const publishPending = async () => { await fs.writeFile(join(root, PENDING_UPDATE_PATH), `${JSON.stringify(pending)}\n`, { mode: 0o600 }) }
  if (publish) await publishPending()
  const clean = async () => {
    const captured = await capturePendingPluginStop(root)
    expect(captured).toBeDefined()
    expect(await recordPendingPluginCleanStop(root, captured!)).toBe(true)
  }
  const unchanged = async () => {
    expect(await readUpdateBaseBindings(root, signal())).toEqual(pending.baseBindings)
    expect(await fs.readFile(join(root, 'sessions-kept.json'), 'utf8')).toBe('{"user":"history kept"}\n')
  }
  return { root, candidate, pending, clean, unchanged, publishPending }
}

describe('pre-Host pending plugin activation', () => {
  it('does nothing without a published descriptor', async () => {
    const f = await fixture(false)
    expect(await consumePendingPluginUpdate(f.root)).toEqual({ status: 'none' })
    expect(await capturePendingPluginStop(f.root)).toBeUndefined()
    await f.unchanged()
  })

  it('blocks a live producer and never writes clean proof for it', async () => {
    const f = await fixture()
    f.pending.producerPid = process.pid
    await f.publishPending()
    const captured = await capturePendingPluginStop(f.root)
    expect(await recordPendingPluginCleanStop(f.root, captured!)).toBe(false)
    await expect(consumePendingPluginUpdate(f.root)).rejects.toMatchObject({ code: 'producer-alive' })
    await expect(fs.readFile(receiptPath(f.root))).rejects.toMatchObject({ code: 'ENOENT' })
    await f.unchanged()
  })

  it('keeps the old profile without clean proof, then applies after an explicit successful stop receipt', async () => {
    const f = await fixture()
    expect(await consumePendingPluginUpdate(f.root)).toMatchObject({ status: 'deferred', reason: 'unclean-stop' })
    await f.unchanged()
    await f.clean()
    expect(await consumePendingPluginUpdate(f.root)).toEqual({ status: 'applied', id: f.pending.id, version: '2.0.0' })
    expect(await readUpdateCandidateBindings(f.root, signal())).toEqual(f.pending.candidateBindings)
    for (const file of UPDATE_BASE_FILES) {
      if (!UPDATE_REPLACEMENT_FILES.some(replacement => replacement === file)) expect(await fs.readFile(join(f.root, file), 'utf8')).toBe(`old ${file}\n`)
    }
    expect(await fs.readFile(join(f.root, 'sessions-kept.json'), 'utf8')).toBe('{"user":"history kept"}\n')
    await expect(fs.readFile(join(f.root, PENDING_UPDATE_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(journalPath(f.root))).rejects.toMatchObject({ code: 'ENOENT' })
    const backups = (await fs.readdir(join(f.root, '.plugin-manager/updates', f.pending.id))).filter(name => name.startsWith('desktop-'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(join(f.root, '.plugin-manager/updates', f.pending.id, backups[0]!, 'node_modules/extra/code.js'), 'utf8')).toBe('old implementation\n')
    expect(await consumePendingPluginUpdate(f.root)).toEqual({ status: 'none' })
  })

  it('does not authorize a descriptor changed after the stop capture', async () => {
    const f = await fixture()
    const captured = await capturePendingPluginStop(f.root)
    f.pending.createdAt++
    await f.publishPending()
    expect(await recordPendingPluginCleanStop(f.root, captured!)).toBe(false)
    expect(await consumePendingPluginUpdate(f.root)).toMatchObject({ status: 'deferred', reason: 'unclean-stop' })
    await f.unchanged()
  })

  it('handles absent old and candidate optional files without creating placeholder bytes', async () => {
    const f = await fixture()
    await fs.unlink(join(f.root, 'pnpm-workspace.yaml'))
    await fs.unlink(join(f.candidate, 'pnpm-lock.yaml'))
    f.pending.baseBindings = await readUpdateBaseBindings(f.root, signal())
    f.pending.candidateBindings = await readUpdateCandidateBindings(f.candidate, signal())
    await f.publishPending()
    await f.clean()
    expect(await consumePendingPluginUpdate(f.root)).toMatchObject({ status: 'applied' })
    expect(await readUpdateCandidateBindings(f.root, signal())).toEqual(f.pending.candidateBindings)
    await expect(fs.readFile(join(f.root, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(join(f.root, 'pnpm-workspace.yaml'), 'utf8')).toBe('new pnpm-workspace.yaml\n')
  })

  it('finishes a committed journal after cleanup interruption without rolling the new graph back', async () => {
    const f = await fixture()
    await f.clean()
    vi.mocked(fs.unlink).mockImplementation(async (path) => {
      if (String(path) === join(f.root, PENDING_UPDATE_PATH)) throw new Error('fixture interrupted committed cleanup')
      await actualFs.unlink(path)
    })
    await expect(consumePendingPluginUpdate(f.root)).rejects.toThrow('fixture interrupted committed cleanup')
    expect(JSON.parse(await fs.readFile(journalPath(f.root), 'utf8'))).toMatchObject({ phase: 'committed' })
    expect(await readUpdateCandidateBindings(f.root, signal())).toEqual(f.pending.candidateBindings)
    vi.mocked(fs.unlink).mockImplementation(actualFs.unlink)
    expect(await consumePendingPluginUpdate(f.root)).toMatchObject({ status: 'applied' })
    expect(await readUpdateCandidateBindings(f.root, signal())).toEqual(f.pending.candidateBindings)
  })

  it.each(['base', 'candidate'] as const)('does not move anything when the %s hash changed', async (which) => {
    const f = await fixture()
    await f.clean()
    const path = join(which === 'base' ? f.root : f.candidate, 'node_modules/extra/code.js')
    await fs.writeFile(path, 'unexpected change\n')
    expect(await consumePendingPluginUpdate(f.root)).toMatchObject({ status: 'deferred', reason: `${which}-changed` })
    expect(await fs.readFile(path, 'utf8')).toBe('unexpected change\n')
    expect(await fs.readFile(join(f.root, 'package.json'), 'utf8')).toBe('old package.json\n')
    if (which === 'candidate') await f.unchanged()
  })

  it.each(['candidate', 'profile-entry'] as const)('refuses a %s symlink escape', async (which) => {
    const f = await fixture()
    await f.clean()
    const target = which === 'candidate' ? f.candidate : join(f.root, 'package.json')
    const moved = `${target}-outside`
    await fs.rename(target, moved)
    await fs.symlink(moved, target, which === 'candidate' ? process.platform === 'win32' ? 'junction' : 'dir' : 'file')
    await expect(consumePendingPluginUpdate(f.root)).rejects.toMatchObject({ code: 'invalid-state' })
    expect(await fs.readFile(join(f.root, 'sessions-kept.json'), 'utf8')).toBe('{"user":"history kept"}\n')
  })

  for (const step of Array.from({ length: 8 }, (_, index) => index + 1)) {
    for (const timing of ['before', 'after'] as const) {
      it(`restores old bytes when rename ${step} fails ${timing} moving its entry`, async () => {
        const f = await fixture()
        await f.clean()
        let moves = 0
        let injected = false
        rename.mockImplementation(async (from, to) => {
          if (packageMove(String(from), String(to)) && ++moves === step && !injected) {
            injected = true
            if (timing === 'after') await actualFs.rename(from, to)
            throw new Error('fixture rename failure')
          }
          await actualFs.rename(from, to)
        })
        expect(await consumePendingPluginUpdate(f.root)).toMatchObject({ status: 'deferred', reason: 'apply-failed' })
        expect(injected).toBe(true)
        await f.unchanged()
        expect(await readUpdateCandidateBindings(f.candidate, signal())).toEqual(f.pending.candidateBindings)
        await expect(fs.readFile(journalPath(f.root))).rejects.toMatchObject({ code: 'ENOENT' })
      })

      it(`recovers a persisted intent after interruption ${timing} rename ${step}`, async () => {
        const f = await fixture()
        await f.clean()
        let moves = 0
        let interrupted = false
        rename.mockImplementation(async (from, to) => {
          if (interrupted) throw new Error('fixture process cannot perform further writes')
          if (packageMove(String(from), String(to)) && ++moves === step) {
            if (timing === 'after') await actualFs.rename(from, to)
            interrupted = true
            throw new Error('fixture interruption')
          }
          await actualFs.rename(from, to)
        })
        await expect(consumePendingPluginUpdate(f.root)).rejects.toMatchObject({ code: 'recovery-failed' })
        const journal = JSON.parse(await fs.readFile(journalPath(f.root), 'utf8')) as { intent?: object }
        expect(journal.intent).not.toBeNull()
        rename.mockImplementation(actualFs.rename)
        expect(await consumePendingPluginUpdate(f.root)).toMatchObject({ status: 'deferred', reason: 'apply-failed' })
        await f.unchanged()
        expect(await readUpdateCandidateBindings(f.candidate, signal())).toEqual(f.pending.candidateBindings)
      })
    }
  }

  it('preserves unexpected new bytes and blocks startup when rollback cannot establish ownership', async () => {
    const f = await fixture()
    await f.clean()
    let injected = false
    rename.mockImplementation(async (from, to) => {
      await actualFs.rename(from, to)
      if (!injected && String(from) === join(f.candidate, 'node_modules')) {
        injected = true
        await fs.writeFile(join(f.root, 'node_modules/extra/code.js'), 'new user edit must survive\n')
        throw new Error('fixture failure with concurrent edit')
      }
    })
    await expect(consumePendingPluginUpdate(f.root)).rejects.toMatchObject({ code: 'recovery-failed' })
    rename.mockImplementation(actualFs.rename)
    await expect(consumePendingPluginUpdate(f.root)).rejects.toMatchObject({ code: 'recovery-failed' })
    expect(await fs.readFile(join(f.root, 'node_modules/extra/code.js'), 'utf8')).toBe('new user edit must survive\n')
    expect(await fs.readFile(join(f.root, 'sessions-kept.json'), 'utf8')).toBe('{"user":"history kept"}\n')
  })

  it('shares the package.json writer lock and re-reads the baseline after the other writer finishes', async () => {
    const f = await fixture()
    await f.clean()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const writer = withFileLock(join(f.root, 'package.json'), async () => {
      entered.resolve(undefined)
      await release.promise
      await fs.writeFile(join(f.root, 'package.json'), 'other profile writer\n')
    })
    await entered.promise
    let completed = false
    const consuming = consumePendingPluginUpdate(f.root).then((result) => { completed = true; return result })
    expect(completed).toBe(false)
    release.resolve(undefined)
    await writer
    expect(await consuming).toMatchObject({ status: 'deferred', reason: 'base-changed' })
    expect(await fs.readFile(join(f.root, 'package.json'), 'utf8')).toBe('other profile writer\n')
  })

  it('does not spawn a Host when Desktop closes while pre-Host activation is waiting for the lock', async () => {
    const f = await fixture()
    await f.clean()
    const locked = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const writer = withFileLock(join(f.root, 'package.json'), async () => { locked.resolve(undefined); await release.promise })
    await locked.promise
    const createHost = vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }))
    const controller = new DesktopBackendController(createHost, () => {})
    const entered = Promise.withResolvers<undefined>()
    const starting = controller.start(async () => { entered.resolve(undefined); await consumePendingPluginUpdate(f.root) })
    await entered.promise
    const closing = controller.close()
    release.resolve(undefined)
    await writer
    await starting
    await closing
    expect(createHost).not.toHaveBeenCalled()
    expect(await readUpdateCandidateBindings(f.root, signal())).toEqual(f.pending.candidateBindings)
  })
})
