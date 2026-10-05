/** Native authority and desktop work segments owned by exact Agent activations. @module */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ComputerActivationId, ComputerAuthorizationRequestId } from '@deepseek-ai/dsh-computer-use/authorization'
import type { BrowserInteractionController, BrowserInteractionState } from '@deepseek-ai/dsh-experimental-browser-use-runtime/control'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { CuaDriverLike, CuaDriverSessionLike, DriverAuthorizationDecision, DriverAuthorizationRequest, ToolResult } from '@trycua/cua-driver'
import type * as NativeSdk from '@trycua/cua-driver'

interface Entry {
  agent: Agent
  id: ComputerActivationId
  controller: AbortController
  surface?: CuaDriverSessionLike
  tail: Promise<void>
  closing?: Promise<void>
  disposeOwner: () => Promise<void>
  removeControl?: () => void
  deniedResources: Set<string>
  observedTargets: Set<string>
  state: BrowserInteractionState
  listeners: Set<() => void>
}

/** Validated native authority lifetime; these limits never enlarge permission mode. */
export interface NativeSessionOptions {
  sessionTtlSeconds: number
  idleTtlSeconds: number
}

/**
 * Serializes complete desktop work segments within this provider's Host.
 * A segment lasts until turn stopping, explicit user stop, or activation disposal.
 */
export class NativeSessions {
  private readonly entries = new Map<Agent, Entry>()
  private owner: Entry | undefined
  private closed = false

  /**
   * @param ctx - provider context with the exact live Agent registry.
   * @param sdk - pinned native SDK, loaded by the provider.
   * @param driver - shared runtime whose catalog the provider registered.
   * @param options - configured session and idle authority lifetimes.
   */
  constructor(
    private readonly ctx: Context,
    private readonly sdk: typeof NativeSdk,
    private readonly driver: CuaDriverLike,
    private readonly options: NativeSessionOptions,
  ) {
    ctx.on('agent/turn-stopping', async ({ agent }) => {
      const entry = this.entries.get(agent)
      if (entry !== undefined) await this.closeSegment(entry)
    })
  }

  /**
   * Execute within the initiating activation's native authority and desktop segment.
   * @param agent - exact live activation; a durable id cannot select another owner.
   * @param name - catalog-validated SDK tool name.
   * @param args - model arguments forwarded to the native validator.
   * @param signal - caller cancellation; cancellation stops the whole segment.
   * @returns the original SDK envelope after its operation settles.
   */
  run(agent: Agent, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted()
    const entry = this.entry(agent)
    if (entry.state.status === 'stopped' || entry.state.status === 'taken-over' || entry.closing !== undefined) {
      throw new HarnessError('Desktop control is stopped. The user must resume it, then observe current state.', 'CU_STOPPED')
    }
    if (this.owner !== undefined && this.owner !== entry) {
      throw new HarnessError('Another session owns the desktop observation and action work segment. Wait until it finishes.', 'CU_BUSY')
    }
    this.owner = entry
    if (entry.surface === undefined) {
      entry.controller = new AbortController()
      entry.id = randomUUID() as ComputerActivationId
      try {
        entry.surface = this.sdk.createTrustedSession(this.driver, {
          publicSession: entry.id,
          mode: this.sdk.SessionPermissionMode.Standard,
          ttlSeconds: BigInt(this.options.sessionTtlSeconds),
          idleTtlSeconds: BigInt(this.options.idleTtlSeconds),
        })
      } catch (error) {
        entry.controller.abort()
        this.owner = undefined
        this.publish(entry, { status: 'blocked', reason: 'Desktop control could not initialize.' })
        throw error
      }
    }
    const surface = entry.surface
    const combined = AbortSignal.any([signal, entry.controller.signal])
    const abort = () => { void this.stop(entry, 'stopped').catch(() => { this.publish(entry, { status: 'blocked', reason: 'Desktop cleanup failed; restart the host.' }) }) }
    signal.addEventListener('abort', abort, { once: true })
    const operation = entry.tail.then(async () => {
      combined.throwIfAborted()
      if (this.ctx.agents.get(agent.id) !== agent) throw new HarnessError('This desktop activation has ended.', 'CU_STALE_ACTIVATION')
      const target = targetKey(args)
      if (WINDOW_ACTIONS.has(name)) {
        if (target === undefined || !entry.observedTargets.has(target)) {
          throw new HarnessError('Get a fresh window snapshot for this exact target before sending input.', 'CU_FRESH_OBSERVATION_REQUIRED')
        }
        // A dispatched action consumes its observation even if native completion is uncertain.
        entry.observedTargets.delete(target)
      }
      this.publish(entry, { status: 'running', operation: name })
      const result = await surface.callTool(name, JSON.stringify(args), { signal: combined })
      combined.throwIfAborted()
      if (name === 'get_window_state' && target !== undefined && !result.isError && result.errorCode === undefined && Number(result.action?.effect) !== 4) entry.observedTargets.add(target)
      return result
    }).finally(() => {
      signal.removeEventListener('abort', abort)
      if (!entry.controller.signal.aborted) this.publish(entry, { status: 'ready' })
    })
    entry.tail = operation.then(() => {}, () => {})
    return operation
  }

  /**
   * Delegate only an SDK-attested request to the trusted desktop adapter.
   * @param request - exact SDK request, whose digest and expiry bind its decision.
   * @param signal - SDK cancellation for the pending request.
   * @returns a denial or cancellation unless the live trusted adapter approved this request.
   */
  async authorize(request: DriverAuthorizationRequest, signal?: AbortSignal): Promise<DriverAuthorizationDecision> {
    const action = this.sdk.DriverAuthorizationAction
    const decision = (value: DriverAuthorizationDecision['action']): DriverAuthorizationDecision => ({
      action: value, requestDigest: request.requestDigest,
    })
    const entry = this.owner
    const host = this.ctx.get('computerAuthorization')
    if (entry === undefined || request.publicSession !== entry.id || entry.controller.signal.aborted || host === undefined) {
      return decision(action.Deny)
    }
    const key = createHash('sha256').update(request.resourceJson).digest('hex')
    if (entry.deniedResources.has(key)) return decision(action.Deny)
    const remaining = Number(request.expiresUnixMs - BigInt(Date.now()))
    if (remaining <= 0 || !Number.isSafeInteger(remaining)) return decision(action.Cancel)
    const expiry = AbortSignal.timeout(Math.min(remaining, 2_147_483_647))
    const combined = AbortSignal.any([entry.controller.signal, expiry, ...signal === undefined ? [] : [signal]])
    if (combined.aborted) return decision(action.Cancel)
    const id = entry.id
    this.publish(entry, { status: 'blocked', reason: 'Waiting for browser access approval in the desktop dialog.' })
    try {
      const result = await host.request({
        requestId: randomUUID() as ComputerAuthorizationRequestId,
        sessionId: entry.agent.id,
        activationId: id,
        requestDigest: request.requestDigest,
        expiresAt: Number(request.expiresUnixMs),
        summary: request.humanSummary,
        resourceJson: request.resourceJson,
      }, combined)
      if (!this.active(entry, id, combined) || Date.now() >= Number(request.expiresUnixMs)) return decision(action.Cancel)
      if (result !== 'allow') entry.deniedResources.add(key)
      return decision(result === 'allow' ? action.Allow : result === 'deny' ? action.Deny : action.Cancel)
    } catch (error) {
      // The trusted adapter may reject on disconnect; its raw error stays out of tool output.
      void error
      entry.deniedResources.add(key)
      return decision(action.Cancel)
    } finally {
      if (this.active(entry, id, entry.controller.signal)) this.publish(entry, { status: 'running' })
    }
  }

  /**
   * Close admission, settle calls, and revoke every owned SDK session.
   * @returns after all activation resources and controls are removed.
   */
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.all([...this.entries.values()].map(entry => entry.disposeOwner()))
  }

  private active(entry: Entry, id: ComputerActivationId, signal: AbortSignal): boolean {
    return !signal.aborted && !this.closed && this.owner === entry && entry.id === id
  }

  private entry(agent: Agent): Entry {
    if (this.closed || this.ctx.agents.get(agent.id) !== agent) throw new HarnessError('This desktop activation is no longer live.', 'CU_STALE_ACTIVATION')
    const existing = this.entries.get(agent)
    if (existing !== undefined) return existing
    const entry: Entry = {
      agent,
      id: randomUUID() as ComputerActivationId,
      controller: new AbortController(),
      tail: Promise.resolve(),
      disposeOwner: () => Promise.resolve(),
      deniedResources: new Set(),
      observedTargets: new Set(),
      state: { provider: 'cua-driver-native', status: 'ready', mode: 'ephemeral' },
      listeners: new Set(),
    }
    this.entries.set(agent, entry)
    entry.disposeOwner = agent.ctx.effect(() => async () => {
      entry.listeners.clear()
      entry.removeControl?.()
      await this.closeSegment(entry)
      this.entries.delete(agent)
    }, 'computer-use-cua-driver-native.activation')
    const control: BrowserInteractionController = {
      state: () => ({ ...entry.state }),
      stop: kind => this.stop(entry, kind),
      resume: async () => {
        if (this.closed || this.ctx.agents.get(agent.id) !== agent) throw new HarnessError('This desktop activation has ended.', 'CU_STALE_ACTIVATION')
        await this.closeSegment(entry)
        entry.deniedResources.clear()
        this.publish(entry, { status: 'ready' })
      },
      subscribe: (listener) => {
        entry.listeners.add(listener)
        return () => { entry.listeners.delete(listener) }
      },
    }
    const interaction = this.ctx.get('browserInteraction')
    if (interaction !== undefined) entry.removeControl = interaction.register(agent, control)
    return entry
  }

  private async stop(entry: Entry, kind: 'stopped' | 'taken-over'): Promise<void> {
    this.publish(entry, { status: 'stopping' })
    await this.closeSegment(entry)
    this.publish(entry, { status: kind, reason: 'Input already delivered is not undone. Resume and observe before further actions.' })
  }

  private closeSegment(entry: Entry): Promise<void> {
    if (entry.closing !== undefined) return entry.closing
    entry.controller.abort()
    entry.closing = (async () => {
      await entry.tail
      entry.surface?.close()
      delete entry.surface
      entry.observedTargets.clear()
      await this.ctx.get('computerAuthorization')?.revoke(entry.id)
      if (this.owner === entry) this.owner = undefined
    })().finally(() => { delete entry.closing })
    return entry.closing
  }

  private publish(entry: Entry, update: Pick<BrowserInteractionState, 'status'> & Pick<Partial<BrowserInteractionState>, 'operation' | 'reason'>): void {
    entry.state = { provider: 'cua-driver-native', mode: 'ephemeral', ...update }
    for (const listener of entry.listeners) {
      try { listener() } catch (error) {
        // Listener failures cannot interrupt other subscribers or retain desktop control.
        void error
        this.ctx.logger.warn('Native desktop state listener failed')
      }
    }
  }
}

const WINDOW_ACTIONS = new Set(['click', 'drag', 'scroll', 'type_text', 'press_key', 'hotkey', 'invoke_menu', 'set_window_frame'])

function targetKey(args: Record<string, unknown>): string | undefined {
  if (args.target !== undefined) {
    if (args.pid !== undefined || args.window_id !== undefined) {
      throw new HarnessError('Select target or top-level pid/window_id, never both.', 'CU_AMBIGUOUS_TARGET')
    }
    const target = args.target
    if (typeof target !== 'object' || target === null || !('kind' in target) || target.kind !== 'window' || !('pid' in target) || !('window_id' in target)) return undefined
    return JSON.stringify([target.pid, target.window_id])
  }
  if (args.pid !== undefined && args.window_id !== undefined) return JSON.stringify([args.pid, args.window_id])
  return undefined
}
