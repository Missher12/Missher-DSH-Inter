/** One-shot native authorization, bound to a live Host request and SDK digest. */
import type { ComputerAuthorizationDecision, ComputerAuthorizationRequest } from '@deepseek-ai/dsh-computer-use/authorization'

/** Trusted prompt closure; page content cannot select a response. */
export type ComputerAuthorizationPrompt = (request: ComputerAuthorizationRequest, signal: AbortSignal) => Promise<boolean>
/** Owns pending decisions and revocations without retaining sensitive resource descriptors. */
export class DesktopComputerAuthorization {
  private readonly pending = new Map<string, { activation: string; controller: AbortController }>()
  private readonly used = new Set<string>()
  private readonly revoked = new Set<string>()
  constructor(private readonly prompt: ComputerAuthorizationPrompt) {}

  /** @param value - Host IPC request. @param signal - request/Host lifetime. @returns a single non-reusable decision. */
  async request(value: unknown, signal: AbortSignal): Promise<ComputerAuthorizationDecision> {
    if (typeof value !== 'object' || value === null) return 'deny'
    const v = value as Record<string, unknown>
    for (const key of ['requestId', 'sessionId', 'activationId', 'requestDigest', 'summary', 'resourceJson']) {
      if (typeof v[key] !== 'string' || v[key].length === 0 || v[key].length > (key === 'resourceJson' ? 65536 : 8192)) return 'deny'
    }
    if (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt) || v.expiresAt <= Date.now()) return 'cancel'
    const request = value as ComputerAuthorizationRequest
    if (signal.aborted || this.used.has(request.requestId) || this.revoked.has(request.activationId)) return 'cancel'
    this.used.add(request.requestId)
    const controller = new AbortController()
    this.pending.set(request.requestId, { activation: request.activationId, controller })
    const combined = AbortSignal.any([signal, controller.signal])
    const timer = setTimeout(() => { controller.abort() }, Math.min(request.expiresAt - Date.now(), 120000))
    try {
      const allowed = await this.prompt(request, combined)
      if (combined.aborted || Date.now() >= request.expiresAt || this.revoked.has(request.activationId)) return 'cancel'
      return allowed ? 'allow' : 'deny'
    } finally { clearTimeout(timer); this.pending.delete(request.requestId) }
  }
  /** @param activation - SDK session authority being retired. */
  revoke(activation: string): void {
    this.revoked.add(activation)
    for (const value of this.pending.values()) if (value.activation === activation) value.controller.abort()
  }
  /** Cancel every pending prompt when its Host disconnects. */
  dispose(): void { for (const value of this.pending.values()) value.controller.abort(); this.pending.clear() }
}
