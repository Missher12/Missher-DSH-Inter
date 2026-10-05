/** Real Loader and AgentLoop with keyless model and trusted Desktop response fixtures. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import type { DesktopBrowserRequest } from '@deepseek-ai/dsh-browser-use/desktop'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import Llm, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Provider from '../src/index.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
class LocalModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly visual: boolean) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: this.visual ? ['text', 'image'] : ['text'] })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId('sidebar-screenshot'), name: 'browser_use', arguments: '{"action":"screenshot","target":"fixture-target"}',
      } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local fixture complete.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([true, false])('routes a Sidebar screenshot through real Loader, AgentLoop and attachment admission (image input: %s)', async (visual) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-electron-loader-'))
  roots.push(root)
  const model = new LocalModel(visual)
  const request = vi.fn(async (input: DesktopBrowserRequest) => input.operation.action === 'screenshot'
    ? { status: 'observed' as const, message: 'Synthetic Sidebar image', image: { data: png, mimeType: 'image/png' } }
    : { status: 'observed' as const, message: 'Synthetic accessibility state', data: { text: 'button "Save locally"' } })
  const modules = new Map<string, unknown>([
    ['llm', Llm], ['sessions', Sessions], ['projections', Projections], ['prompt', SystemPrompt],
    ['tools', Tools], ['agents', Agents], ['loop', AgentLoop], ['attachments', Attachments],
    ['browser-use', BrowserUse], ['electron-browser', Provider],
    ['desktop-fixture', { apply(ctx: Context) { ctx.provide('desktopBrowser', { request }) } }],
    ['model-fixture', { inject: ['llm'], apply(ctx: Context) { ctx.effect(() => ctx.llm.registerAdapter(['keyless-fixture'], model)) } }],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({
    id: name, name, config: name === 'loop' ? { agents: [] } : name === 'attachments' ? { dshHome: root } : {},
  }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
    loadCache: new Map(),
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const agent = await ctx.agentLoop.create(SessionId('sidebar-loader'), { provider: 'keyless-fixture', model: visual ? 'visual' : 'text' })
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') idle.resolve()
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Observe the synthetic Sidebar page.' }], source: { kind: 'user' } }))
  await idle.promise
  stop()
  expect(model.requests).toHaveLength(2)
  expect(model.requests[0]?.tools?.map(tool => tool.name)).toContain('browser_use')
  expect(JSON.stringify(model.requests[0]?.messages)).toContain('visible Sidebar browser owned by this session')
  const event = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
  expect(event?.data.message.source.callId).toBe('sidebar-screenshot')
  const tool = agent.session.deriveMessages().find(message => message.role === 'tool')
  if (tool?.role !== 'tool') throw new Error('Browser result was not recorded')
  const image = tool.content.find(block => block.type === 'image')
  if (visual) {
    if (image?.type !== 'image') throw new Error('Browser screenshot was not durably admitted')
    expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
    expect(Buffer.from((await ctx.attachments.readImage(image.attachment)).data).toString('base64')).toBe(png)
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(JSON.stringify(image.attachment))
  } else {
    expect(image).toBeUndefined()
    expect(JSON.stringify(tool.content)).toContain('does not declare image input')
    expect(model.requests[1]?.messages.flatMap(message => message.content).some(block => block.type === 'image')).toBe(false)
  }
  expect(JSON.stringify(model.requests)).not.toContain(png)
  const text = await ctx.tools.execute({
    agent, name: 'browser_use', callId: ToolCallId('sidebar-observe'),
    arguments: { action: 'observe', target: 'fixture-target' }, signal: new AbortController().signal,
  })
  expect(text.isError).toBe(false)
  expect(JSON.stringify(text.content)).toContain('Save locally')
  expect(request.mock.calls[0]?.[0].owner).toMatchObject({ sessionId: agent.id })
  expect(request.mock.calls[0]?.[0].owner.activationId).toMatch(/^[a-f\d-]{36}$/u)
  const provider = [...ctx.loader.entries()].find(entry => entry.options.id === 'electron-browser')!.fiber!
  await provider.dispose()
  expect(ctx.browserUse.providerName).toBeUndefined()
  expect(ctx.tools.schemas(agent).find(tool => tool.name === 'browser_use')).toBeUndefined()
  expect(request.mock.calls.some(([input]) => input.operation.action === 'release')).toBe(true)
})
