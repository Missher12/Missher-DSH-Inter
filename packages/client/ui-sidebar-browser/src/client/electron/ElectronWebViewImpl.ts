/** Electron navigation and guest lifetime, independent from DOM placement. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopBrowserReservation } from '../../types.ts'
import type { DesktopBrowserState } from '@deepseek-ai/dsh-browser-use/desktop'
import type { ElectronWebviewPresentation, WebviewElement } from './ElectronWebviewPresentation.ts'
import { emptyBrowserFrame, type BrowserControlAction, type BrowserFrame, type BrowserFrameState, type BrowserLoadError } from '../browser/BrowserFrame.ts'
import type { BrowserPageOptions } from '../browser/BrowserPage.ts'
import { browserAddressCheckpoint, currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import { parseBrowserAddress, type BrowserTarget } from '../browser/url.ts'

interface NavigationEvent extends Event { readonly isMainFrame: boolean }
interface LoadFailureEvent extends NavigationEvent {
  readonly errorCode: number
  readonly errorDescription: string
}

function failureMessage(error: unknown): string | undefined {
  const message = typeof error === 'string' ? error
    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : undefined
  return message?.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 500) || undefined
}

/** Owns native history and translates Electron observations into common frame state. */
export class ElectronWebViewImpl implements BrowserFrame {
  private readonly store: SnapshotStore<BrowserFrameState>
  private readonly lifetime = new AbortController()
  private guestLifetime: AbortController | undefined
  private element: WebviewElement | undefined
  private lease: DesktopBrowserLeaseId | undefined
  private workspaceKey: string | undefined
  private initializing: Promise<void> | undefined
  private ready = false
  private pending: BrowserTarget | undefined
  private revision = 0
  private firstDocument = true
  private checkpoint: BrowserTarget | undefined
  private disposal: Promise<void> | undefined
  private attachment: AbortController | undefined
  private unsubscribeState: (() => void) | undefined
  private readonly releases = new Set<Promise<void>>()

  /**
   * @param options - saved address, persistence and source-tab opening callback.
   * @param bridge - main-process guest operations.
   * @param workspace - resolves the storage account once for this frame lifetime.
   * @param presentation - tag and Sidebar placement adapter.
   */
  constructor(private readonly options: BrowserPageOptions, private readonly bridge: DesktopBrowserBridge,
    private readonly workspace: (signal: AbortSignal) => Promise<string>,
    private readonly presentation: ElectronWebviewPresentation) {
    this.checkpoint = currentBrowserTarget(options.initial)
    this.store = createSnapshotStore(emptyBrowserFrame())
  }

  /** @returns immutable carrier-neutral navigation state. */
  getSnapshot = (): BrowserFrameState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** A physical mount may recreate a lost guest; ordinary Sidebar hiding never calls this. */
  attach(): void {
    if (this.lifetime.signal.aborted) return
    this.attachment = new AbortController()
    if (this.modelGuestUnavailable() || (this.options.automationLease !== undefined && this.store.getSnapshot().error !== undefined)) return
    this.pending ??= this.store.getSnapshot().target
    if (this.pending !== undefined) {
      this.store.set({ ...this.store.getSnapshot(), address: 'requested', loading: true,
        canGoBack: false, canGoForward: false, error: undefined })
      this.initialize()
    }
  }

  /** Invalidate pending attachment before the containing DOM is removed. */
  detach(): void {
    this.attachment?.abort()
    this.attachment = undefined
    this.pending = this.store.getSnapshot().target
    void this.dropGuest()
  }

  /** @param target - validated address, loaded without replacing the guest. */
  loadUrl(target: BrowserTarget): void {
    if (this.lifetime.signal.aborted) return
    const current = this.store.getSnapshot()
    if (this.ready && current.address === 'observed' && current.target?.url === target.url) {
      this.reload()
      return
    }
    this.revision++
    this.pending = target
    this.store.set({ ...current, target, address: 'requested', loading: true, error: undefined })
    this.persist(target)
    if (this.ready) this.loadPending()
    else this.initialize()
  }

  /** Move backward through Chromium history. */
  goBack(): void {
    if (this.store.getSnapshot().canGoBack) this.navigate('goBack')
  }

  /** Move forward through Chromium history. */
  goForward(): void {
    if (this.store.getSnapshot().canGoForward) this.navigate('goForward')
  }

  /** Reload the actual current page, or retry failed guest creation. */
  reload(): void {
    const current = this.store.getSnapshot()
    if (this.lifetime.signal.aborted || current.target === undefined) return
    if (!this.ready || current.error !== undefined) {
      this.revision++
      this.pending = current.target
      this.store.set({ ...current, loading: true, error: undefined })
      if (this.ready) this.loadPending()
      else this.initialize()
    } else this.navigate('reload')
  }

  /** @param action - trusted user gesture for this exact model-created tab. @returns after control settles. */
  async control(action: BrowserControlAction): Promise<void> {
    if (this.lifetime.signal.aborted || this.lease === undefined || this.options.automationLease === undefined) return
    try {
      if (this.bridge.control === undefined) throw new Error('Desktop browser controls are unavailable')
      await this.bridge.control(this.lease, action)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- IPC completion can race frame disposal.
      if (!this.lifetime.signal.aborted) this.store.set({ ...this.store.getSnapshot(), automationError: false })
    } catch (error) {
      console.error('Desktop browser control failed', error)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- IPC rejection can race frame disposal.
      if (!this.lifetime.signal.aborted) this.store.set({ ...this.store.getSnapshot(), automationError: true })
    }
  }

  /** @returns after pending initialization and the owned guest have been released. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifetime.abort()
    this.pending = undefined
    this.disposal = Promise.all([this.dropGuest(), this.initializing])
      .then(() => Promise.all(this.releases)).then(() => {})
    this.presentation.dispose()
    return this.disposal
  }

  private navigate(command: 'goBack' | 'goForward' | 'reload'): void {
    if (this.lifetime.signal.aborted || !this.ready || this.element === undefined) return
    this.revision++
    this.pending = undefined
    this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
    try { this.element[command]() }
    catch (error) { this.commandFailed(error) }
  }

  private initialize(): void {
    const attachment = this.attachment
    if (attachment === undefined || this.initializing !== undefined || this.element !== undefined || this.lifetime.signal.aborted) return
    if (this.modelGuestUnavailable()) {
      this.pending = undefined
      this.store.set({ ...this.store.getSnapshot(), loading: false })
      return
    }
    const signal = AbortSignal.any([this.lifetime.signal, attachment.signal])
    this.initializing = this.createGuest(signal).catch(async (error: unknown) => {
      if (!signal.aborted) {
        this.pending = undefined
        const lease = this.lease ?? this.options.automationLease
        if (this.options.automationLease !== undefined && lease !== undefined) {
          try {
            await this.bridge.reportFailure?.(lease, {
              code: 'browser-client-initialization-failed',
              message: failureMessage(error) ?? 'Browser client initialization failed.',
            })
          } catch (reportError) { console.error('Desktop browser failure report failed', reportError) }
        }
      }
      await this.dropGuest()
      if (!signal.aborted) this.commandFailed(error)
    }).finally(() => {
      this.initializing = undefined
      if (this.attachment !== attachment && this.pending !== undefined) this.initialize()
    })
  }

  private async createGuest(attachmentSignal: AbortSignal): Promise<void> {
    const automationLease = this.options.automationLease
    let reservation: DesktopBrowserReservation
    if (automationLease === undefined) {
      this.workspaceKey ??= await this.workspace(attachmentSignal)
      if (attachmentSignal.aborted) return
      reservation = await this.bridge.acquire(this.workspaceKey)
    } else {
      if (this.bridge.automationVersion !== 1 || this.bridge.claim === undefined) throw new Error('Desktop model browser bridge is unavailable')
      reservation = await this.bridge.claim(automationLease)
    }
    if (attachmentSignal.aborted) { await this.release(reservation.lease); return }
    this.lease = reservation.lease
    this.guestLifetime = new AbortController()
    const signal = AbortSignal.any([attachmentSignal, this.guestLifetime.signal])
    if (automationLease !== undefined) {
      let revision = 0
      this.unsubscribeState?.()
      const unsubscribeState = this.bridge.onState?.((state) => {
        if (String(state.target) !== String(reservation.lease) || attachmentSignal.aborted) return
        revision++
        this.applyAutomationState(state)
      })
      this.unsubscribeState = unsubscribeState
      if (unsubscribeState !== undefined) attachmentSignal.addEventListener('abort', unsubscribeState, { once: true })
      const baselineRevision = revision
      const state = await this.bridge.state?.(reservation.lease)
      if (!signal.aborted && state !== undefined && revision === baselineRevision) {
        this.applyAutomationState(state)
      }
      if (signal.aborted) return
    }
    const element = this.presentation.createElement(reservation)
    this.element = element
    const unsubscribeOpen = this.bridge.onOpenRequested(reservation.lease, (url) => {
      if (this.element === element && !signal.aborted) this.options.openRequested(url)
    })
    signal.addEventListener('abort', unsubscribeOpen, { once: true })
    element.addEventListener('dom-ready', () => {
      this.ready = true
      this.observe(this.store.getSnapshot().address !== 'requested')
      this.loadPending()
    }, { signal })
    element.addEventListener('did-navigate', () => { this.observe(true) }, { signal })
    element.addEventListener('did-navigate-in-page', (event) => {
      if ((event as NavigationEvent).isMainFrame) this.observe(true)
    }, { signal })
    element.addEventListener('did-start-navigation', (event) => {
      if ((event as NavigationEvent).isMainFrame) {
        this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
      }
    }, { signal })
    for (const name of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) {
      element.addEventListener(name, () => {
        this.observe(name === 'page-title-updated' && this.store.getSnapshot().address === 'observed')
      }, { signal })
    }
    element.addEventListener('did-fail-load', (event) => {
      const failure = event as LoadFailureEvent
      if (failure.isMainFrame && failure.errorCode !== -3) {
        this.failed({ code: failure.errorCode, description: failure.errorDescription })
      }
    }, { signal })
    let disconnected = false
    for (const name of ['render-process-gone', 'destroyed']) {
      element.addEventListener(name, () => {
        if (disconnected) return
        disconnected = true
        const message = `Browser guest ${name} before its next observation.`
        this.failed(this.store.getSnapshot().error ?? { code: undefined, description: message })
        this.pending = undefined
        if (automationLease === undefined || this.ready) { void this.dropGuest(); return }
        const cleanup = (async () => {
          try { await this.bridge.reportFailure?.(reservation.lease, { code: 'browser-client-initialization-failed', message }) }
          catch (error) { console.error('Desktop browser failure report failed', error) }
          if (this.element === element) await this.dropGuest()
        })().finally(() => { this.releases.delete(cleanup) })
        this.releases.add(cleanup)
      }, { signal })
    }
    this.presentation.present(element)
  }

  private loadPending(): void {
    const target = this.pending
    const element = this.element
    if (!this.ready || target === undefined || element === undefined) return
    const revision = this.revision
    this.pending = undefined
    void element.loadURL(target.url).catch((error: unknown) => {
      if (this.element !== element || this.lifetime.signal.aborted || this.revision !== revision) return
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_ABORTED') return
      if (this.store.getSnapshot().error === undefined) this.commandFailed(error)
    })
  }

  private observe(committed: boolean): void {
    if (!this.ready || this.element === undefined || this.lifetime.signal.aborted) return
    try { this.observeReady(this.element, committed) }
    catch (error) { this.commandFailed(error) }
  }

  private observeReady(element: WebviewElement, committed: boolean): void {
    const current = this.store.getSnapshot()
    const parsed = committed ? parseBrowserAddress(element.getURL()) : undefined
    if (parsed?.ok && this.firstDocument) {
      // The lease-bearing bootstrap document is not a user history entry.
      element.clearHistory()
      this.firstDocument = false
    }
    let target = current.target
    let address = current.address
    if (parsed?.ok) {
      target = { ...parsed.target, title: element.getTitle() || parsed.target.title }
      address = 'observed'
      this.presentation.show(target.title)
    }
    const loading = current.error === undefined && element.isLoading()
    const canGoBack = element.canGoBack()
    const canGoForward = element.canGoForward()
    if (target?.url !== current.target?.url || target?.title !== current.target?.title || address !== current.address
      || loading !== current.loading || canGoBack !== current.canGoBack || canGoForward !== current.canGoForward) {
      this.store.set({ ...current, target, address, loading, canGoBack, canGoForward })
    }
    if (parsed?.ok && target !== undefined) this.persist(target)
  }

  private persist(target: BrowserTarget): void {
    if (target.url === this.checkpoint?.url && target.title === this.checkpoint.title) return
    this.checkpoint = target
    this.options.persist(browserAddressCheckpoint(target, this.revision))
  }

  private modelGuestUnavailable(): boolean {
    const status = this.store.getSnapshot().automation?.status
    return this.options.automationLease !== undefined && (status === 'disconnected' || status === 'stopped')
  }

  private applyAutomationState(state: DesktopBrowserState): void {
    const current = this.store.getSnapshot()
    const unavailable = state.status === 'disconnected' || state.status === 'stopped'
    if (unavailable) this.pending = undefined
    this.store.set({ ...current, automation: state,
      ...(unavailable ? { loading: false } : {}),
      ...(state.failure === undefined ? {} : { error: { code: undefined, description: failureMessage(state.failure.message) } }),
    })
    if (state.status === 'disconnected' || (unavailable && this.element === undefined)) void this.dropGuest()
  }

  private failed(error: BrowserLoadError = { code: undefined, description: undefined }): void {
    if (this.lifetime.signal.aborted) return
    const current = this.store.getSnapshot()
    this.store.set({ ...current, loading: false, error,
      canGoBack: this.ready && current.canGoBack, canGoForward: this.ready && current.canGoForward })
  }

  private commandFailed(error: unknown): void {
    console.error('Desktop browser operation failed', error)
    this.failed({ code: undefined, description: failureMessage(error) })
  }

  private dropGuest(): Promise<void> {
    this.guestLifetime?.abort()
    this.guestLifetime = undefined
    this.presentation.clear()
    this.element = undefined
    this.ready = false
    this.firstDocument = true
    const lease = this.lease
    this.lease = undefined
    return lease === undefined ? Promise.resolve() : this.release(lease)
  }

  private release(lease: DesktopBrowserLeaseId): Promise<void> {
    const released = this.bridge.release(lease)
      .catch((error: unknown) => { console.error('Desktop browser guest release failed', error) })
      .finally(() => { this.releases.delete(released) })
    this.releases.add(released)
    return released
  }
}
