/** Actual ToolRuntime derives browser authority from each live Agent, never model arguments. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DesktopBrowserRequest } from '@deepseek-ai/dsh-browser-use/desktop'
import * as Provider from '../src/index.ts'
let ctx: Context, agent: Agent
beforeEach(async () => { ctx = new Context(); await ctx.plugin(BrowserUse); await mountAgentLoopTestDependencies(ctx); const harness = await mountAgentLoopTestHarness(ctx); agent = await harness.create(SessionId('electron-owner')) })
afterEach(async () => { await ctx.fiber.dispose() })
const execute = (arguments_: Record<string, unknown>) => ctx.tools.execute({ agent, name: 'browser_use', callId: ToolCallId('browser-test'), arguments: arguments_, signal: new AbortController().signal })
describe('Electron browser provider', () => {
  it('fails clearly when the Desktop bridge is absent without selecting another backend', async () => {
    await ctx.plugin(Provider)
    const outcome = await execute({ action: 'open', url: 'https://example.test' })
    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('matching Computer Browser Use Desktop candidate')
  })
  it('derives the owner and retains canonical tool results before unloading', async () => {
    const request = vi.fn(async (_value: DesktopBrowserRequest) => ({ status: 'observed' as const, message: 'Observed controlled page', data: { text: 'Local fixture' } }))
    ctx.provide('desktopBrowser', { request })
    const fiber = ctx.plugin(Provider); await fiber
    const outcome = await execute({ action: 'list' })
    expect(outcome.isError).toBe(false)
    expect(request.mock.calls[0]?.[0].owner.sessionId).toBe(agent.id)
    expect(request.mock.calls[0]?.[0].owner.activationId).toMatch(/^[a-f\d-]{36}$/)
    expect(outcome.content).toEqual([{ type: 'text', text: '{"status":"observed","message":"Observed controlled page","data":{"text":"Local fixture"}}' }])
    await fiber.dispose()
    expect(ctx.browserUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas(agent).find(tool => tool.name === 'browser_use')).toBeUndefined()
    expect(request.mock.calls.some(([v]) => v.operation.action === 'release')).toBe(true)
  })
  it('projects denied and uncertain outcomes as failures', async () => {
    ctx.provide('desktopBrowser', { request: async () => ({ status: 'uncertain', message: 'Input may already have been delivered. Observe first.' }) })
    await ctx.plugin(Provider)
    const outcome = await execute({ action: 'observe', target: 'owned' })
    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('Observe first')
  })
})
