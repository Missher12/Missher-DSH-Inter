/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { DesktopBrowserFailure, DesktopBrowserState } from '@deepseek-ai/dsh-browser-use/desktop'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Main-created model tab; the renderer may only claim this exact reservation. */
export interface DesktopBrowserModelOpen {
  readonly sessionId: string
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** Presence identifies the optional model-control bridge generation. */
  readonly automationVersion?: 1
  /** @param lease - main-issued reservation. @returns only that reservation. */
  claim?(lease: DesktopBrowserLeaseId): Promise<DesktopBrowserReservation>
  /** @param listener - exact model tab to display. @returns unsubscribe. */
  onModelOpen?(listener: (request: DesktopBrowserModelOpen) => void): () => void
  /** @param lease - owned reservation, including before attachment. @returns main-owned state or absence for manual tabs. */
  state?(lease: DesktopBrowserLeaseId): Promise<DesktopBrowserState | undefined>
  /** @param lease - owned reservation. @param failure - bounded initialization diagnosis. @returns after main records failure. */
  reportFailure?(lease: DesktopBrowserLeaseId, failure: DesktopBrowserFailure): Promise<void>
  /** @param listener - main-owned tab state. @returns unsubscribe. */
  onState?(listener: (state: DesktopBrowserState) => void): () => void
  /** @param lease - attached tab. @param action - explicit trusted user gesture. @returns after control settles. */
  control?(lease: DesktopBrowserLeaseId, action: 'stop' | 'takeover' | 'resume' | 'allow-download' | 'persistent'): Promise<void>
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
