/** Real reservation policy and IPC admission with Electron event doubles. */
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { app, session, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { DesktopBrowserGuests } from '../src/browser-guests.ts'
import { DesktopBrowserAutomation } from '../src/browser-automation.ts'
import { installBrowserReservationIpc } from '../src/browser-reservation-ipc.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'
import type { DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

vi.mock('electron', () => {
  const partitions = new Map<string, object>()
  return { app: Object.assign(new EventEmitter(), { isPackaged: true }), session: { fromPartition(key: string) {
    if (!partitions.has(key)) partitions.set(key, { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(), on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } })
    return partitions.get(key)
  } } }
})
afterEach(() => { vi.restoreAllMocks(); app.removeAllListeners() })
let nextGuest = 0
function fixture() {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const owner = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })
  const surface: Pick<WebContents, 'send' | 'isDestroyed'> = owner
  const contents = surface as WebContents
  const window = { webContents: contents } as BrowserWindow
  const attached = vi.fn(), failed = vi.fn(), attachInput = vi.fn(() => vi.fn())
  const guests = new DesktopBrowserGuests(() => undefined)
  guests.bind(window, attachInput, attached, failed)
  const reserve = () => guests.acquire(contents, 'fixture')
  const approve = (r: DesktopBrowserReservation, partition = r.partition) => {
    const preferences: Electron.WebPreferences = { preload: '/untrusted.js', nodeIntegration: true }
    const event = { preventDefault: vi.fn() }
    owner.emit('will-attach-webview', event, preferences, { src: `about:blank#${r.lease}`, partition })
    return { preferences, event }
  }
  const guest = (r: DesktopBrowserReservation) => {
    const value = Object.assign(new EventEmitter(), { id: ++nextGuest, hostWebContents: contents,
      session: session.fromPartition(r.partition), getType: () => 'webview',
      getURL: vi.fn(() => 'https://already-navigated.invalid/'), setWindowOpenHandler: vi.fn(),
      isDestroyed: () => false, close: vi.fn(() => { value.emit('destroyed') }) })
    return value
  }
  return { owner, contents, guests, attached, failed, attachInput, reserve, approve, guest }
}

it('binds concurrent guests by their native IDs before dom-ready, regardless of URL or attachment order', async () => {
  const f = fixture(), first = f.reserve(), second = f.reserve()
  const a = f.approve(first)
  const ga = f.guest(first)
  app.emit('web-contents-created', {}, ga)
  f.approve(second)
  const gb = f.guest(second)
  app.emit('web-contents-created', {}, gb)
  expect(a.event.preventDefault).not.toHaveBeenCalled()
  expect(a.preferences).toMatchObject({ nodeIntegration: false, sandbox: true, webviewTag: false })
  expect(a.preferences).not.toHaveProperty('preload')
  f.owner.emit('did-attach-webview', {}, gb)
  f.owner.emit('did-attach-webview', {}, ga)
  expect(f.guests.guest(f.contents, first.lease)).toBe(ga)
  expect(f.guests.guest(f.contents, second.lease)).toBe(gb)
  expect(ga.getURL).not.toHaveBeenCalled()
  expect(f.attached).toHaveBeenNthCalledWith(1, second.lease, gb)
  expect(f.attached).toHaveBeenNthCalledWith(2, first.lease, ga)
  await f.guests.release(f.contents, first.lease)
  expect(() => f.guests.assertOwned(f.contents, first.lease)).toThrow()
  expect(f.guests.guest(f.contents, second.lease)).toBe(gb)
})

it('exposes a partition rejection without attaching or weakening lease ownership', () => {
  const f = fixture(), r = f.reserve()
  const rejected = f.approve(r, 'foreign-partition')
  expect(rejected.event.preventDefault).toHaveBeenCalledOnce()
  expect(f.failed).toHaveBeenCalledWith(r.lease, { code: 'browser-attach-rejected', message: 'Browser webview attachment rejected: partition mismatch' })
  expect(f.attached).not.toHaveBeenCalled()
  const foreign = new EventEmitter() as WebContents
  expect(() => f.guests.assertOwned(foreign, r.lease)).toThrow('another window')
})

it.each(['uncreated', 'host', 'partition', 'duplicate'] as const)('rejects a mismatched %s at did-attach, before dom-ready', (field) => {
  const f = fixture(), r = f.reserve()
  f.approve(r)
  const g = f.guest(r)
  if (field !== 'uncreated') app.emit('web-contents-created', {}, g)
  if (field === 'host') g.hostWebContents = new EventEmitter() as WebContents
  if (field === 'partition') g.session = session.fromPartition('foreign')
  if (field === 'duplicate') {
    f.owner.emit('did-attach-webview', {}, g)
    f.attached.mockClear()
  }
  f.owner.emit('did-attach-webview', {}, g)
  expect(g.close).toHaveBeenCalledOnce()
  expect(f.attached).not.toHaveBeenCalled()
  expect(() => f.guests.guest(f.contents, r.lease)).toThrow(field === 'uncreated' ? 'unavailable' : 'another window')
})

it('production state IPC accepts an owned reservation before attachment and rejects foreign callers', async () => {
  const f = fixture()
  const host = { reserve: () => f.reserve(), present: () => {},
    release: (lease: DesktopBrowserReservation['lease']) => f.guests.release(f.contents, lease),
    publish: vi.fn(), allowed: () => true, selectUpload: async () => [] }
  let automation = new DesktopBrowserAutomation(host)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const assertSender = vi.fn()
  installBrowserReservationIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } },
    assertSender, f.guests, () => automation)
  const call = (channel: string, lease: unknown, value?: unknown, sender = f.contents): unknown =>
    handlers.get(channel)!({ sender } as IpcMainInvokeEvent, lease, value)
  const r = f.reserve()
  expect(call(DESKTOP_IPC.browserClaim, r.lease)).toEqual(r)
  expect(call(DESKTOP_IPC.browserState, r.lease)).toBeUndefined()
  expect(() => call(DESKTOP_IPC.browserState, r.lease, undefined, new EventEmitter() as WebContents)).toThrow('another window')
  expect(() => call(DESKTOP_IPC.browserFailure, r.lease, { code: 'arbitrary', message: 'error' })).toThrow('Invalid')
  expect(() => call(DESKTOP_IPC.browserFailure, r.lease, { code: 'browser-client-initialization-failed', message: 'x'.repeat(501) })).toThrow('Invalid')
  expect(() => call(DESKTOP_IPC.browserFailure, r.lease, { code: 'browser-client-initialization-failed', message: 'bad\nmessage' })).toThrow('Invalid')
  const oldState = vi.spyOn(automation, 'state'), oldFailure = vi.spyOn(automation, 'failed')
  automation = new DesktopBrowserAutomation(host)
  const newState = vi.spyOn(automation, 'state'), newFailure = vi.spyOn(automation, 'failed')
  call(DESKTOP_IPC.browserState, r.lease)
  call(DESKTOP_IPC.browserFailure, r.lease, { code: 'browser-client-initialization-failed', message: 'Browser presentation host unavailable' })
  expect(newState).toHaveBeenCalledWith(r.lease)
  expect(newFailure).toHaveBeenCalledOnce()
  expect(oldState).not.toHaveBeenCalled()
  expect(oldFailure).not.toHaveBeenCalled()
  assertSender.mockImplementationOnce(() => { throw new Error('untrusted sender') })
  expect(() => call(DESKTOP_IPC.browserState, r.lease)).toThrow('untrusted sender')
  await call(DESKTOP_IPC.browserRelease, r.lease)
  expect(() => call(DESKTOP_IPC.browserState, r.lease)).toThrow()
})


it('expires a creation boundary instead of assigning its lease to a later guest', async () => {
  const f = fixture(), r = f.reserve()
  f.approve(r)
  await Promise.resolve()
  expect(f.failed).toHaveBeenCalledWith(r.lease, {
    code: 'browser-guest-not-created', message: 'Electron did not create the approved browser guest during attachment.',
  })
  const late = f.guest(r)
  app.emit('web-contents-created', {}, late)
  f.owner.emit('did-attach-webview', {}, late)
  expect(late.close).toHaveBeenCalledOnce()
  expect(f.attached).not.toHaveBeenCalled()
})

it('ignores another window during creation and removes its app listener with the owner', () => {
  const before = app.listenerCount('web-contents-created')
  const f = fixture(), r = f.reserve()
  f.approve(r)
  const foreign = f.guest(r)
  foreign.hostWebContents = new EventEmitter() as WebContents
  app.emit('web-contents-created', {}, foreign)
  const owned = f.guest(r)
  app.emit('web-contents-created', {}, owned)
  f.owner.emit('did-attach-webview', {}, owned)
  expect(f.guests.guest(f.contents, r.lease)).toBe(owned)
  expect(foreign.close).not.toHaveBeenCalled()
  expect(app.listenerCount('web-contents-created')).toBe(before + 1)
  f.owner.emit('destroyed')
  expect(app.listenerCount('web-contents-created')).toBe(before)
})
