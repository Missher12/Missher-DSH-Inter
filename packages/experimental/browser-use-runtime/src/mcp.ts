/** Session-owned MCP browser processes and provider catalog activation. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { SessionResources } from './index.ts'
import type { BrowserInteractionController, BrowserInteractionState } from './control.ts'
import type {} from '@deepseek-ai/dsh-browser-use'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Browser launch settings shared by the MCP integrations. */
export interface BrowserMcpLaunchConfig {
  /** Launch a new isolated Chromium browser for each live Session. */
  mode: 'launch'
  /** Whether Chromium runs without a visible window; defaults to true. */
  headless: boolean
  /** Chromium executable; omission uses the upstream server's installation discovery. */
  executablePath?: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number

}

/** Attachment to an externally owned Chromium browser. */
export interface BrowserMcpAttachConfig {
  /** Exclusively attach one live Session to the configured browser. */
  mode: 'attach'
  /** HTTP(S) debugging URL or WS(S) browser debugging endpoint. */
  endpoint: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Fixed launch or attachment choice for one MCP browser provider. */
export type BrowserMcpConfig = BrowserMcpLaunchConfig | BrowserMcpAttachConfig

/** Validate the browser mode before the provider reserves browser use. */
export const BrowserMcpConfig: Schema<BrowserMcpAttachConfig | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean }), BrowserMcpConfig> = Schema.union([
  Schema.object({
    mode: Schema.const('launch').required(),
    headless: Schema.boolean().default(true),
    executablePath: Schema.string().pattern(/\S/u),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
  Schema.object({
    mode: Schema.const('attach').required(),
    endpoint: Schema.string().pattern(/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u).required(),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
])

/**
 * Reject an invalid debugging endpoint before acquiring provider or browser resources.
 * @param config - schema-validated browser selection.
 */
export function validateBrowserMcpConfig(config: BrowserMcpConfig): void {
  if (config.mode !== 'attach') return
  let endpoint: URL
  try {
    endpoint = new URL(config.endpoint)
  } catch (error) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL', { cause: error })
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || /\s/u.test(config.endpoint)) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL without whitespace')
  }
}

/** Provider-owned connection options for one live Session. */
export interface SessionMcpOptions {
  /** Provider identity and MCP tool namespace. */
  name: string
  /** Whether another live Session must wait for the attached browser to be released. */
  exclusive: boolean
  /** Executable used to start the installed MCP server. */
  command: string
  /** Arguments passed directly without a shell. */
  args: string[]
  /** Explicit overrides merged into the MCP client's scrubbed child environment. */
  env?: Record<string, string>
  /** Per-call timeout override; omission retains the MCP client default. */
  toolCallTimeoutMs?: number
  /** Use a provider-owned temporary workspace instead of exposing the Session's working directory. */
  privateWorkspace?: boolean
  /** Upstream tool names excluded by fixed provider policy; direct execution also fails. */
  deniedTools?: readonly string[]
  /** Upstream observations accepted as the first call after explicit user resume. */
  observationTools?: readonly string[]
  /**
   * Validate untrusted tool arguments before reaching the upstream process.
   * @param name - upstream tool name without the provider prefix.
   * @param args - model-provided tool arguments.
   */
  validateToolArguments?: (name: string, args: unknown) => void
}

interface ClientState {
  status: 'initializing' | 'ready' | 'blocked'
  mask?: Scope
  control: BrowserInteractionController
  view: BrowserInteractionState
  listeners: Set<() => void>
  pending: Set<Promise<unknown>>
  suspended: boolean
  needsObservation: boolean
  transfer?: Promise<void>
}

/**
 * Await one MCP client during each future Agent's creation.
 * A busy attachment leaves that activation without browser tools; its other turns continue.
 * Calls are serialized per Session; unload closes every server before releasing registration.
 * @param ctx - provider context supplying browser use, Agents, tools, and prompt assembly.
 * @param options - provider identity, attachment exclusivity, and executable configuration.
 */
export function mountSessionMcp(ctx: Context, options: SessionMcpOptions): void {
  let resources!: SessionResources<Scope>
  const clients = new Map<Agent, ClientState>()
  const toolPrefix = `mcp__${options.name}__`
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  let stopping = false
  let refreshingMasks = false

  const publish = (state: ClientState, update: BrowserInteractionState): void => {
    state.view = update
    for (const listener of state.listeners) {
      try { listener() } catch (error) {
        ctx.logger.warn(`${options.name}: browser state subscriber failed: ${String(error)}`)
      }
    }
  }

  const clientState = (agent: Agent): ClientState => {
    const blocked = !resources.available(agent)
    const state: ClientState = {
      status: blocked ? 'blocked' : 'initializing',
      view: { provider: options.name, status: blocked ? 'blocked' : 'initializing', mode: options.exclusive ? 'attached' : 'isolated' },
      listeners: new Set(), pending: new Set(), suspended: blocked, needsObservation: false,
      control: {
        state: () => ({ ...state.view }),
        stop(kind) {
          if (clients.get(agent) !== state || ctx.agents.get(agent.id) !== agent) return Promise.reject(new Error('Browser activation is no longer available.'))
          if (state.status === 'blocked') return Promise.reject(new Error('This browser is owned by another session.'))
          if (state.transfer !== undefined) return state.transfer
          state.suspended = true
          publish(state, { ...state.view, status: 'stopping' })
          state.transfer = Promise.allSettled([...state.pending]).then(() => {
            const { operation: _operation, ...view } = state.view
            publish(state, { ...view, status: kind })
          }).finally(() => { delete state.transfer })
          return state.transfer
        },
        resume() {
          return Promise.resolve().then(() => {
            if (clients.get(agent) !== state || ctx.agents.get(agent.id) !== agent || stopping) throw new Error('Browser activation is no longer available.')
            if (state.status === 'blocked') throw new Error('This browser is owned by another session.')
            if (state.transfer !== undefined) throw new Error('Wait for the current browser operation to settle before resuming.')
            if (options.observationTools === undefined) throw new Error('This browser provider requires a new session activation to resume.')
            state.needsObservation = true
            state.suspended = false
            publish(state, { provider: options.name, mode: state.view.mode, status: 'ready' })
          })
        },
        subscribe(listener) {
          state.listeners.add(listener)
          return () => { state.listeners.delete(listener) }
        },
      },
    }
    return state
  }

  const refreshBlockedMasks = (): void => {
    if (stopping || refreshingMasks) return
    refreshingMasks = true
    try {
      for (const [agent, state] of clients) {
        if (state.status !== 'blocked') continue
        const inherited = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith(toolPrefix))
        if (inherited.length === 0) continue
        state.mask ??= createScope(ctx, agent)
        state.mask.ctx.tools.restrict({ deny: inherited.map(tool => tool.name) })
      }
    } finally {
      refreshingMasks = false
    }
  }

  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(options.name))
    resources = new SessionResources(ctx, {
      label: options.name,
      exclusive: options.exclusive,
      async open(agent, signal) {
        const scope = createScope(ctx, agent)
        let workspace: string | undefined
        let cancellation: Promise<void> | undefined
        const cancel = (): void => { cancellation = scope.dispose() }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          if (options.privateWorkspace === true) workspace = await mkdtemp(join(tmpdir(), 'dsh-browser-'))
          const cwd = workspace ?? agent.session.header.cwd
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix)) return next()
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next()
              throw new Error(`${options.name}: browser tool belongs to another Session`)
            }
            return next()
          })
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: options.args,
            ...options.env === undefined ? {} : { env: options.env },
            ...cwd === undefined ? {} : { cwd },
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
            ...options.deniedTools === undefined ? {} : { excludedTools: [...options.deniedTools] },
          }))
          signal.throwIfAborted()
          return {
            value: scope,
            async close() {
              clients.delete(agent)
              await scope.dispose()
              if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
            },
          }
        } catch (error) {
          await (cancellation ?? scope.dispose())
          if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    })
    yield async () => {
      stopping = true
      await resources.dispose()
      clients.clear()
    }
  }, `${options.name}.sessions`)
  ctx.on('agent/created', async ({ agent, signal }) => {
    const state = clientState(agent)
    clients.set(agent, state)
    agent.ctx.effect(() => async () => {
      clients.delete(agent)
      state.listeners.clear()
      await state.mask?.dispose()
    }, `${options.name}.activation`)
    const controls = ctx.get('browserInteraction')
    if (controls !== undefined) {
      const unregister = ctx.effect(() => controls.register(agent, state.control), `${options.name}.controls`)
      agent.ctx.effect(() => unregister, `${options.name}.activation-controls`)
    }
    if (state.status === 'blocked') {
      refreshBlockedMasks()
      return
    }
    await resources.get(agent, signal)
    state.status = 'ready'
    publish(state, { ...state.view, status: 'ready' })
  }, { prepend: true })
  ctx.on('tools/change', refreshBlockedMasks)
  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { server?: unknown }).server === options.name
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    const state = agent === undefined ? undefined : clients.get(agent)
    if (agent === undefined || state?.status !== 'ready') {
      throw new Error(`${options.name}: browser tool belongs to another Session`)
    }
    const rawName = exec.name.slice(toolPrefix.length)
    if (options.deniedTools?.includes(rawName)) throw new Error('This browser operation is not available without an authorized file workflow.')
    options.validateToolArguments?.(rawName, exec.arguments)
    if (state.suspended) throw new Error('Browser control is stopped or held by the user. Resume it in the browser controls before continuing.')
    const task = resources.run(agent, exec.signal, async (_scope, combined) => {
      if (state.suspended) throw new Error('Browser control stopped before this queued operation started.')
      if (state.needsObservation && !options.observationTools?.includes(rawName)) throw new Error('Observe the current browser with browser_snapshot before performing another action.')
      publish(state, { ...state.view, status: 'running', operation: rawName })
      const original = exec.signal
      exec.signal = combined
      try {
        const result = await next()
        if (!result.isError && options.observationTools?.includes(rawName)) state.needsObservation = false
        if (result.isError) state.needsObservation = true
        return result
      } finally {
        exec.signal = original
        if (combined.aborted) {
          state.suspended = true
          state.needsObservation = true
          publish(state, { provider: options.name, mode: state.view.mode, status: 'stopped', reason: 'The operation was canceled. Input already delivered may have taken effect; observe again after resuming.' })
        } else if (state.view.status === 'running') {
          publish(state, { provider: options.name, mode: state.view.mode, status: 'ready' })
        }
      }
    })
    state.pending.add(task)
    try { return await task } finally { state.pending.delete(task) }
  })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (agent === undefined || clients.get(agent)?.status === 'ready') return assembly
    return { ...assembly, sections: assembly.sections.filter(section => section.name !== `mcp:${options.name}`) }
  })
}
