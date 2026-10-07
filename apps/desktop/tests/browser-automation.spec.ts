/** Exact guest ownership and cancellation with protocol doubles; no browser or OS input. */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { WebContents } from 'electron'
import type { BrowserOwner, BrowserTargetId, DesktopBrowserOperation } from '@deepseek-ai/dsh-browser-use/desktop'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopBrowserAutomation, type BrowserAutomationHost } from '../src/browser-automation.ts'
import { parseBrowserRequest } from '../src/browser-request.ts'
const fixturePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII='

function paintingOwner(): WebContents {
  const owner: Pick<WebContents, 'isDestroyed' | 'getBackgroundThrottling' | 'setBackgroundThrottling'> = {
    isDestroyed: () => false, getBackgroundThrottling: () => true, setBackgroundThrottling: () => {},
  }
  return owner as WebContents
}

class Guest extends EventEmitter {
  destroyed = false
  hostWebContents = paintingOwner()
  debugger = {
    isAttached: vi.fn(() => true), attach: vi.fn(),
    sendCommand: vi.fn(async (method: string, _params?: object): Promise<unknown> => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 41, role: { value: 'button' }, name: { value: 'Submit fixture' } }] }
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } }
      if (method === 'Page.captureScreenshot') return { data: fixturePng }
      return {}
    }),
  }
  focus = vi.fn()
  getBackgroundThrottling = vi.fn(() => true)
  setBackgroundThrottling = vi.fn()
  insertText = vi.fn(async (_text: string) => {})
  loadURL = vi.fn(async (_url: string) => {})
  getURL(): string { return 'https://fixture.invalid/' }
  getTitle(): string { return 'Fixture' }
  isDestroyed(): boolean { return this.destroyed }
  navigate(): void { this.emit('did-start-navigation', {}, 'https://fixture.invalid/next', false, true) }
  destroy(): void { this.destroyed = true; this.emit('destroyed') }
}

function webContents(guest: Guest): WebContents {
  const surface: Pick<WebContents, 'isDestroyed' | 'getURL' | 'getTitle' | 'focus' | 'insertText' | 'loadURL'> = guest
  return surface as WebContents
}

const first: BrowserOwner = { sessionId: 'first', activationId: 'first-activation' as BrowserOwner['activationId'] }
const second: BrowserOwner = { sessionId: 'second', activationId: 'second-activation' as BrowserOwner['activationId'] }
let automation: DesktopBrowserAutomation
let guests: Map<string, Guest>
let host: { [K in keyof BrowserAutomationHost]: Mock<BrowserAutomationHost[K]> }

beforeEach(() => {
  guests = new Map()
  let next = 0
  host = {
    reserve: vi.fn<BrowserAutomationHost['reserve']>(() => ({ lease: `lease-${String(++next)}` as DesktopBrowserLeaseId, partition: 'temporary-fixture' })),
    present: vi.fn<BrowserAutomationHost['present']>((_owner, reservation) => {
      const guest = new Guest()
      guests.set(reservation.lease, guest)
      automation.attached(reservation.lease, webContents(guest))
    }),
    release: vi.fn<BrowserAutomationHost['release']>(async (lease) => { guests.get(lease)?.destroy() }),
    publish: vi.fn<BrowserAutomationHost['publish']>(),
    allowed: vi.fn<BrowserAutomationHost['allowed']>(value => value.startsWith('https://fixture.invalid/')),
    selectUpload: vi.fn<BrowserAutomationHost['selectUpload']>(async () => []),
  }
  automation = new DesktopBrowserAutomation(host)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => { await automation.dispose(); vi.restoreAllMocks(); vi.useRealTimers() })

function request(operation: DesktopBrowserOperation, owner = first, signal = new AbortController().signal) {
  return automation.request({ owner, operation }, signal)
}
async function open(owner = first): Promise<BrowserTargetId> {
  const result = await request({ action: 'open', url: 'https://fixture.invalid/' }, owner)
  expect(result.status).toBe('delivered')
  if (result.target === undefined) throw new Error('fixture target missing')
  return result.target
}
async function observe(target: BrowserTargetId, owner = first) {
  const result = await request({ action: 'observe', target }, owner)
  expect(result.status).toBe('observed')
  if (result.snapshot === undefined) throw new Error('fixture observation missing')
  return result.snapshot
}

it('rejects foreign sessions and stale activations before touching their exact guest', async () => {
  const target = await open()
  const other = await open(second)
  for (const owner of [second, { ...first, activationId: second.activationId }, { ...second, activationId: first.activationId }]) {
    expect((await request({ action: 'observe', target }, owner)).status).toBe('stale-target')
    expect((await request({ action: 'close', target }, owner)).status).toBe('stale-target')
  }
  expect(guests.get(target)!.debugger.sendCommand).not.toHaveBeenCalled()
  expect((await request({ action: 'list' })).data).toEqual([expect.objectContaining({ target, sessionId: first.sessionId })])
  expect((await request({ action: 'list' }, second)).data).toEqual([expect.objectContaining({ target: other })])
})

it('denies unsafe addresses without allocating a guest and validates finite model operations', async () => {
  expect((await request({ action: 'open', url: 'file:///private/example' })).status).toBe('denied')
  expect(host.reserve).not.toHaveBeenCalled()
  const target = await open()
  expect((await request({ action: 'navigate', target, url: 'javascript:alert(1)' })).status).toBe('denied')
  expect(guests.get(target)!.loadURL).not.toHaveBeenCalled()
  for (const operation of [
    { action: 'evaluate', target, expression: 'secret()' },
    { action: 'wait', target, text: 'ready', timeoutMs: 30_001 },
    { action: 'scroll', target, snapshot: 'snapshot', delta: Infinity },
    { action: 'fill', target, snapshot: 'snapshot', element: 'e0', text: 'x'.repeat(32_769) },
  ]) expect(() => parseBrowserRequest({ owner: first, operation })).toThrow()
})

it('consumes snapshots after action and invalidates them on navigation', async () => {
  const target = await open()
  const snapshot = await observe(target)
  expect((await request({ action: 'click', target, snapshot, element: 'e0' })).status).toBe('delivered')
  expect(guests.get(target)!.debugger.sendCommand).toHaveBeenCalledWith('DOM.scrollIntoViewIfNeeded', { backendNodeId: 41 })
  expect((await request({ action: 'click', target, snapshot, element: 'e0' })).status).toBe('stale-snapshot')
  const next = await observe(target)
  guests.get(target)!.navigate()
  expect((await request({ action: 'fill', target, snapshot: next, element: 'e0', text: 'blocked' })).status).toBe('stale-snapshot')
  expect(guests.get(target)!.insertText).not.toHaveBeenCalled()
})

it('rejects an observation whose accessibility response crossed a navigation', async () => {
  const target = await open()
  const guest = guests.get(target)!
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish = Promise.withResolvers<unknown>()
  guest.debugger.sendCommand.mockImplementationOnce(async () => { started.resolve(); return finish.promise })
  const pending = request({ action: 'observe', target })
  await started.promise
  guest.navigate()
  finish.resolve({ nodes: [] })
  expect((await pending).status).toBe('stale-snapshot')
})

it('does not dispatch coordinates after navigation during the box lookup', async () => {
  const target = await open()
  const snapshot = await observe(target)
  const guest = guests.get(target)!
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish = Promise.withResolvers<unknown>()
  const original = guest.debugger.sendCommand.getMockImplementation()!
  guest.debugger.sendCommand.mockImplementation(async (method, params) => {
    if (method !== 'DOM.getBoxModel') return original(method, params)
    started.resolve(); return finish.promise
  })
  const pending = request({ action: 'click', target, snapshot, element: 'e0' })
  await started.promise
  guest.navigate()
  finish.resolve({ model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } })
  expect((await pending).status).toBe('uncertain')
  expect(guest.debugger.sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false)
})

it.each(['stop', 'takeover'] as const)('%s cancels running and queued actions and requires a fresh observation after resume', async (action) => {
  const target = await open()
  const snapshot = await observe(target)
  const guest = guests.get(target)!
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish = Promise.withResolvers<unknown>()
  const original = guest.debugger.sendCommand.getMockImplementation()!
  guest.debugger.sendCommand.mockImplementation(async (method, params) => {
    if (method !== 'Input.dispatchMouseEvent') return original(method, params)
    started.resolve(); return finish.promise
  })
  const running = request({ action: 'click', target, snapshot, element: 'e0' })
  await started.promise
  const queued = request({ action: 'observe', target })
  const cancelled = expect(queued).rejects.toThrow()
  const stopping = automation.control(target, action)
  finish.resolve({})
  await stopping
  await cancelled
  expect((await running).status).toBe('uncertain')
  expect(guest.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent')).toHaveLength(1)
  expect((await request({ action: 'observe', target })).status).toBe('denied')
  await automation.control(target, 'resume')
  expect((await request({ action: 'click', target, snapshot, element: 'e0' })).status).toBe('stale-snapshot')
  expect(await observe(target)).not.toBe(snapshot)
})

it('reports uncertainty when insertion completes after navigation instead of claiming verified input', async () => {
  const target = await open()
  const snapshot = await observe(target)
  const guest = guests.get(target)!
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish: PromiseWithResolvers<void> = Promise.withResolvers()
  guest.insertText.mockImplementation(async () => { started.resolve(); return finish.promise })
  const pending = request({ action: 'fill', target, snapshot, element: 'e0', text: 'fixture' })
  await started.promise
  guest.navigate()
  finish.resolve()
  expect((await pending).status).toBe('uncertain')
  expect(guest.focus).toHaveBeenCalledOnce()
})

it('does not upload after the native file selector returns to a different page', async () => {
  const target = await open()
  const snapshot = await observe(target)
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish = Promise.withResolvers<string[]>()
  vi.mocked(host.selectUpload).mockImplementation(async () => { started.resolve(); return finish.promise })
  const pending = request({ action: 'upload', target, snapshot, element: 'e0' })
  await started.promise
  guests.get(target)!.navigate()
  finish.resolve(['/fixture/private-stage.txt'])
  expect((await pending).status).toBe('stale-snapshot')
  expect(guests.get(target)!.debugger.sendCommand.mock.calls.some(([method]) => method === 'DOM.setFileInputFiles')).toBe(false)
})

it('retires the released activation, preserves other sessions, and admits a new activation', async () => {
  const target = await open()
  const other = await open(second)
  expect((await request({ action: 'release' })).status).toBe('closed')
  expect(automation.state(target)).toBeUndefined()
  expect(automation.state(other)).toBeDefined()
  expect((await request({ action: 'open', url: 'https://fixture.invalid/' })).status).toBe('stale-target')
  const fresh = { ...first, activationId: 'replacement-activation' as BrowserOwner['activationId'] }
  expect(await open(fresh)).not.toBe(target)
})

it('releases a reservation when presentation fails before the guest attaches', async () => {
  vi.mocked(host.present).mockImplementationOnce(() => { throw new Error('renderer unavailable') })
  await expect(request({ action: 'open', url: 'https://fixture.invalid/' })).rejects.toThrow('renderer unavailable')
  expect(host.release).toHaveBeenCalledOnce()
  expect((await request({ action: 'list' })).data).toEqual([])
})

it('disposal closes guests and permanently rejects further admission on the old Host', async () => {
  const target = await open()
  await automation.dispose()
  expect(automation.state(target)).toBeUndefined()
  const result = await request({ action: 'open', url: 'https://fixture.invalid/' }).catch(() => undefined)
  expect(result?.status).not.toBe('delivered')
  expect(host.reserve).toHaveBeenCalledOnce()
})

it('disposes an opening guest once and cancels the renderer attachment wait', async () => {
  vi.useFakeTimers()
  host.present.mockImplementationOnce(() => {})
  const pending = request({ action: 'open', url: 'https://fixture.invalid/' })
  const cancelled = expect(pending).rejects.toThrow()
  await automation.dispose()
  await vi.advanceTimersByTimeAsync(40)
  await cancelled
  expect(host.release).toHaveBeenCalledOnce()
  expect(automation.state('lease-1')).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['stop', 'takeover'] as const)('does not revive an initializing target after %s when its guest attaches late', async (action) => {
  vi.useFakeTimers()
  const reservations: ReturnType<BrowserAutomationHost['reserve']>[] = []
  host.present.mockImplementationOnce((_owner, reservation) => { reservations.push(reservation) })
  const opening = request({ action: 'open', url: 'https://fixture.invalid/' })
  const cancelled = expect(opening).rejects.toThrow()
  const reservation = reservations[0]
  if (reservation === undefined) throw new Error('fixture reservation missing')
  const target = reservation.lease as string as BrowserTargetId
  const guest = new Guest()
  guests.set(reservation.lease, guest)

  await automation.control(target, action)
  automation.attached(reservation.lease, webContents(guest))
  expect(automation.state(target)?.status).toBe(action === 'stop' ? 'stopped' : 'taken-over')
  expect(host.publish.mock.calls.some(([state]) => state.status === 'ready')).toBe(false)
  expect((await request({ action: 'observe', target })).status).toBe('denied')
  expect((await request({ action: 'navigate', target, url: 'https://fixture.invalid/blocked' })).status).toBe('denied')
  expect(guest.debugger.sendCommand).not.toHaveBeenCalled()
  expect(guest.loadURL).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(40)
  await cancelled
  expect(host.release).toHaveBeenCalledOnce()
  expect(guest.destroyed).toBe(true)
  expect(automation.state(target)).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('settles concurrent close calls through one owned guest release', async () => {
  const target = await open()
  const close = request({ action: 'close', target })
  const duplicate = request({ action: 'close', target })
  expect((await close).status).toBe('closed')
  expect((await duplicate).status).toBe('closed')
  expect(host.release).toHaveBeenCalledOnce()
})

it('does not let an older pending resume override a newer stop request', async () => {
  const target = await open()
  const snapshot = await observe(target)
  const guest = guests.get(target)!
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish: PromiseWithResolvers<void> = Promise.withResolvers()
  guest.insertText.mockImplementation(async () => { started.resolve(); return finish.promise })
  const action = request({ action: 'fill', target, snapshot, element: 'e0', text: 'fixture' })
  await started.promise
  const takeover = automation.control(target, 'takeover')
  const resume = automation.control(target, 'resume').catch(() => undefined)
  const stop = automation.control(target, 'stop')
  finish.resolve()
  await Promise.all([action, takeover, resume, stop])
  expect(automation.state(target)?.status).toBe('stopped')
  expect((await request({ action: 'observe', target })).status).toBe('denied')
})

it('returns the reported initialization cause immediately and preserves a failed toolbar state while releasing', async () => {
  host.present.mockImplementationOnce((_owner, reservation) => {
    automation.failed(reservation.lease, { code: 'browser-client-initialization-failed', message: 'Browser presentation host unavailable' })
  })
  const result = await request({ action: 'open', url: 'https://fixture.invalid/' })
  expect(result).toMatchObject({ status: 'unavailable', message: 'Browser presentation host unavailable', data: { failure: { code: 'browser-client-initialization-failed' } } })
  expect(host.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disconnected', failure: { code: 'browser-client-initialization-failed', message: result.message } }))
  expect(host.release).toHaveBeenCalledOnce()
  expect((await request({ action: 'list' })).data).toEqual([])
})

it('labels an unreported attachment timeout and releases the reservation', async () => {
  vi.useFakeTimers()
  host.present.mockImplementationOnce(() => {})
  const pending = request({ action: 'open', url: 'https://fixture.invalid/' })
  await vi.advanceTimersByTimeAsync(15_040)
  expect(await pending).toMatchObject({ status: 'unavailable', data: { failure: { code: 'browser-attach-timeout' } } })
  expect(host.release).toHaveBeenCalledOnce()
  expect(host.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disconnected' }))
})

it.each([undefined, '', '   ', '\0', 'x'.repeat(8193)])('identifies the missing or malformed open url without a generic text error', (url) => {
  expect(() => parseBrowserRequest({ owner: first, operation: { action: 'open', url } })).toThrow('Browser open requires a non-empty url')
})


it('releases a guest that disconnects between attachment and the open result', async () => {
  host.present.mockImplementationOnce((_owner, reservation) => {
    const guest = new Guest()
    guests.set(reservation.lease, guest)
    automation.attached(reservation.lease, webContents(guest))
    guest.destroy()
  })
  const result = await request({ action: 'open', url: 'https://fixture.invalid/' })
  expect(result).toMatchObject({ status: 'unavailable', data: { failure: { code: 'browser-guest-disconnected' } } })
  expect(host.release).toHaveBeenCalledOnce()
  expect((await request({ action: 'list' })).data).toEqual([])
})

it.each(['stop', 'takeover'] as const)('%s settles even when Chromium never acknowledges input and refuses overlapping resume', async (action) => {
  const target = await open(), snapshot = await observe(target)
  const guest = guests.get(target)!
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish = Promise.withResolvers<unknown>()
  guest.debugger.sendCommand.mockImplementationOnce(() => { started.resolve(); return finish.promise })
  const pending = request({ action: 'scroll', target, snapshot, delta: 300 })
  await started.promise
  expect((await automation.control(target, action)).status).toBe(action === 'stop' ? 'stopped' : 'taken-over')
  expect((await pending).status).toBe('uncertain')
  await expect(automation.control(target, 'resume')).rejects.toThrow('still settling')
  const calls = guest.debugger.sendCommand.mock.calls.length
  expect((await request({ action: 'observe', target })).status).toBe('denied')
  expect(guest.debugger.sendCommand).toHaveBeenCalledTimes(calls)
  finish.resolve({})
  await finish.promise
  await automation.control(target, 'resume')
  expect(await observe(target)).not.toBe(snapshot)
})

it('bounds a stuck native operation, cancels queued input, and can close its exact guest', async () => {
  vi.useFakeTimers()
  const target = await open(), snapshot = await observe(target)
  const guest = guests.get(target)!
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  guest.debugger.sendCommand.mockImplementationOnce(() => { started.resolve(); return new Promise(() => {}) })
  const pending = request({ action: 'scroll', target, snapshot, delta: 300 })
  await started.promise
  const queued = request({ action: 'press', target, snapshot, key: 'Enter' })
  const cancelled = expect(queued).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await pending).toMatchObject({ status: 'uncertain', data: { failure: { code: 'browser-operation-timeout' } } })
  await cancelled
  expect(guest.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent')).toHaveLength(1)
  expect(guest.debugger.sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchKeyEvent')).toBe(false)
  expect((await request({ action: 'close', target })).status).toBe('closed')
  expect(guest.destroyed).toBe(true)
  expect(host.release).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('caller cancellation settles a stuck capture and disposal closes without awaiting the lost response', async () => {
  const target = await open(), guest = guests.get(target)!, controller = new AbortController()
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  guest.debugger.sendCommand.mockImplementationOnce(() => { started.resolve(); return new Promise(() => {}) })
  const pending = request({ action: 'screenshot', target }, first, controller.signal)
  await started.promise
  controller.abort()
  const failure = await pending
  expect(failure.status).toBe('uncertain')
  expect(failure.message).toContain('No image is available')
  await automation.dispose()
  expect(guest.destroyed).toBe(true)
})

it('identifies a screenshot timeout without attributing it to user input or allowing a late image', async () => {
  vi.useFakeTimers()
  const target = await open(), guest = guests.get(target)!
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish = Promise.withResolvers<unknown>()
  guest.debugger.sendCommand.mockImplementationOnce(() => { started.resolve(); return finish.promise })
  const pending = request({ action: 'screenshot', target })
  await started.promise
  await vi.advanceTimersByTimeAsync(30_000)
  const failure = await pending
  expect(failure).toMatchObject({ status: 'uncertain', data: { failure: { code: 'browser-operation-timeout' } } })
  expect(failure.message).toContain('Browser screenshot timed out. No image is available')
  expect(failure.image).toBeUndefined()
  const denied = await request({ action: 'observe', target })
  expect(denied.status).toBe('denied')
  expect(denied.message).toContain('stopped after browser-operation-timeout')
  expect(denied.message).not.toContain('user')
  await expect(automation.control(target, 'resume')).rejects.toThrow('still settling')
  finish.resolve({ data: fixturePng })
  await finish.promise
  expect(failure.image).toBeUndefined()
  expect(automation.state(target)?.status).toBe('stopped')
  expect((await request({ action: 'close', target })).status).toBe('closed')
})

it('rejects a capture crossing navigation and never publishes empty image evidence', async () => {
  const target = await open(), guest = guests.get(target)!
  guest.debugger.sendCommand.mockImplementationOnce(async () => { guest.navigate(); return { data: fixturePng } })
  expect((await request({ action: 'screenshot', target })).status).toBe('stale-snapshot')
  const snapshot = await observe(target)
  guest.debugger.sendCommand.mockResolvedValueOnce({ data: '' })
  const empty = await request({ action: 'screenshot', target })
  expect(empty.status).toBe('unavailable')
  expect(empty.image).toBeUndefined()
  expect((await request({ action: 'fill', target, snapshot, element: 'e0', text: 'must not be delivered' })).status).toBe('stale-snapshot')
  expect(guest.insertText).not.toHaveBeenCalled()
  expect((await request({ action: 'screenshot', target })).image?.data).toBeDefined()
  expect(guest.debugger.sendCommand).toHaveBeenLastCalledWith('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  expect(guest.setBackgroundThrottling.mock.calls).toEqual(Array.from({ length: 5 }, () => [[false], [true]]).flat())
})

it('reports a rejected capture as a failed read and expires prior input references', async () => {
  const target = await open(), guest = guests.get(target)!, snapshot = await observe(target)
  guest.debugger.sendCommand.mockRejectedValueOnce(new Error('capture failed at https://private.invalid/'))
  const failure = await request({ action: 'screenshot', target })
  expect(failure.status).toBe('unavailable')
  expect(failure.message).toContain('Browser screenshot failed. No image is available')
  expect(failure.message).not.toContain('private.invalid')
  expect(failure.image).toBeUndefined()
  expect((await request({ action: 'fill', target, snapshot, element: 'e0', text: 'must not be delivered' })).status).toBe('stale-snapshot')
  expect(guest.insertText).not.toHaveBeenCalled()
})

it('keeps one owner painting until concurrent captures on both of its guests finish', async () => {
  const target = await open(), other = await open(second), owner = new Guest()
  const firstGuest = guests.get(target)!, secondGuest = guests.get(other)!
  firstGuest.hostWebContents = secondGuest.hostWebContents = webContents(owner)
  const firstStarted: PromiseWithResolvers<void> = Promise.withResolvers()
  const secondStarted: PromiseWithResolvers<void> = Promise.withResolvers()
  const firstCapture = Promise.withResolvers<unknown>(), secondCapture = Promise.withResolvers<unknown>()
  firstGuest.debugger.sendCommand.mockImplementationOnce(() => { firstStarted.resolve(); return firstCapture.promise })
  secondGuest.debugger.sendCommand.mockImplementationOnce(() => { secondStarted.resolve(); return secondCapture.promise })
  const pending = request({ action: 'screenshot', target })
  const concurrent = request({ action: 'screenshot', target: other }, second)
  await Promise.all([firstStarted.promise, secondStarted.promise])
  expect(owner.setBackgroundThrottling.mock.calls).toEqual([[false]])
  firstCapture.resolve({ data: fixturePng })
  expect((await pending).status).toBe('observed')
  expect(owner.setBackgroundThrottling.mock.calls).toEqual([[false]])
  secondCapture.resolve({ data: fixturePng })
  expect((await concurrent).status).toBe('observed')
  expect(owner.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
  expect(owner.focus).not.toHaveBeenCalled()
})

it('restores the original owner setting when its capture is cancelled and leaves late work stopped', async () => {
  const target = await open(), guest = guests.get(target)!, owner = new Guest()
  owner.getBackgroundThrottling.mockReturnValue(false)
  guest.hostWebContents = webContents(owner)
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const capture = Promise.withResolvers<unknown>(), controller = new AbortController()
  guest.debugger.sendCommand.mockImplementationOnce(() => { started.resolve(); return capture.promise })
  const pending = request({ action: 'screenshot', target }, first, controller.signal)
  await started.promise
  controller.abort()
  expect((await pending).status).toBe('uncertain')
  expect(owner.setBackgroundThrottling.mock.calls).toEqual([[false], [false]])
  await expect(automation.control(target, 'resume')).rejects.toThrow('still settling')
  capture.resolve({ data: fixturePng })
  await capture.promise
  expect(automation.state(target)?.status).toBe('stopped')
  expect(owner.setBackgroundThrottling).toHaveBeenCalledTimes(2)
})

it('releases a painting owner that is destroyed while its guest is closing', async () => {
  const target = await open(), guest = guests.get(target)!, owner = new Guest()
  guest.hostWebContents = webContents(owner)
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  guest.debugger.sendCommand.mockImplementationOnce(() => { started.resolve(); return new Promise(() => {}) })
  const pending = request({ action: 'screenshot', target })
  await started.promise
  owner.destroy()
  expect((await request({ action: 'close', target })).status).toBe('closed')
  expect((await pending).status).toBe('uncertain')
  expect(owner.setBackgroundThrottling.mock.calls).toEqual([[false]])
  expect(guest.destroyed).toBe(true)
})

it('clears its deadline when the guest rendering getter fails', async () => {
  vi.useFakeTimers()
  const target = await open(), guest = guests.get(target)!
  guest.getBackgroundThrottling.mockImplementationOnce(() => { throw new Error('Guest unavailable') })
  expect((await request({ action: 'screenshot', target })).status).toBe('unavailable')
  expect(vi.getTimerCount()).toBe(0)
  expect(automation.state(target)?.status).not.toBe('running')
  expect(guest.debugger.sendCommand).not.toHaveBeenCalled()
})

it('restores the owner and stops further input when restoring its guest setting fails', async () => {
  const target = await open(), guest = guests.get(target)!, owner = new Guest()
  guest.hostWebContents = webContents(owner)
  guest.setBackgroundThrottling.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('Restore failed') })
  expect((await request({ action: 'screenshot', target })).status).toBe('observed')
  expect(owner.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
  expect(automation.state(target)).toMatchObject({ status: 'stopped', failure: { code: 'browser-rendering-restore-failed' } })
  expect((await request({ action: 'observe', target })).status).toBe('denied')
  expect((await request({ action: 'close', target })).status).toBe('closed')
})
