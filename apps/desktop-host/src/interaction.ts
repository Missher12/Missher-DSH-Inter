/** Child-process transport for trusted Desktop browser operations and native authorization. */
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-browser-use'
import type { DesktopBrowserResult } from '@deepseek-ai/dsh-browser-use/desktop'
import type {} from '@deepseek-ai/dsh-computer-use'
import type { BrowserInteractionController } from '@deepseek-ai/dsh-experimental-browser-use-runtime/control'
import type {} from '@deepseek-ai/dsh-experimental-browser-use-runtime/control'

/** Install adapters on the private Desktop Host only. @param ctx - application context. */
export function installDesktopInteraction(ctx: Context): void {
  let nextId = 0
  let stopped = false
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const controls = new Map<string, { agent: import('@deepseek-ai/dsh-agent').Agent; control: BrowserInteractionController; unsubscribe: () => void }>()
  const send = (value: object): void => {
    if (stopped || ctx.fiber.state !== FiberState.ACTIVE || !process.connected || process.send === undefined) throw new Error('Desktop interaction is disconnected')
    process.send(value, (error) => { if (error !== null) for (const p of pending.values()) p.reject(new Error('Desktop interaction disconnected')) })
  }
  const request = async (kind: string, value: unknown, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted()
    const requestId = ++nextId
    const cancel = (): void => {
      try { if (!stopped && process.connected) send({ type: 'desktop-interaction-cancel', requestId }) }
      catch (_error) { /* Closing IPC cannot prevent local cancellation. */ }
      pending.get(requestId)?.reject(new Error('Desktop interaction cancelled; already delivered input may have completed'))
    }
    const timer = setTimeout(cancel, 120_000)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        send({ type: 'desktop-interaction', requestId, kind, value })
      })
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); pending.delete(requestId) }
  }
  const listener = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || !('type' in value)) return
    if (value.type === 'desktop-interaction-result' && 'requestId' in value && Number.isSafeInteger(value.requestId)) {
      const owned = pending.get(Number(value.requestId))
      if ('error' in value) owned?.reject(new Error('Desktop interaction failed; observe current state before retrying'))
      else if ('value' in value) owned?.resolve(value.value)
    }
    if (value.type === 'desktop-interaction-control' && 'key' in value && typeof value.key === 'string' && 'action' in value) {
      const record = controls.get(value.key)
      if (record === undefined || ctx.agents.get(record.agent.id) !== record.agent) return
      const action = value.action
      if (action !== 'resume' && action !== 'stopped' && action !== 'taken-over') return
      void Promise.resolve().then(() => {
        if (stopped || ctx.fiber.state !== FiberState.ACTIVE || controls.get(value.key as string) !== record
          || ctx.agents.get(record.agent.id) !== record.agent) return
        return action === 'resume' ? record.control.resume() : record.control.stop(action)
      }).catch((error: unknown) => { ctx.logger.warn('Desktop control failed: %s', error) })
    }
  }
  const disconnect = (): void => {
    stopped = true
    for (const p of pending.values()) p.reject(new Error('Desktop interaction disconnected'))
    pending.clear()
    for (const record of controls.values()) record.unsubscribe()
    controls.clear()
  }
  ctx.effect(() => {
    process.on('message', listener)
    process.on('disconnect', disconnect)
    return () => { process.off('message', listener); process.off('disconnect', disconnect); disconnect() }
  }, 'desktop.interaction.transport')
  ctx.provide('desktopBrowser', {
    async request(input, signal) {
      const value = await request('browser', input, signal)
      if (typeof value !== 'object' || value === null || !('status' in value) || !('message' in value) || typeof value.message !== 'string' || typeof value.status !== 'string' || !['observed', 'delivered', 'closed', 'cancelled', 'uncertain', 'denied', 'stale-target', 'stale-snapshot', 'unavailable'].includes(value.status)) throw new Error('Invalid Desktop browser response')
      return value as DesktopBrowserResult
    },
  })
  ctx.provide('computerAuthorization', {
    async request(input, signal) {
      const value = await request('authorization', input, signal)
      return value === 'allow' || value === 'deny' ? value : 'cancel'
    },
    async revoke(activationId) { await request('authorization-revoke', { activationId }, new AbortController().signal) },
  })
  ctx.provide('browserInteraction', {
    register(agent, control) {
      const key = `${agent.id}:${control.state().provider}`
      if (controls.has(key)) throw new Error('Duplicate interaction control owner')
      const publish = (): void => {
        try { if (!stopped && process.connected) send({ type: 'desktop-interaction-state', key, sessionId: agent.id, state: control.state() }) }
        catch (_error) { disconnect() }
      }
      if (stopped) throw new Error('Desktop interaction stopped')
      const unsubscribe = control.subscribe(publish)
      controls.set(key, { agent, control, unsubscribe })
      publish()
      return () => { if (controls.get(key)?.control === control) { unsubscribe(); controls.delete(key); try { if (!stopped && process.connected) send({ type: 'desktop-interaction-state', key, sessionId: agent.id, state: null }) } catch (_error) { disconnect() } } }
    },
  })
}
