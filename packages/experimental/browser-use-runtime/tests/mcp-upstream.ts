/** Real upstream MCP browser checks against private loopback pages and disposable Chromium. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import { expect, vi } from 'vitest'
import type { BrowserMcpConfig } from '../src/mcp.ts'

class ImageRoute extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('The controlled browser test never calls a model.')
  }
}

export async function verifyMcpBrowser(
  provider: Pick<Plugin.Object<BrowserMcpConfig>, 'apply'>,
  namespace: string,
  navigate: { name: string; arguments(url: string): Record<string, unknown> },
  mode: 'launch' | 'attach',
): Promise<void> {
  const executable = process.env.DSH_BROWSER_EXECUTABLE!
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-upstream-'))
  const observed = new Set<string>()
  const server = createServer((request, response) => {
    observed.add(request.url!)
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><title>DSH browser fixture</title><h1>Browser integration works</h1>
      <label>Name <input id="name"></label><button id="save">Save locally</button>
      <p id="result" role="status">Not saved</p><button id="dialog">Show dialog</button>
      <div style="height:1800px"></div><p>End of local fixture</p>
      <script>
        document.querySelector('#save').onclick = () => setTimeout(() => {
          document.querySelector('#result').textContent = 'Saved: ' + document.querySelector('#name').value;
        }, 50);
        document.querySelector('#dialog').onclick = () => {
          document.querySelector('#result').textContent = confirm('Local fixture confirmation') ? 'Accepted locally' : 'Declined locally';
        };
      </script>`)
  })
  const ctx = new Context()
  let external: ReturnType<typeof spawn> | undefined
  let exited: Promise<unknown> | undefined
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture has no TCP listener')
    const url = `http://127.0.0.1:${address.port}/${namespace}-${mode}`
    const headless = process.env.DSH_BROWSER_HEADED !== '1'
    let browserConfig: BrowserMcpConfig = { mode: 'launch', headless, executablePath: executable }
    if (mode === 'attach') {
      const profile = join(root, 'external-profile')
      external = spawn(executable, [...headless ? ['--headless=new'] : [], '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
      exited = once(external, 'exit')
      const portFile = join(profile, 'DevToolsActivePort')
      let port: string | undefined
      await vi.waitFor(async () => { port = (await readFile(portFile, 'utf8')).split('\n')[0]; expect(Number(port)).toBeGreaterThan(0) }, { timeout: 20000 })
      browserConfig = { mode: 'attach', endpoint: `http://127.0.0.1:${port}` }
    }
    const modules = new Map<string, unknown>([
      ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
      ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections], ['browser', provider],
      ['attachments', AttachmentLocal],
      ['model', { inject: ['llm'], apply(inner: Context) { inner.effect(() => inner.llm.registerAdapter(['local-test'], new ImageRoute())) } }],
    ])
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ id: name, name, config: name === 'loop' ? { agents: [] } : name === 'browser' ? browserConfig : name === 'attachments' ? { dshHome: root } : {} }))))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected smoke module ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const owner = await ctx.agents.create({ sessionId: SessionId('browser-upstream'), meta: { cwd: root }, agentOptions: { provider: 'local-test', model: 'image-fixture' } })
    await owner.agent.whenIdle()
    await ctx.systemPrompt.assemble({ agent: owner.agent, scope: owner.agent, signal: new AbortController().signal })
    const schemas = ctx.tools.schemas(owner.agent)
    expect(schemas.length).toBeGreaterThan(5)
    expect(schemas.every(tool => tool.name.startsWith(`mcp__${namespace}__`))).toBe(true)
    const result = await ctx.tools.execute({ agent: owner.agent, name: `mcp__${namespace}__${navigate.name}`, arguments: navigate.arguments(url), callId: ToolCallId('navigate'), signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(observed.has(`/${namespace}-${mode}`)).toBe(true)
    expect(result.content.length).toBeGreaterThan(0)
    if (namespace === 'playwright-mcp') {
      const call = async (name: string, args: Record<string, unknown>) => {
        const output = await ctx.tools.execute({ agent: owner.agent, name: `mcp__${namespace}__${name}`, arguments: args, callId: ToolCallId(name), signal: new AbortController().signal })
        expect(output.isError, JSON.stringify(output.content)).toBe(false)
        return output
      }
      const text = (output: Awaited<ReturnType<typeof call>>) => output.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      const snapshot = text(await call('browser_snapshot', {}))
      expect(snapshot).toContain('textbox "Name"')
      const target = /textbox "Name"[^\n]*\[ref=([^\]]+)\]/u.exec(snapshot)?.[1]
      expect(target).toBeDefined()
      await call('browser_type', { target, text: 'Cordis local acceptance' })
      await call('browser_click', { target: '#save' })
      expect(text(await call('browser_wait_for', { text: 'Saved: Cordis local acceptance' }))).toContain('Saved: Cordis local acceptance')
      await call('browser_press_key', { key: 'End' })
      await call('browser_wait_for', { time: 0.3 })
      const scrolled = text(await call('browser_evaluate', { function: '() => window.scrollY' }))
      expect(Number(/Result\n(\d+)/u.exec(scrolled)?.[1])).toBeGreaterThan(0)
      await call('browser_press_key', { key: 'Home' })
      await call('browser_wait_for', { time: 0.3 })
      const screenshot = await call('browser_take_screenshot', { type: 'png' })
      const image = screenshot.content.find(block => block.type === 'image')
      expect(image).toBeDefined()
      if (image?.type === 'image') {
        const stored = await ctx.attachments.readImage(image.attachment)
        expect(Buffer.from(stored.data).subarray(1, 4).toString()).toBe('PNG')
        const evidence = process.env.DSH_BROWSER_ARTIFACT_DIR
        if (evidence !== undefined) {
          await mkdir(evidence, { recursive: true })
          await writeFile(join(evidence, `${namespace}-${mode}.png`), Buffer.from(stored.data))
        }
      }
      await call('browser_click', { target: '#dialog' })
      await call('browser_handle_dialog', { accept: false })
      expect(text(await call('browser_snapshot', {}))).toContain('Declined locally')
      for (const name of ['browser_run_code_unsafe', 'browser_file_upload', 'browser_drop']) {
        expect(schemas.some(tool => tool.name === `mcp__${namespace}__${name}`)).toBe(false)
      }
      const denied = await ctx.tools.execute({ agent: owner.agent, name: `mcp__${namespace}__browser_take_screenshot`, arguments: { filename: join(root, 'unauthorized.png') }, callId: ToolCallId('denied-path'), signal: new AbortController().signal })
      expect(denied.isError).toBe(true)
    }
    await owner.dispose()
    expect(ctx.tools.schemas(owner.agent)).toEqual([])
    if (browserConfig.mode === 'attach') {
      expect(external?.exitCode).toBeNull()
      const response = await fetch(`${browserConfig.endpoint}/json/list`)
      const pages = await response.json() as { url: string }[]
      expect(pages.some(page => page.url === url)).toBe(true)
    }
  } finally {
    await ctx.fiber.dispose()
    if (external !== undefined && external.exitCode === null) external.kill('SIGTERM')
    if (exited !== undefined) await exited
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await rm(root, { recursive: true, force: true })
  }
}
