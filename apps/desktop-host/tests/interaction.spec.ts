/** Trusted Host IPC correlation and Cordis teardown; no child process, account or native input. */
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BrowserOwner } from '@deepseek-ai/dsh-browser-use/desktop'
import type { ComputerAuthorizationRequest } from '@deepseek-ai/dsh-computer-use/authorization'
import type { BrowserInteractionController, BrowserInteractionState } from '@deepseek-ai/dsh-experimental-browser-use-runtime/control'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installDesktopInteraction } from '../src/interaction.ts'

const owner: BrowserOwner = { sessionId: 'fixture-session', activationId: 'fixture-activation' as BrowserOwner['activationId'] }
const authorization: ComputerAuthorizationRequest = {
  requestId: 'fixture-request' as ComputerAuthorizationRequest['requestId'], sessionId: owner.sessionId,
  activationId: 'native-activation' as ComputerAuthorizationRequest['activationId'], requestDigest: 'fixture-digest',
  expiresAt: Date.now() + 60_000, summary: 'Fixture native request', resourceJson: '{"profile":"fixture-only"}',
}
let ctx: Context
let channel: EventEmitter
let sent: Record<string, unknown>[]
let callbacks: ((error: Error | null) => void)[]
let live: Agent
let ipc: { connected: boolean; send: ReturnType<typeof vi.fn> }

beforeEach(() => {
  channel = new EventEmitter()
  sent = []
  callbacks = []
  ipc = {
    connected: true,
    send: vi.fn((value: Record<string, unknown>, callback: (error: Error | null) => void) => {
      sent.push(value); callbacks.push(callback); return true
    }),
  }
  // Preserve ordinary process members while isolating only this module's IPC surface.
  vi.stubGlobal('process', { ...process, get connected() { return ipc.connected }, send: ipc.send, on: channel.on.bind(channel), off: channel.off.bind(channel) })
  ctx = new Context()
  live = { id: 'fixture-session' as Agent['id'] } as Agent
  const registry: Pick<Context['agents'], 'get'> = { get: () => live }
  ctx.provide('agents', registry as Context['agents'])
  installDesktopInteraction(ctx)
})
afterEach(async () => { await ctx.fiber.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

function browser(signal = new AbortController().signal) {
  return ctx.desktopBrowser.request({ owner, operation: { action: 'list' } }, signal)
}
function respond(requestId: unknown, value: unknown): void { channel.emit('message', { type: 'desktop-interaction-result', requestId, value }) }
function controller() {
  const listeners = new Set<() => void>()
  const unsubscribe = vi.fn()
  const state: BrowserInteractionState = { provider: 'fixture', mode: 'isolated', status: 'ready' }
  const control = {
    state: () => state,
    stop: vi.fn(async (_kind: 'stopped' | 'taken-over') => {}),
    resume: vi.fn(async () => {}),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); unsubscribe() } },
  } satisfies BrowserInteractionController
  return { control, listeners, unsubscribe }
}

it('correlates out-of-order replies without leaking one request result into another', async () => {
  const first = browser()
  const second = browser()
  expect(sent[0]).toMatchObject({ type: 'desktop-interaction', kind: 'browser', value: { owner, operation: { action: 'list' } } })
  expect(sent[0]!.requestId).not.toBe(sent[1]!.requestId)
  respond(999, { status: 'observed', message: 'foreign' })
  respond(sent[1]!.requestId, { status: 'observed', message: 'second' })
  respond(sent[0]!.requestId, { status: 'observed', message: 'first' })
  expect((await first).message).toBe('first')
  expect((await second).message).toBe('second')
})

it.each(['allow', 'deny', 'cancel', 'unexpected', { action: 'allow' }] as const)('accepts only explicit native authorization decisions: %j', async (decision) => {
  const pending = ctx.computerAuthorization.request(authorization, new AbortController().signal)
  expect(sent[0]).toMatchObject({ kind: 'authorization', value: authorization })
  respond(sent[0]!.requestId, decision)
  expect(await pending).toBe(decision === 'allow' || decision === 'deny' ? decision : 'cancel')
})

it('forwards native revocation and masks bridge exception detail from callers', async () => {
  const revoked = ctx.computerAuthorization.revoke(authorization.activationId)
  expect(sent[0]).toMatchObject({ kind: 'authorization-revoke', value: { activationId: authorization.activationId } })
  respond(sent[0]!.requestId, null)
  await revoked
  const pending = browser()
  channel.emit('message', { type: 'desktop-interaction-result', requestId: sent[1]!.requestId, error: '/private/profile/credential detail' })
  await expect(pending).rejects.toThrow('Desktop interaction failed; observe current state before retrying')
})

it('rejects malformed browser replies at the transport boundary', async () => {
  for (const value of [null, [], { status: 'observed' }, { status: 'observed', message: 7 }, { status: 'unexpected', message: 'bad status' }]) {
    const pending = browser()
    respond(sent.at(-1)!.requestId, value)
    await expect(pending).rejects.toThrow('Invalid Desktop browser response')
  }
})

it('never sends pre-cancelled work and retires cancelled replies without replay', async () => {
  const pre = new AbortController()
  pre.abort()
  await expect(browser(pre.signal)).rejects.toThrow()
  expect(sent).toHaveLength(0)
  const abort = new AbortController()
  const pending = browser(abort.signal)
  const id = sent[0]!.requestId
  abort.abort()
  await expect(pending).rejects.toThrow('already delivered input may have completed')
  expect(sent[1]).toEqual({ type: 'desktop-interaction-cancel', requestId: id })
  respond(id, { status: 'delivered', message: 'late result' })
  const next = browser()
  respond(sent[2]!.requestId, { status: 'observed', message: 'fresh' })
  expect((await next).message).toBe('fresh')
})

it('bounds a missing Desktop reply and sends cancellation when the deadline expires', async () => {
  vi.useFakeTimers()
  const pending = browser()
  const rejection = expect(pending).rejects.toThrow('cancelled')
  await vi.advanceTimersByTimeAsync(120_000)
  await rejection
  expect(sent[1]).toEqual({ type: 'desktop-interaction-cancel', requestId: sent[0]!.requestId })
  expect(vi.getTimerCount()).toBe(0)
})

it('settles pending work immediately on disconnect and refuses stale service references', async () => {
  const service = ctx.desktopBrowser
  const pending = browser()
  ipc.connected = false
  channel.emit('disconnect')
  await expect(pending).rejects.toThrow('disconnected')
  await expect(service.request({ owner, operation: { action: 'list' } }, new AbortController().signal)).rejects.toThrow('disconnected')
  expect(sent).toHaveLength(1)
})

it('contains both synchronous send failures and asynchronous send callback failures', async () => {
  ipc.send.mockImplementationOnce(() => { throw new Error('fixture pipe failure') })
  await expect(browser()).rejects.toThrow('fixture pipe failure')
  const pending = browser()
  callbacks.at(-1)!(new Error('fixture IPC delivery failure'))
  await expect(pending).rejects.toThrow('disconnected')
})

it('cancels locally even when notifying the disconnected peer throws synchronously', async () => {
  const abort = new AbortController()
  const pending = browser(abort.signal)
  ipc.send.mockImplementationOnce(() => { throw new Error('fixture cancellation send race') })
  abort.abort()
  await expect(pending).rejects.toThrow('cancelled')
})

it('routes trusted controls only to the exact current Agent object', async () => {
  const { control } = controller()
  const unregister = ctx.browserInteraction.register(live, control)
  const key = sent[0]!.key
  channel.emit('message', { type: 'desktop-interaction-control', key, action: 'taken-over' })
  await Promise.resolve()
  expect(control.stop).toHaveBeenCalledWith('taken-over')
  channel.emit('message', { type: 'desktop-interaction-control', key, action: 'resume' })
  await Promise.resolve()
  expect(control.resume).toHaveBeenCalledOnce()
  live = { id: live.id } as Agent
  channel.emit('message', { type: 'desktop-interaction-control', key, action: 'resume' })
  channel.emit('message', { type: 'desktop-interaction-control', key, action: 'erase-profile' })
  await Promise.resolve()
  expect(control.resume).toHaveBeenCalledOnce()
  unregister()
  expect(sent.at(-1)).toMatchObject({ key, state: null })
})

it('unsubscribes provider controls and cancels pending requests on Cordis unload', async () => {
  const fixture = controller()
  const unregister = ctx.browserInteraction.register(live, fixture.control)
  const pending = browser()
  const rejection = expect(pending).rejects.toThrow('disconnected')
  await ctx.fiber.dispose()
  await rejection
  expect(fixture.unsubscribe).toHaveBeenCalledOnce()
  expect(fixture.listeners.size).toBe(0)
  expect(channel.listenerCount('message')).toBe(0)
  expect(channel.listenerCount('disconnect')).toBe(0)
  unregister()
  expect(fixture.unsubscribe).toHaveBeenCalledOnce()
})

it('clears subscriptions and stops admission if initial publication fails', () => {
  const fixture = controller()
  ipc.send.mockImplementationOnce(() => { throw new Error('fixture publication failure') })
  const unregister = ctx.browserInteraction.register(live, fixture.control)
  expect(fixture.listeners.size).toBe(0)
  expect(fixture.unsubscribe).toHaveBeenCalledOnce()
  expect(() => ctx.browserInteraction.register(live, fixture.control)).toThrow('stopped')
  unregister()
})

it('contains synchronously throwing trusted controls instead of escaping the IPC listener', async () => {
  const fixture = controller()
  fixture.control.resume.mockImplementation(() => { throw new Error('fixture resume unavailable') })
  ctx.browserInteraction.register(live, fixture.control)
  expect(() => channel.emit('message', { type: 'desktop-interaction-control', key: sent[0]!.key, action: 'resume' })).not.toThrow()
  await Promise.resolve()
  await Promise.resolve()
})

it.each(['reactivation', 'unregister', 'unload'] as const)('does not execute a queued control after %s', async (reason) => {
  const fixture = controller()
  const unregister = ctx.browserInteraction.register(live, fixture.control)
  channel.emit('message', { type: 'desktop-interaction-control', key: sent[0]!.key, action: 'resume' })
  if (reason === 'reactivation') live = { id: live.id } as Agent
  else if (reason === 'unregister') unregister()
  else await ctx.fiber.dispose()
  await Promise.resolve()
  expect(fixture.control.resume).not.toHaveBeenCalled()
})
