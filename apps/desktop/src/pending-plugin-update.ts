/** Activate prepared plugin graphs only between a confirmed Host exit and the next Host start. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import {
  PENDING_UPDATE_PATH, UPDATE_BASE_FILES, UPDATE_REPLACEMENT_FILES, parsePendingBundleUpdate,
  readUpdateBaseBindings, readUpdateCandidateBindings, updateDirectoryDigest, updateFileDigest,
  type PendingBundleUpdate,
} from '@deepseek-ai/dsh-plugin-manager/pending-update'

const RECEIPT = '.plugin-manager/desktop-clean-stop.json'
const JOURNAL = '.plugin-manager/desktop-activation.json'
const ENTRIES = [...UPDATE_REPLACEMENT_FILES, 'node_modules'] as const
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{64}$/
const HASH_TIMEOUT_MS = 120_000
const LOCK_WAIT_MS = 2_000
type Entry = typeof ENTRIES[number]
type Location = 'profile' | 'candidate' | 'backup'
type Phase = 'applying' | 'rolling-back' | 'committed' | 'rolled-back'
interface Journal {
  schema: 1
  descriptor: string
  descriptorHash: string
  attemptId: string
  phase: Phase
  intent: { entry: Entry; from: Location; to: Location } | null
}
interface Document { raw: string; hash: string; update: PendingBundleUpdate }
interface Receipt { schema: 1; id: string; descriptorHash: string; producerPid: number; recordedAt: number }

/** Exact pending bytes observed before requesting a graceful Host stop. */
export interface PendingPluginStop {
  readonly id: string
  readonly descriptorHash: string
  readonly producerPid: number
}

/** A deferred update leaves the current profile unchanged and may run the old Host. */
export type PendingPluginUpdateResult =
  | { readonly status: 'none' }
  | { readonly status: 'applied'; readonly id: string; readonly version: string }
  | { readonly status: 'deferred'; readonly id: string; readonly reason: 'unclean-stop' | 'base-changed' | 'candidate-changed' | 'apply-failed' }

/** Starting another Host is unsafe until the pending producer or uncertain recovery is resolved. */
export class PendingPluginUpdateBlockedError extends Error {
  /** @param code Stable diagnostic without package contents or registry credentials. */
  constructor(readonly code: 'producer-alive' | 'invalid-state' | 'recovery-failed') {
    super(`Pending plugin update blocks Host startup: ${code}`)
    this.name = 'PendingPluginUpdateBlockedError'
  }
}

function sha(content: string): string { return createHash('sha256').update(content).digest('hex') }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return true
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
function same(a: object, b: object): boolean { return JSON.stringify(a) === JSON.stringify(b) }

/** Reject links at every managed path component; dependency links use the producer's shared fingerprint. */
async function pathExists(root: string, path: string, kind: 'file' | 'directory'): Promise<boolean> {
  const rel = relative(root, path)
  if (rel === '' || isAbsolute(rel) || rel.split(sep).includes('..')) throw new PendingPluginUpdateBlockedError('invalid-state')
  const parts = rel.split(sep)
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let stat
    try { stat = await lstat(current) }
    catch (error) { if (missing(error)) return false; throw error }
    if (stat.isSymbolicLink() || (index < parts.length - 1 || kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
      throw new PendingPluginUpdateBlockedError('invalid-state')
    }
  }
  return true
}

async function document(root: string): Promise<Document | undefined> {
  const raw = await metadata(root, join(root, PENDING_UPDATE_PATH))
  if (raw === undefined) return undefined
  const update = parsePendingBundleUpdate(raw)
  if (update.profileRealPath !== root) throw new PendingPluginUpdateBlockedError('invalid-state')
  return { raw, hash: sha(raw), update }
}

async function metadata(root: string, path: string): Promise<string | undefined> {
  if (!await pathExists(root, path, 'file')) return undefined
  if ((await lstat(path)).size > 64 * 1024) throw new PendingPluginUpdateBlockedError('invalid-state')
  return readFile(path, 'utf8')
}

async function syncDirectory(path: string): Promise<void> {
  let handle
  try { handle = await open(path, 'r'); await handle.sync() }
  catch (error) {
    // Windows does not expose directory fsync; file sync and same-volume rename still precede the next intent.
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  } finally { await handle?.close() }
}

/** Flush the new journal/receipt bytes before publishing its rename and moving package entries. */
async function persist(root: string, path: string, value: object): Promise<void> {
  await pathExists(root, path, 'file')
  if (!await pathExists(root, dirname(path), 'directory')) throw new PendingPluginUpdateBlockedError('invalid-state')
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() }
  finally { await handle.close() }
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}

async function removeMetadata(root: string, path: string): Promise<void> {
  if (!await pathExists(root, path, 'file')) return
  await unlink(path)
  await syncDirectory(dirname(path))
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PendingPluginUpdateBlockedError('invalid-state')
  return value as Record<string, unknown>
}

function parseReceipt(raw: string): Receipt {
  const value = record(JSON.parse(raw))
  if (Object.keys(value).sort().join(',') !== 'descriptorHash,id,producerPid,recordedAt,schema'
    || value.schema !== 1 || typeof value.id !== 'string' || !UUID.test(value.id)
    || typeof value.descriptorHash !== 'string' || !SHA.test(value.descriptorHash)
    || typeof value.producerPid !== 'number' || !Number.isSafeInteger(value.producerPid) || value.producerPid <= 0
    || typeof value.recordedAt !== 'number' || !Number.isSafeInteger(value.recordedAt) || value.recordedAt < 0) throw new PendingPluginUpdateBlockedError('invalid-state')
  return { schema: 1, id: value.id, descriptorHash: value.descriptorHash, producerPid: value.producerPid, recordedAt: value.recordedAt }
}

function parseJournal(raw: string, root: string): { journal: Journal; update: PendingBundleUpdate } {
  const value = record(JSON.parse(raw))
  if (Object.keys(value).sort().join(',') !== 'attemptId,descriptor,descriptorHash,intent,phase,schema'
    || value.schema !== 1 || typeof value.descriptor !== 'string' || typeof value.descriptorHash !== 'string'
    || sha(value.descriptor) !== value.descriptorHash || typeof value.attemptId !== 'string' || !UUID.test(value.attemptId)
    || !['applying', 'rolling-back', 'committed', 'rolled-back'].includes(String(value.phase))) throw new PendingPluginUpdateBlockedError('invalid-state')
  const update = parsePendingBundleUpdate(value.descriptor)
  if (update.profileRealPath !== root) throw new PendingPluginUpdateBlockedError('invalid-state')
  let intent: Journal['intent'] = null
  if (value.intent !== null) {
    const item = record(value.intent)
    if (Object.keys(item).sort().join(',') !== 'entry,from,to' || !ENTRIES.includes(item.entry as Entry)
      || !['profile', 'candidate', 'backup'].includes(String(item.from)) || !['profile', 'candidate', 'backup'].includes(String(item.to))) throw new PendingPluginUpdateBlockedError('invalid-state')
    intent = { entry: item.entry as Entry, from: item.from as Location, to: item.to as Location }
  }
  return { journal: {
    schema: 1, descriptor: value.descriptor, descriptorHash: value.descriptorHash,
    attemptId: value.attemptId, phase: value.phase as Phase, intent,
  }, update }
}

function directory(root: string, update: PendingBundleUpdate, journal: Journal, location: Location): string {
  if (location === 'profile') return root
  if (location === 'candidate') return join(root, update.candidateRelativePath)
  return join(root, '.plugin-manager', 'updates', update.id, `desktop-${journal.attemptId}`)
}

async function digest(root: string, path: string, entry: Entry, signal: AbortSignal, logicalRoot?: string): Promise<string | null> {
  if (!await pathExists(root, path, entry === 'node_modules' ? 'directory' : 'file')) return null
  return entry === 'node_modules' ? updateDirectoryDigest(path, signal, logicalRoot) : updateFileDigest(path, signal)
}

async function base(root: string, signal: AbortSignal): ReturnType<typeof readUpdateBaseBindings> {
  for (const file of UPDATE_BASE_FILES) await pathExists(root, join(root, file), 'file')
  await pathExists(root, join(root, 'node_modules'), 'directory')
  return readUpdateBaseBindings(root, signal)
}

async function candidate(root: string, update: PendingBundleUpdate, signal: AbortSignal): ReturnType<typeof readUpdateCandidateBindings> {
  const dir = join(root, update.candidateRelativePath)
  if (!await pathExists(root, dir, 'directory')) throw new PendingPluginUpdateBlockedError('invalid-state')
  for (const file of UPDATE_REPLACEMENT_FILES) await pathExists(root, join(dir, file), 'file')
  await pathExists(root, join(dir, 'node_modules'), 'directory')
  return readUpdateCandidateBindings(dir, signal)
}

async function installedCandidate(
  root: string, update: PendingBundleUpdate, signal: AbortSignal,
): ReturnType<typeof readUpdateCandidateBindings> {
  const current = await base(root, signal)
  for (const file of UPDATE_BASE_FILES) {
    if (!UPDATE_REPLACEMENT_FILES.some(replacement => replacement === file) && current.files[file] !== update.baseBindings.files[file]) {
      throw new PendingPluginUpdateBlockedError('recovery-failed')
    }
  }
  return { files: { 'package.json': current.files['package.json'], 'pnpm-lock.yaml': current.files['pnpm-lock.yaml'], 'pnpm-workspace.yaml': current.files['pnpm-workspace.yaml'] }, nodeModules: current.nodeModules }
}

function expected(update: PendingBundleUpdate, entry: Entry, source: 'base' | 'candidate'): string | null {
  const binding = source === 'base' ? update.baseBindings : update.candidateBindings
  return entry === 'node_modules' ? binding.nodeModules : binding.files[entry]
}

async function move(
  root: string, update: PendingBundleUpdate, journal: Journal, entry: Entry,
  from: Location, to: Location, hash: string, signal: AbortSignal,
): Promise<void> {
  const origin = join(directory(root, update, journal, from), entry)
  const target = join(directory(root, update, journal, to), entry)
  if (await digest(root, origin, entry, signal, from === 'backup' ? join(root, 'node_modules') : undefined) !== hash
    || await digest(root, target, entry, signal, to === 'backup' ? join(root, 'node_modules') : undefined) !== null) throw new PendingPluginUpdateBlockedError('recovery-failed')
  journal.intent = { entry, from, to }
  await persist(root, join(root, JOURNAL), journal)
  await rename(origin, target)
  await syncDirectory(dirname(origin))
  if (dirname(origin) !== dirname(target)) await syncDirectory(dirname(target))
  journal.intent = null
  await persist(root, join(root, JOURNAL), journal)
}

async function archive(root: string, update: PendingBundleUpdate, journal: Journal): Promise<void> {
  await persist(root, join(directory(root, update, journal, 'backup'), 'journal.json'), journal)
  await removeMetadata(root, join(root, JOURNAL))
}

async function rollback(root: string, update: PendingBundleUpdate, journal: Journal): Promise<void> {
  const signal = AbortSignal.timeout(HASH_TIMEOUT_MS)
  journal.phase = 'rolling-back'
  await persist(root, join(root, JOURNAL), journal)
  for (const entry of [...ENTRIES].reverse()) {
    const old = expected(update, entry, 'base')
    const next = expected(update, entry, 'candidate')
    const current = await digest(root, join(root, entry), entry, signal)
    const backup = await digest(root, join(directory(root, update, journal, 'backup'), entry), entry, signal, join(root, 'node_modules'))
    if (backup === null && current === old) continue
    if (backup !== old || (current !== null && current !== next)) throw new PendingPluginUpdateBlockedError('recovery-failed')
    if (current !== null) await move(root, update, journal, entry, 'profile', 'candidate', current, signal)
    if (old !== null) await move(root, update, journal, entry, 'backup', 'profile', old, signal)
  }
  if (!same(await base(root, signal), update.baseBindings)) throw new PendingPluginUpdateBlockedError('recovery-failed')
  journal.phase = 'rolled-back'
  journal.intent = null
  await persist(root, join(root, JOURNAL), journal)
  await removeMetadata(root, join(root, RECEIPT))
  await archive(root, update, journal)
}

async function finishCommitted(root: string, update: PendingBundleUpdate, journal: Journal): Promise<void> {
  const installed = await installedCandidate(root, update, AbortSignal.timeout(HASH_TIMEOUT_MS))
  if (!same(installed, update.candidateBindings)) throw new PendingPluginUpdateBlockedError('recovery-failed')
  const pending = await document(root)
  if (pending !== undefined && pending.hash !== journal.descriptorHash) throw new PendingPluginUpdateBlockedError('recovery-failed')
  await removeMetadata(root, join(root, PENDING_UPDATE_PATH))
  await removeMetadata(root, join(root, RECEIPT))
  await archive(root, update, journal)
}

/**
 * Observe the pending identity before shutdown; malformed or linked paths reject, so callers require a clean stop conservatively.
 * @param profile Desktop profile directory; no profile files are changed.
 * @returns Exact descriptor identity, or undefined when no update is pending.
 */
export async function capturePendingPluginStop(profile: string): Promise<PendingPluginStop | undefined> {
  let root: string
  try { root = await realpath(profile) }
  catch (error) { if (missing(error)) return undefined; throw error }
  const pending = await document(root)
  return pending === undefined ? undefined
    : { id: pending.update.id, descriptorHash: pending.hash, producerPid: pending.update.producerPid }
}

/**
 * Record proof only after the caller's owned Host successfully completed stop(true).
 * @param profile Desktop profile directory.
 * @param captured Identity read before stopping; a replacement descriptor never inherits its proof.
 * @returns Whether the unchanged descriptor and dead producer received a durable clean-stop receipt.
 */
export async function recordPendingPluginCleanStop(profile: string, captured: PendingPluginStop): Promise<boolean> {
  const root = await realpath(profile)
  return withFileLock(join(root, 'package.json'), async () => {
    const pending = await document(root)
    if (pending === undefined || pending.hash !== captured.descriptorHash || pending.update.id !== captured.id
      || pending.update.producerPid !== captured.producerPid || alive(captured.producerPid)) return false
    await persist(root, join(root, RECEIPT), { schema: 1, ...captured, recordedAt: Date.now() } satisfies Receipt)
    return true
  }, { waitMs: LOCK_WAIT_MS })
}

/**
 * Recover unfinished activation, then apply one prepared graph before any new Host starts.
 * @param profile Desktop profile directory; the caller must own the pre-Host lifecycle interval.
 * @returns No pending update, a completed activation, or a reason the old profile was retained.
 */
export async function consumePendingPluginUpdate(profile: string): Promise<PendingPluginUpdateResult> {
  let root: string
  try { root = await realpath(resolve(profile)) }
  catch (error) { if (missing(error)) return { status: 'none' }; throw error }
  return withFileLock(join(root, 'package.json'), async () => {
    const unfinished = await metadata(root, join(root, JOURNAL))
    if (unfinished !== undefined) {
      try {
        const { journal, update } = parseJournal(unfinished, root)
        if (alive(update.producerPid)) throw new PendingPluginUpdateBlockedError('producer-alive')
        if (journal.phase === 'committed') {
          await finishCommitted(root, update, journal)
          return { status: 'applied', id: update.id, version: update.nextVersion }
        }
        await rollback(root, update, journal)
        return { status: 'deferred', id: update.id, reason: 'apply-failed' }
      } catch (error) {
        if (error instanceof PendingPluginUpdateBlockedError && error.code === 'producer-alive') throw error
        throw new PendingPluginUpdateBlockedError('recovery-failed')
      }
    }
    const pending = await document(root)
    if (pending === undefined) return { status: 'none' }
    const { update } = pending
    if (alive(update.producerPid)) throw new PendingPluginUpdateBlockedError('producer-alive')
    const signal = AbortSignal.timeout(HASH_TIMEOUT_MS)
    if (!same(await base(root, signal), update.baseBindings)) return { status: 'deferred', id: update.id, reason: 'base-changed' }
    const rawReceipt = await metadata(root, join(root, RECEIPT))
    const receipt = rawReceipt === undefined ? undefined : parseReceipt(rawReceipt)
    if (receipt?.id !== update.id || receipt.descriptorHash !== pending.hash || receipt.producerPid !== update.producerPid) return { status: 'deferred', id: update.id, reason: 'unclean-stop' }
    if (!same(await candidate(root, update, signal), update.candidateBindings)) return { status: 'deferred', id: update.id, reason: 'candidate-changed' }
    const journal: Journal = { schema: 1, descriptor: pending.raw, descriptorHash: pending.hash, attemptId: randomUUID(), phase: 'applying', intent: null }
    const backup = directory(root, update, journal, 'backup')
    if (!await pathExists(root, dirname(backup), 'directory')) throw new PendingPluginUpdateBlockedError('invalid-state')
    await mkdir(backup, { mode: 0o700 })
    await syncDirectory(dirname(backup))
    await persist(root, join(root, JOURNAL), journal)
    try {
      for (const entry of ENTRIES) {
        const old = expected(update, entry, 'base')
        const next = expected(update, entry, 'candidate')
        if (old !== null) await move(root, update, journal, entry, 'profile', 'backup', old, signal)
        if (next !== null) await move(root, update, journal, entry, 'candidate', 'profile', next, signal)
      }
      if (!same(await installedCandidate(root, update, signal), update.candidateBindings)) throw new PendingPluginUpdateBlockedError('recovery-failed')
      journal.phase = 'committed'
      await persist(root, join(root, JOURNAL), journal)
    } catch {
      // A committed journal owns the new tree; cleanup failures must never roll it back.
      const recorded = await metadata(root, join(root, JOURNAL))
      if (recorded !== undefined && parseJournal(recorded, root).journal.phase === 'committed') throw new PendingPluginUpdateBlockedError('recovery-failed')
      try { await rollback(root, update, journal) }
      catch { throw new PendingPluginUpdateBlockedError('recovery-failed') }
      return { status: 'deferred', id: update.id, reason: 'apply-failed' }
    }
    await finishCommitted(root, update, journal)
    return { status: 'applied', id: update.id, version: update.nextVersion }
  }, { waitMs: LOCK_WAIT_MS })
}
