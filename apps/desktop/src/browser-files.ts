/** User-selected, privately staged files for exact owned browser guests. */
import { lstat, mkdir, open, realpath, rm, unlink } from 'node:fs/promises'
import { constants, mkdtempSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { dialog, type BrowserWindow, type DownloadItem, type Event, type WebContents } from 'electron'

const MAX_BYTES = 100 * 1024 * 1024

interface Owner {
  guest: WebContents
  lifetime: AbortController
  directories: Set<string>
  operations: Set<Promise<unknown>>
  destroyed: () => void
  closing?: Promise<void>
}

/** File access accepts trusted picker selections, never model-supplied host paths. */
export class DesktopBrowserFiles {
  private readonly grants = new Map<number, number>()
  private readonly owners = new Map<WebContents, Owner>()
  private stopping = false
  constructor(private readonly window: () => BrowserWindow | undefined) {}

  /** @param guest - exact user-approved guest; one download may start within one minute. */
  allowDownload(guest: WebContents): void {
    this.owner(guest)
    this.grants.set(guest.id, Date.now() + 60_000)
  }

  /**
   * Stage explicitly selected regular files; browser form submission may read them later.
   * @param guest - exact owned browser target.
   * @returns private copies retained until this guest closes or the Host is disposed.
   */
  selectUpload(guest: WebContents): Promise<string[]> {
    const owner = this.owner(guest)
    return this.track(owner, this.stageUpload(owner))
  }

  /**
   * Set the staging destination synchronously inside Electron's will-download callback.
   * @param event - Electron download event.
   * @param item - pending browser transfer.
   * @param guest - exact initiating guest.
   */
  download(event: Event, item: DownloadItem, guest: WebContents): void {
    const expires = this.grants.get(guest.id)
    this.grants.delete(guest.id)
    if (this.stopping || expires === undefined || expires < Date.now() || guest.isDestroyed()) { event.preventDefault(); return }
    const owner = this.owner(guest)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-browser-download-'))
    owner.directories.add(directory)
    const staged = join(directory, 'download')
    try {
      item.setSavePath(staged)
      item.pause()
    } catch (error) {
      // Reject the transfer before Electron can choose an uncontrolled destination.
      event.preventDefault()
      void error
      void this.track(owner, rm(directory, { recursive: true, force: true })).catch((cleanupError: unknown) => { void cleanupError; console.error('Browser staging cleanup failed') })
      return
    }
    let finish!: (completed: boolean) => void
    const complete = new Promise<boolean>((resolveComplete) => { finish = resolveComplete })
    let cancelled = false
    const cancel = (): void => {
      cancelled = true
      try { item.cancel() } catch (error) {
        // Electron may have disposed a transfer that already emitted done.
        void error
      }
      finish(false)
    }
    const updated = (): void => {
      if (owner.lifetime.signal.aborted || item.getReceivedBytes() > MAX_BYTES || item.getTotalBytes() > MAX_BYTES) cancel()
    }
    const mayResume = (): boolean => !owner.lifetime.signal.aborted && !cancelled
    const done = (_event: unknown, state: string): void => { finish(state === 'completed') }
    item.on('updated', updated)
    item.once('done', done)
    owner.lifetime.signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, 120_000)
    const operation = (async () => {
      try { await this.saveDownload(owner, item, staged, complete) } finally {
        clearTimeout(timer)
        owner.lifetime.signal.removeEventListener('abort', cancel)
        item.removeListener('updated', updated)
        item.removeListener('done', done)
        await rm(directory, { recursive: true, force: true })
        owner.directories.delete(directory)
      }
    })()
    void this.track(owner, operation).catch((error: unknown) => {
      // Failure remains local; Electron error strings may contain paths.
      void error
      try { item.cancel() } catch (cancelError) { void cancelError }
    })
    updated()
    if (mayResume()) item.resume()
  }

  /** Stop file admission, cancel transfers, and remove owned staging without deleting user files. @returns quiescent cleanup. */
  async dispose(): Promise<void> {
    this.stopping = true
    this.grants.clear()
    await Promise.all([...this.owners.values()].map(owner => this.close(owner)))
  }

  private async stageUpload(owner: Owner): Promise<string[]> {
    const signal = owner.lifetime.signal
    const parent = this.window()
    if (parent === undefined) return []
    const picked = await withCancellation(dialog.showOpenDialog(parent, { properties: ['openFile', 'multiSelections', 'dontAddToRecent'] }), signal)
    if (picked === undefined || picked.canceled || signal.aborted) return []
    const directory = mkdtempSync(join(tmpdir(), 'dsh-browser-upload-'))
    owner.directories.add(directory)
    const files: string[] = []
    let size = 0
    try {
      for (const [index, file] of picked.filePaths.entries()) {
        signal.throwIfAborted()
        // Canonical parents plus no-follow open reject links before the descriptor is acquired.
        const absolute = resolve(file)
        if (file !== absolute || await realpath(file) !== absolute) throw new Error('Select regular files without symbolic links')
        const before = await lstat(file)
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('Select regular files without symbolic links')
        const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const pinned = await input.stat()
          if (!pinned.isFile() || pinned.dev !== before.dev || pinned.ino !== before.ino || await realpath(file) !== absolute) throw new Error('Selected file changed; select it again')
          size += pinned.size
          if (size > MAX_BYTES) throw new Error('Selected uploads exceed the browser file size limit')
          const folder = join(directory, String(index))
          await mkdir(folder, { mode: 0o700 })
          const destination = join(folder, basename(file))
          const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
          try {
            await copyBounded(input, output, pinned.size, signal)
          } finally { await output.close() }
          const after = await input.stat()
          if (after.size !== pinned.size || after.mtimeMs !== pinned.mtimeMs || after.ctimeMs !== pinned.ctimeMs) throw new Error('Selected file changed while reading; select it again')
          files.push(destination)
        } finally { await input.close() }
      }
      signal.throwIfAborted()
      return files
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      owner.directories.delete(directory)
      if (isAborted(signal)) return []
      throw error
    }
  }

  private async saveDownload(owner: Owner, item: DownloadItem, staged: string, completed: Promise<boolean>): Promise<void> {
    const signal = owner.lifetime.signal
    if (!await completed || signal.aborted) return
    const stat = await lstat(staged)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Browser download exceeded the file limit')
    const parent = this.window()
    if (parent === undefined) return
    const name = basename(item.getFilename()).replace(/[\x00-\x1f]/g, '_')
    const picked = await withCancellation(dialog.showSaveDialog(parent, { defaultPath: name.startsWith('.') ? 'download' : name, properties: ['dontAddToRecent'] }), signal)
    if (picked === undefined || picked.canceled || picked.filePath.length === 0 || isAborted(signal)) return
    const destination = resolve(picked.filePath)
    if (picked.filePath !== destination || await realpath(dirname(destination)) !== dirname(destination)) throw new Error('Choose a destination without symbolic links')
    const input = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      // Exclusive no-follow creation rejects an existing file or link despite picker confirmation.
      const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const created = await output.stat()
      try {
        if (await realpath(dirname(destination)) !== dirname(destination)) throw new Error('Destination changed during selection')
        await copyBounded(input, output, stat.size, signal)
      } catch (error) {
        const current = await lstat(destination).catch(() => undefined)
        if (current?.dev === created.dev && current.ino === created.ino) await unlink(destination)
        throw error
      } finally { await output.close() }
    } finally { await input.close() }
  }

  private owner(guest: WebContents): Owner {
    if (this.stopping || guest.isDestroyed()) throw new Error('Browser file access is stopped')
    const existing = this.owners.get(guest)
    if (existing !== undefined) return existing
    const owner: Owner = {
      guest, lifetime: new AbortController(), directories: new Set(), operations: new Set(),
      destroyed: () => { void this.close(owner).catch(() => { console.error('Browser staging cleanup failed') }) },
    }
    this.owners.set(guest, owner)
    guest.once('destroyed', owner.destroyed)
    return owner
  }

  private track<T>(owner: Owner, operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => { owner.operations.delete(tracked) })
    owner.operations.add(tracked)
    return tracked
  }

  private close(owner: Owner): Promise<void> {
    if (owner.closing !== undefined) return owner.closing
    owner.lifetime.abort()
    this.grants.delete(owner.guest.id)
    owner.closing = (async () => {
      await Promise.allSettled(owner.operations)
      await Promise.all([...owner.directories].map(directory => rm(directory, { recursive: true, force: true })))
      owner.guest.removeListener('destroyed', owner.destroyed)
      this.owners.delete(owner.guest)
    })()
    return owner.closing
  }
}

async function withCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let abort!: () => void
  const cancelled = new Promise<undefined>((resolveCancelled) => {
    abort = () => { resolveCancelled(undefined) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([promise, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted }

async function copyBounded(
  input: Awaited<ReturnType<typeof open>>, output: Awaited<ReturnType<typeof open>>,
  expectedSize: number, signal: AbortSignal,
): Promise<void> {
  const buffer = Buffer.alloc(64 * 1024)
  let copied = 0
  while (true) {
    signal.throwIfAborted()
    const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    copied += bytesRead
    if (copied > expectedSize || copied > MAX_BYTES) throw new Error('File changed or exceeded the browser file size limit')
    let written = 0
    while (written < bytesRead) {
      const chunk = await output.write(buffer, written, bytesRead - written, null)
      if (chunk.bytesWritten === 0) throw new Error('Browser file copy made no progress')
      written += chunk.bytesWritten
    }
  }
  if (copied !== expectedSize) throw new Error('File changed during browser transfer')
  signal.throwIfAborted()
}
