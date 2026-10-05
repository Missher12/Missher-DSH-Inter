/** Trusted decisions and complete desktop segments, with no native desktop access. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import type { ComputerAuthorization, ComputerAuthorizationRequest } from '@deepseek-ai/dsh-computer-use/authorization'
import type { BrowserInteractionController } from '@deepseek-ai/dsh-experimental-browser-use-runtime/control'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DriverAuthorizationRequest } from '@trycua/cua-driver'
import * as Provider from '../src/index.ts'
import { fixture, resetFixture } from './fixtures/cua-driver.ts'

vi.mock('@trycua/cua-driver', async () => import('./fixtures/cua-driver.ts'))

let ctx: Context
let first: Agent
let second: Agent
const controls = new Map<Agent, BrowserInteractionController>()

beforeEach(async () => {
  resetFixture()
  controls.clear()
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ComputerUseRegistry)
  ctx.provide('browserInteraction', { register(agent, control) { controls.set(agent, control); return () => { controls.delete(agent) } } })
  const harness = await mountAgentLoopTestHarness(ctx)
  first = await harness.create(SessionId('native-first'))
  second = await harness.create(SessionId('native-second'))
  await ctx.plugin(Provider)
})

afterEach(async () => { await ctx.fiber.dispose() })

function execute(
  agent: Agent | undefined, name: string,
  args: Record<string, unknown> = { pid: 9, window_id: 7 }, signal = new AbortController().signal,
) {
  return ctx.tools.execute({ ...(agent === undefined ? {} : { agent }), name: `cua_driver_native__${name}`, callId: ToolCallId('authority'), arguments: args, signal })
}

function request(overrides: Partial<DriverAuthorizationRequest> = {}): DriverAuthorizationRequest {
  return {
    schema: 'test', nonce: 'nonce', generation: 1n, daemonInstance: 'fixture', permissionMode: 'standard',
    adapterId: 'browser', riskClass: 'existing-profile', publicSession: fixture.sessions.at(-1)!,
    transportSession: 'transport', resourceJson: '{"browser":"Fixture","profile":"Test"}', humanSummary: 'Fixture test profile',
    expiresUnixMs: BigInt(Date.now() + 60_000), requestDigest: 'digest', ...overrides,
  }
}

it('requires a live owner, fresh exact-target observations, and a read after each action', async () => {
  expect((await execute(undefined, 'click')).isError).toBe(true)
  expect((await execute(first, 'click')).isError).toBe(true)
  expect(fixture.calls).toHaveLength(0)
  await execute(first, 'get_window_state')
  expect((await execute(first, 'click', { pid: 9, window_id: 8 })).isError).toBe(true)
  expect((await execute(first, 'click')).isError).toBe(false)
  expect((await execute(first, 'click')).isError).toBe(true)
  expect(fixture.calls.filter(call => call.name === 'click')).toHaveLength(1)
})

it('normalizes SDK window targets to the same exact identity as top-level snapshot arguments', async () => {
  await execute(first, 'get_window_state', { pid: 9, window_id: 7 })
  expect((await execute(first, 'click', { target: { kind: 'window', pid: 9, window_id: 8 }, element_token: 'fixture-token' })).isError).toBe(true)
  const args = { target: { kind: 'window', pid: 9, window_id: 7 }, element_token: 'fixture-token' }
  expect((await execute(first, 'click', args)).isError).toBe(false)
  expect(fixture.calls.at(-1)?.args).toEqual(args)
  expect((await execute(first, 'click', args)).isError).toBe(true)
})

it.each([7, 8])('rejects dual target expressions with window %s before native dispatch', async (windowId) => {
  await execute(first, 'get_window_state', { pid: 9, window_id: 7 })
  const result = await execute(first, 'click', { pid: 9, window_id: 7, target: { kind: 'window', pid: 9, window_id: windowId } })
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('ambiguous native target unexpectedly admitted')
  expect(result.error.info?.code).toBe('CU_AMBIGUOUS_TARGET')
  expect(fixture.calls.filter(call => call.name === 'click')).toHaveLength(0)
})

it('keeps the desktop reserved between observation and verification and releases at turn stopping', async () => {
  await execute(first, 'get_window_state')
  expect((await execute(second, 'get_window_state')).isError).toBe(true)
  await execute(first, 'click')
  expect((await execute(second, 'get_window_state')).isError).toBe(true)
  await execute(first, 'get_window_state')
  await agentEvents(ctx, first).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
  expect(fixture.closes).toBe(1)
  expect((await execute(second, 'get_window_state')).isError).toBe(false)
})

it('rejects stale activation objects even when their durable Session id matches', async () => {
  await execute(first, 'get_window_state')
  const stale = { ...first, id: first.id } as Agent
  const result = await execute(stale, 'get_window_state')
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('stale activation unexpectedly admitted')
  expect(result.error.info?.code).toBe('CU_STALE_ACTIVATION')
})

it('stops queued actions, preserves delivered-input uncertainty, and requires trusted resume plus observation', async () => {
  await execute(first, 'get_window_state')
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish = Promise.withResolvers<unknown>()
  fixture.call = async () => { started.resolve(); return finish.promise }
  const running = execute(first, 'click')
  await started.promise
  const queued = execute(first, 'get_window_state')
  const takeover = controls.get(first)!.stop('taken-over')
  expect(fixture.calls.at(-1)?.signal?.aborted).toBe(true)
  finish.resolve({ content: [{ type: 'text', text: 'Input delivered before cancellation' }] })
  await takeover
  expect((await running).isError).toBe(true)
  expect((await queued).isError).toBe(true)
  expect((await execute(first, 'get_window_state')).isError).toBe(true)
  delete fixture.call
  await controls.get(first)!.resume()
  expect((await execute(first, 'click')).isError).toBe(true)
  expect((await execute(first, 'get_window_state')).isError).toBe(false)
  expect((await execute(first, 'click')).isError).toBe(false)
})

it('keeps the newest stop while an older resume awaits the same native segment cleanup', async () => {
  await execute(first, 'get_window_state')
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const finish = Promise.withResolvers<unknown>()
  fixture.call = async () => { started.resolve(); return finish.promise }
  const running = execute(first, 'click')
  await started.promise
  const control = controls.get(first)!
  const takeover = control.stop('taken-over')
  const resume = control.resume()
  const stop = control.stop('stopped')
  finish.resolve({ content: [{ type: 'text', text: 'Fixture input interrupted' }] })
  await Promise.all([running, takeover, resume, stop])
  expect(control.state().status).toBe('stopped')
  expect((await execute(first, 'get_window_state')).isError).toBe(true)
})

it('forces permission checks to remain promptless and rejects explicit OS permission requests', async () => {
  expect((await execute(undefined, 'check_permissions', { prompt: true })).isError).toBe(true)
  expect(fixture.calls).toHaveLength(0)
  expect((await execute(undefined, 'check_permissions', {})).isError).toBe(false)
  expect(fixture.calls[0]?.args).toEqual({ prompt: false })
})

it.each(['allow', 'deny', 'cancel'] as const)('binds a trusted %s decision to the exact SDK digest', async (result) => {
  const seen: ComputerAuthorizationRequest[] = []
  ctx.provide('computerAuthorization', {
    request: async (value) => { seen.push(value); return result },
    revoke: async () => {},
  } satisfies ComputerAuthorization)
  await execute(first, 'get_window_state')
  const sdkRequest = request()
  const decision = await fixture.authorizationHost!.authorize(sdkRequest)
  expect(decision).toEqual({ action: { allow: 0, deny: 1, cancel: 2 }[result], requestDigest: 'digest' })
  expect(seen[0]).toMatchObject({ activationId: sdkRequest.publicSession, sessionId: first.id, requestDigest: 'digest', resourceJson: sdkRequest.resourceJson })
  if (result !== 'allow') {
    expect((await fixture.authorizationHost!.authorize(request())).action).toBe(1)
    expect(seen).toHaveLength(1)
  }
})

it('does not approve absent-host, foreign-session, expired, canceled, or late decisions', async () => {
  await execute(first, 'get_window_state')
  expect((await fixture.authorizationHost!.authorize(request())).action).toBe(1)
  const answer = Promise.withResolvers<'allow'>()
  const seen = vi.fn(async () => answer.promise)
  ctx.provide('computerAuthorization', { request: seen, revoke: async () => {} } satisfies ComputerAuthorization)
  expect((await fixture.authorizationHost!.authorize(request({ publicSession: 'another-session' }))).action).toBe(1)
  expect((await fixture.authorizationHost!.authorize(request({ expiresUnixMs: BigInt(Date.now() - 1) }))).action).toBe(2)
  expect(seen).not.toHaveBeenCalled()
  const cancel = new AbortController()
  const pending = fixture.authorizationHost!.authorize(request(), { signal: cancel.signal })
  cancel.abort()
  answer.resolve('allow')
  expect((await pending).action).toBe(2)
})

it('revokes pending dialogs and the SDK authority on takeover, ignoring a late allow', async () => {
  const answer = Promise.withResolvers<'allow'>()
  const revoke = vi.fn(async () => {})
  ctx.provide('computerAuthorization', { request: async () => answer.promise, revoke } satisfies ComputerAuthorization)
  await execute(first, 'get_window_state')
  const pending = fixture.authorizationHost!.authorize(request())
  await controls.get(first)!.stop('taken-over')
  answer.resolve('allow')
  expect((await pending).action).toBe(2)
  expect(revoke).toHaveBeenCalledWith(fixture.sessions[0])
  expect(fixture.closes).toBe(1)
})
