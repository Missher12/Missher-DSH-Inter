/** Structured refusal projection for the pinned Cua Driver SDK. @module */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolResult } from '@trycua/cua-driver'

/** Provider error retaining the SDK result for direct same-process callers. */
export class CuaDriverRefusalError extends HarnessError {
  /**
   * @param code - SDK refusal code or the fallback action-refused identity.
   * @param rawResult - original SDK envelope, never copied to durable metadata.
   */
  constructor(code: string, readonly rawResult: ToolResult) {
    super(refusalMessage(code), /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : 'driver_refusal')
    this.name = 'CuaDriverRefusalError'
  }
}

/**
 * Preserve successful MCP results and reject explicit SDK refusal metadata.
 * Cua 0.28 ActionEffect.Refused is 4. Page text is never searched for errors.
 * @param result - typed result from the pinned native SDK.
 * @param toolName - upstream tool identity used only for a pinned exact-message fallback.
 * @returns the untouched raw MCP result for the existing image/result adapter.
 */
export function nativeMcpResult(result: ToolResult, toolName?: string): unknown {
  if (result.errorCode !== undefined || Number(result.action?.effect) === 4) {
    throw new CuaDriverRefusalError(result.errorCode ?? 'action_refused', result)
  }
  const raw: unknown = JSON.parse(result.rawJson)
  if (result.isError && (typeof raw !== 'object' || raw === null || !('isError' in raw) || raw.isError !== true)) {
    throw new CuaDriverRefusalError('driver_error', result)
  }
  // Cua 0.28.0 can omit both typed refusal fields for this exact browser denial.
  const consent = 'refused (browser_consent_required): this standalone browser profile requires explicit existing-profile approval before Cua can inspect its DevTools endpoint'
  if (toolName === 'get_browser_state' && result.text === consent) {
    throw new CuaDriverRefusalError('browser_consent_required', result)
  }
  return raw
}

function refusalMessage(code: string): string {
  switch (code) {
    case 'browser_consent_required':
      return 'Browser access needs approval in the desktop authorization dialog. A model or page cannot approve it.'
    case 'browser_consent_denied':
    case 'authorization_denied':
      return 'Browser access was denied. Do not retry or switch to foreground control without user authorization.'
    case 'facility_unavailable':
      return 'This desktop facility is unavailable. Use an available observation method; do not assume input was delivered.'
    case 'background_unavailable':
      return 'Background input is unavailable for this target. This refusal does not authorize foreground input.'
    default:
      return `Cua Driver refused the operation (${/^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : 'driver_refusal'}). Observe the current target before deciding the next step.`
  }
}
