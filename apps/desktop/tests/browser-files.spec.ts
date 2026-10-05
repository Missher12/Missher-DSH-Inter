/** Browser file selection and staging use real filesystem paths, without a browser or user data. */
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, DownloadItem, WebContents } from 'electron'
import { DesktopBrowserFiles } from '../src/browser-files.ts'

const prompts = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showOpenDialog: prompts.open, showSaveDialog: prompts.save } }))

class Guest extends EventEmitter {
  id = 17
  destroyed = false
  isDestroyed(): boolean { return this.destroyed }
  destroy(): void { this.destroyed = true; this.emit('destroyed') }
}

class Download extends EventEmitter {
  path = ''
  cancelled = false
  received = 0
  total = 0
  setSavePath = vi.fn((path: string) => { this.path = path })
  pause = vi.fn()
  resume = vi.fn()
  cancel = vi.fn(() => { this.cancelled = true; this.emit('done', {}, 'cancelled') })
  getFilename(): string { return 'fixture.txt' }
  getReceivedBytes(): number { return this.received }
  getTotalBytes(): number { return this.total }
  async complete(text: string): Promise<void> {
    await writeFile(this.path, text)
    this.emit('done', {}, 'completed')
  }
}

let root: string
let files: DesktopBrowserFiles
let guest: Guest
const event = () => ({ preventDefault: vi.fn(), defaultPrevented: false })

// Adapt only the native members these boundary doubles implement; real files remain under test.
function webContents(value: Guest): WebContents {
  const surface: Pick<WebContents, 'id' | 'isDestroyed'> = value
  return surface as WebContents
}
function downloadItem(value: Download): DownloadItem {
  const surface: Pick<DownloadItem, 'setSavePath' | 'pause' | 'resume' | 'cancel' | 'getFilename' | 'getReceivedBytes' | 'getTotalBytes'> = value
  return surface as DownloadItem
}

beforeEach(async () => {
  vi.resetAllMocks()
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-browser-files-test-')))
  guest = new Guest()
  files = new DesktopBrowserFiles(() => ({}) as BrowserWindow)
})
afterEach(async () => { await files.dispose(); await rm(root, { recursive: true, force: true }) })

it('uploads private descriptor-copied files and retains them until the guest closes', async () => {
  const source = join(root, 'selected.txt')
  await writeFile(source, 'selected bytes')
  prompts.open.mockResolvedValue({ canceled: false, filePaths: [source] })
  const selected = await files.selectUpload(webContents(guest))
  expect(selected).toHaveLength(1)
  expect(selected[0]).not.toBe(source)
  const staged = selected[0]!
  expect(await readFile(staged, 'utf8')).toBe('selected bytes')
  await writeFile(source, 'changed original')
  expect(await readFile(staged, 'utf8')).toBe('selected bytes')
  expect((await stat(staged)).mode & 0o777).toBe(0o600)
  expect((await stat(dirname(dirname(staged)))).mode & 0o777).toBe(0o700)
  guest.destroy()
  await vi.waitFor(async () => { await expect(stat(staged)).rejects.toThrow() })
  expect(await readFile(source, 'utf8')).toBe('changed original')
})

it('rejects file symlinks and symlinked parent directories before staging', async () => {
  const source = join(root, 'source.txt')
  await writeFile(source, 'private')
  const link = join(root, 'link.txt')
  await symlink(source, link)
  prompts.open.mockResolvedValue({ canceled: false, filePaths: [link] })
  await expect(files.selectUpload(webContents(guest))).rejects.toThrow('symbolic links')
  const directory = join(root, 'linked-parent')
  await symlink(root, directory)
  prompts.open.mockResolvedValue({ canceled: false, filePaths: [join(directory, 'source.txt')] })
  await expect(files.selectUpload(webContents(guest))).rejects.toThrow('symbolic links')
})

it('disposes while a native file picker is open and discards its late selection', async () => {
  const answer = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>()
  prompts.open.mockReturnValue(answer.promise)
  const pending = files.selectUpload(webContents(guest))
  await files.dispose()
  expect(await pending).toEqual([])
  answer.resolve({ canceled: false, filePaths: [join(root, 'never-read.txt')] })
  await Promise.resolve()
  expect(() => files.selectUpload(webContents(guest))).toThrow('stopped')
})

it('sets the download path synchronously, consumes a single grant, and saves completed bytes exclusively', async () => {
  const destination = join(root, 'saved.txt')
  prompts.save.mockResolvedValue({ canceled: false, filePath: destination })
  const item = new Download()
  const begin = event()
  files.allowDownload(webContents(guest))
  files.download(begin, downloadItem(item), webContents(guest))
  expect(item.setSavePath).toHaveBeenCalledOnce()
  expect(item.path).not.toBe('')
  expect(item.resume).toHaveBeenCalledOnce()
  expect(begin.preventDefault).not.toHaveBeenCalled()
  const second = event()
  files.download(second, downloadItem(new Download()), webContents(guest))
  expect(second.preventDefault).toHaveBeenCalledOnce()
  await item.complete('download bytes')
  await vi.waitFor(async () => { expect(await readFile(destination, 'utf8')).toBe('download bytes') })
  await vi.waitFor(async () => { await expect(stat(item.path)).rejects.toThrow() })
})

it('does not overwrite a destination or follow a selected destination symlink', async () => {
  const destination = join(root, 'existing.txt')
  await writeFile(destination, 'original')
  prompts.save.mockResolvedValue({ canceled: false, filePath: destination })
  const item = new Download()
  files.allowDownload(webContents(guest))
  files.download(event(), downloadItem(item), webContents(guest))
  await item.complete('replacement')
  await vi.waitFor(() => { expect(item.cancel).toHaveBeenCalled() })
  expect(await readFile(destination, 'utf8')).toBe('original')
  const link = join(root, 'output-link.txt')
  await symlink(destination, link)
  prompts.save.mockResolvedValue({ canceled: false, filePath: link })
  const next = new Download()
  files.allowDownload(webContents(guest))
  files.download(event(), downloadItem(next), webContents(guest))
  await next.complete('replacement')
  await vi.waitFor(() => { expect(next.cancel).toHaveBeenCalled() })
  expect(await readFile(destination, 'utf8')).toBe('original')
})

it('cancels in-progress downloads and removes all staging on Host disposal', async () => {
  const item = new Download()
  files.allowDownload(webContents(guest))
  files.download(event(), downloadItem(item), webContents(guest))
  expect(await stat(dirname(item.path))).toBeDefined()
  await files.dispose()
  expect(item.cancel).toHaveBeenCalled()
  await expect(stat(dirname(item.path))).rejects.toThrow()
  expect(prompts.save).not.toHaveBeenCalled()
})

it('rejects oversized downloads before resuming the transfer', async () => {
  const item = new Download()
  item.total = 100 * 1024 * 1024 + 1
  files.allowDownload(webContents(guest))
  files.download(event(), downloadItem(item), webContents(guest))
  expect(item.cancel).toHaveBeenCalled()
  expect(item.resume).not.toHaveBeenCalled()
  await files.dispose()
  await expect(stat(dirname(item.path))).rejects.toThrow()
})
