// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserState, BrowserTargetId } from '@deepseek-ai/dsh-browser-use/desktop'
import { electronFixture } from './electron-harness.client.ts'

const initial: DesktopBrowserState = {
  target: 'owned-model-lease' as BrowserTargetId, sessionId: 'owning-session', status: 'initializing', storage: 'temporary',
}
const target = { kind: 'https' as const, url: 'https://example.test/', title: 'Example' }
const fixtures: ReturnType<typeof electronFixture>[] = []
function fixture() {
  const value = electronFixture(undefined, initial)
  fixtures.push(value)
  return value
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.dispose()
  vi.restoreAllMocks()
})

it('reports the initialization diagnosis before releasing the reservation and retains its bounded message', async () => {
  const h = fixture()
  const error = new Error(`Browser target unavailable\n${'x'.repeat(800)}`)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const reported = Promise.withResolvers<undefined>()
  h.bridge.state.mockRejectedValueOnce(error)
  h.bridge.reportFailure.mockReturnValueOnce(reported.promise)
  const unmount = h.mount()
  h.frame.loadUrl(target)
  try {
    await vi.waitFor(() => { expect(h.bridge.reportFailure).toHaveBeenCalledOnce() })
    expect(h.bridge.release).not.toHaveBeenCalled()
    expect(h.guests).toHaveLength(0)
    const diagnosis = h.bridge.reportFailure.mock.calls[0]![1]
    expect(diagnosis.code).toBe('browser-client-initialization-failed')
    expect(diagnosis.message).toHaveLength(500)
    expect(diagnosis.message).toMatch(/^Browser target unavailable x/u)
    expect(diagnosis.message).not.toContain('\n')
    reported.resolve(undefined)
    await vi.waitFor(() => { expect(h.frame.getSnapshot().error?.description).toBe(diagnosis.message) })
    expect(h.frame.getSnapshot()).toMatchObject({ loading: false, error: { code: undefined } })
    expect(log).toHaveBeenCalledWith('Desktop browser operation failed', error)
    expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
    unmount()
    h.mount()
    await Promise.resolve()
    expect(h.bridge.claim).toHaveBeenCalledOnce()
    expect(h.guests).toHaveLength(0)
  } finally { reported.resolve(undefined) }
})

it('preserves the original initialization failure when reporting it also fails', async () => {
  const h = fixture()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.bridge.state.mockRejectedValueOnce(new Error('State unavailable before attachment'))
  const reportError = new Error('Host disconnected while reporting')
  h.bridge.reportFailure.mockRejectedValueOnce(reportError)
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error?.description).toBe('State unavailable before attachment') })
  expect(log).toHaveBeenCalledWith('Desktop browser failure report failed', reportError)
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  expect(h.guests).toHaveLength(0)
})

it('does not report a failure that arrives after the user disposes the tab', async () => {
  const h = fixture()
  const state = Promise.withResolvers<DesktopBrowserState | undefined>()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.bridge.state.mockReturnValueOnce(state.promise)
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.state).toHaveBeenCalledOnce() })
  const disposed = h.frame.dispose()
  state.reject(new Error('Late state rejection'))
  await disposed
  expect(h.bridge.reportFailure).not.toHaveBeenCalled()
  expect(log).not.toHaveBeenCalled()
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  expect(h.guests).toHaveLength(0)
})

it.each(['disconnected', 'stopped'] as const)('retains a Host %s failure over a late initial state and never attaches or replays it', async (status) => {
  const h = fixture()
  const baseline = Promise.withResolvers<DesktopBrowserState | undefined>()
  h.bridge.state.mockReturnValueOnce(baseline.promise)
  const unmount = h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.bridge.state).toHaveBeenCalledOnce() })
  const failure = { code: 'browser-attach-timeout', message: 'Browser guest attachment timed out.' }
  for (const listener of [...h.states]) listener({ ...initial, status, failure })
  baseline.resolve(initial)
  await vi.waitFor(() => { expect(h.bridge.release).toHaveBeenCalledOnce() })
  expect(h.frame.getSnapshot()).toMatchObject({ loading: false, automation: { status, failure }, error: { description: failure.message } })
  expect(h.guests).toHaveLength(0)
  unmount()
  h.mount()
  await Promise.resolve()
  expect(h.bridge.claim).toHaveBeenCalledOnce()
  expect(h.bridge.reportFailure).not.toHaveBeenCalled()
  expect(h.states.size).toBe(0)
})

it('retains a stopped live guest for manual use and drops its pending automatic navigation', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  for (const listener of [...h.states]) listener({ ...initial, status: 'stopped' })
  expect(h.frame.getSnapshot()).toMatchObject({ loading: false, automation: { status: 'stopped' } })
  expect(h.bridge.release).not.toHaveBeenCalled()
  guest.emit('dom-ready')
  expect(guest.loadURL).not.toHaveBeenCalled()
  await h.frame.control?.('resume')
  expect(h.bridge.control).toHaveBeenCalledWith(h.reservation.lease, 'resume')
})

it('shows a command rejection message without fabricating a browser error code', async () => {
  const h = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.loadURL.mockRejectedValueOnce(new Error('Guest loadURL rejected\tfor this target'))
  guest.emit('dom-ready')
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toEqual({ code: undefined, description: 'Guest loadURL rejected for this target' }) })
  expect(h.bridge.reportFailure).not.toHaveBeenCalled()
})

it('reports an attachment rejection and still receives the Host reason after dropping the guest', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.emit('destroyed')
  await vi.waitFor(() => { expect(h.bridge.release).toHaveBeenCalledOnce() })
  expect(h.bridge.reportFailure).toHaveBeenCalledWith(h.reservation.lease, {
    code: 'browser-client-initialization-failed', message: 'Browser guest destroyed before its next observation.',
  })
  const failure = { code: 'browser-attachment-rejected', message: 'Guest partition did not match its reservation.' }
  for (const listener of [...h.states]) listener({ ...initial, status: 'disconnected', failure })
  expect(h.frame.getSnapshot()).toMatchObject({ loading: false, automation: { status: 'disconnected' }, error: { description: failure.message } })
  expect(guest.loadURL).not.toHaveBeenCalled()
})

it('keeps Host state delivery after a ready guest disappears without reporting another initialization failure', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.emit('dom-ready')
  for (const listener of [...h.states]) listener({ ...initial, status: 'ready' })
  guest.emit('render-process-gone')
  for (const listener of [...h.states]) listener({ ...initial, status: 'disconnected' })
  expect(h.frame.getSnapshot()).toMatchObject({ loading: false, automation: { status: 'disconnected' }, error: { description: 'Browser guest render-process-gone before its next observation.' } })
  expect(h.bridge.reportFailure).not.toHaveBeenCalled()
  expect(h.bridge.release).toHaveBeenCalledOnce()
})
