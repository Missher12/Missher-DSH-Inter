/** Type-only, guest-scoped Desktop browser service. No global debugging endpoint is exposed. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Host-issued identity of an exact live Agent activation. */
export type BrowserActivationId = Branded<'BrowserActivationId'>
/** Main-issued guest identity, never an Electron webContents id. */
export type BrowserTargetId = Branded<'BrowserTargetId'>
/** Main-issued observation generation. */
export type BrowserSnapshotId = Branded<'BrowserSnapshotId'>
/** Caller identity supplied by the Provider, never by model arguments. */
export interface BrowserOwner { readonly sessionId: string; readonly activationId: BrowserActivationId }
/** Supported guest operations; files are selected by the user through native dialogs. */
export type DesktopBrowserOperation =
  | { readonly action: 'open'; readonly url: string }
  | { readonly action: 'list' }
  | { readonly action: 'release' }
  | { readonly action: 'observe'; readonly target: BrowserTargetId }
  | { readonly action: 'screenshot'; readonly target: BrowserTargetId }
  | { readonly action: 'close'; readonly target: BrowserTargetId }
  | { readonly action: 'navigate'; readonly target: BrowserTargetId; readonly url: string }
  | { readonly action: 'click'; readonly target: BrowserTargetId; readonly snapshot: BrowserSnapshotId; readonly element: string }
  | { readonly action: 'upload'; readonly target: BrowserTargetId; readonly snapshot: BrowserSnapshotId; readonly element: string }
  | { readonly action: 'fill'; readonly target: BrowserTargetId; readonly snapshot: BrowserSnapshotId; readonly element: string; readonly text: string }
  | { readonly action: 'press'; readonly target: BrowserTargetId; readonly snapshot: BrowserSnapshotId; readonly key: string }
  | { readonly action: 'scroll'; readonly target: BrowserTargetId; readonly snapshot: BrowserSnapshotId; readonly delta: number }
  | { readonly action: 'wait'; readonly target: BrowserTargetId; readonly text: string; readonly timeoutMs: number }
/** Browser transport envelope; ownership is separate from operation arguments. */
export interface DesktopBrowserRequest { readonly owner: BrowserOwner; readonly operation: DesktopBrowserOperation }
/** Bounded initialization diagnosis, without page content or a stack trace. */
export interface DesktopBrowserFailure { readonly code: string; readonly message: string }
/** Process-local state projected to the trusted application renderer. */
export interface DesktopBrowserState {
  readonly target: BrowserTargetId
  readonly sessionId: string
  readonly status: 'initializing' | 'ready' | 'running' | 'taken-over' | 'stopped' | 'disconnected'
  readonly storage: 'temporary' | 'persistent'
  readonly operation?: string
  readonly failure?: DesktopBrowserFailure
}
/** Result data passes through the ordinary tool log and attachment admission. */
export interface DesktopBrowserResult {
  readonly status: 'observed' | 'delivered' | 'closed' | 'cancelled' | 'uncertain' | 'denied' | 'stale-target' | 'stale-snapshot' | 'unavailable'
  readonly message: string
  readonly target?: BrowserTargetId
  readonly snapshot?: BrowserSnapshotId
  readonly data?: unknown
  readonly image?: { readonly data: string; readonly mimeType: 'image/png' }
}
/** Trusted Host-to-Desktop adapter. */
export interface DesktopBrowserService {
  /**
   * Execute one finite operation against the requesting activation's owned guest.
   * @param request - exact owner and finite operation.
   * @param signal - cancellation.
   * @returns observed result; dispatched input is never rolled back.
   */
  request(request: DesktopBrowserRequest, signal: AbortSignal): Promise<DesktopBrowserResult>
}
