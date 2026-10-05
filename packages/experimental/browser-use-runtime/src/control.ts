/** Trusted browser controls project provider-owned activation state to the user interface. @module */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** Observable browser state owned by one exact Agent activation. */
export interface BrowserInteractionState {
  provider: string
  status: 'initializing' | 'ready' | 'running' | 'stopping' | 'stopped' | 'taken-over' | 'disconnected' | 'blocked'
  mode: 'isolated' | 'attached' | 'ephemeral' | 'persistent'
  operation?: string
  reason?: string
}

/** Provider-owned controls; ordinary model tool arguments cannot invoke them. */
export interface BrowserInteractionController {
  /** @returns a projection of the provider's current state. */
  state(): BrowserInteractionState
  /**
   * Stop admission immediately and settle already admitted work before reporting control transfer.
   * Delivered input is not undone.
   * @param kind - user stop or explicit manual takeover.
   * @returns completion after pending work settles.
   */
  stop(kind: 'stopped' | 'taken-over'): Promise<void>
  /**
   * Restore admission after trusted user action; the next tool must observe current state.
   * @returns completion or a failure requiring a new browser activation.
   */
  resume(): Promise<void>
  /**
   * Subscribe to committed state changes without receiving page content or credentials.
   * @param listener - notified after the provider changes its state.
   * @returns the subscription disposer.
   */
  subscribe(listener: () => void): () => void
}

/** Optional trusted consumer; providers retain state and resource ownership. */
export interface BrowserInteractionRegistry {
  /**
   * Publish controls for one exact live activation, rejecting duplicate ownership.
   * @param agent - live owner whose identity must be checked by every consumer action.
   * @param control - provider controls, never exposed directly to model tool parameters.
   * @returns a disposer that removes only this registration.
   */
  register(agent: Agent, control: BrowserInteractionController): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserInteraction: BrowserInteractionRegistry
  }
}
