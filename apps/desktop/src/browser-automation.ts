/** Exact-guest browser actions. The trusted Host supplies owners; model JSON never selects webContents. */
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type {
  BrowserOwner, BrowserTargetId, BrowserSnapshotId, DesktopBrowserFailure, DesktopBrowserRequest, DesktopBrowserResult, DesktopBrowserState,
} from '@deepseek-ai/dsh-browser-use/desktop'
import type { DesktopBrowserLeaseId, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

interface Entry {
  owner: BrowserOwner
  reservation: DesktopBrowserReservation
  guest?: WebContents
  state: DesktopBrowserState
  snapshot?: BrowserSnapshotId
  elements: Map<string, number>
  tail: Promise<void>
  generation: number
  controlRevision: number
  pending: Set<AbortController>
  inFlight: Set<Promise<unknown>>
  closing?: Promise<void>
}
/** Desktop dependencies expose only owned guest allocation and trusted file selection. */
export interface BrowserAutomationHost {
  /** @returns an approved Sidebar reservation. */
  reserve(owner: BrowserOwner): DesktopBrowserReservation
  /** @param owner - destination Session. @param reservation - pre-approved guest. @param url - initial address. */
  present(owner: BrowserOwner, reservation: DesktopBrowserReservation, url: string): void
  /** @param lease - owned guest reservation. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param state - content-free projection to trusted UI. */
  publish(state: DesktopBrowserState): void
  /** @param value - untrusted requested URL. @returns whether navigation is permitted. */
  allowed(value: string): boolean
  /** @param target - owned guest. @returns explicitly selected regular files, or cancellation. */
  selectUpload(target: WebContents): Promise<string[]>
}
const result = (status: DesktopBrowserResult['status'], message: string): DesktopBrowserResult => ({ status, message })
const sameOwner = (a: BrowserOwner, b: BrowserOwner): boolean => a.sessionId === b.sessionId && a.activationId === b.activationId
const keys = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
// Transport safety ceilings, including native calls that do not accept AbortSignal.
const operationDeadlineMs = 30_000
const fileSelectionDeadlineMs = 120_000

/** Owns model-created guests, queues, control transfer and observation generations. */
export class DesktopBrowserAutomation {
  private stopped = false
  private readonly entries = new Map<BrowserTargetId, Entry>()
  private readonly retired = new Set<string>()
  private readonly paintingOwners = new Map<WebContents, { users: number; throttling: boolean }>()
  constructor(private readonly host: BrowserAutomationHost) {}

  /** @param lease - main-issued guest. @param guest - attached webContents. */
  attached(lease: DesktopBrowserLeaseId, guest: WebContents): void {
    const entry = this.entries.get(lease as string as BrowserTargetId)
    if (this.stopped || entry === undefined || entry.closing !== undefined
      || entry.state.status !== 'initializing' || entry.state.failure !== undefined) return
    entry.guest = guest
    guest.on('did-start-navigation', (_event, _url, _inPlace, main) => { if (main) this.invalidate(entry) })
    guest.on('render-process-gone', () => { this.change(entry, 'disconnected'); this.invalidate(entry) })
    guest.once('destroyed', () => { this.change(entry, 'disconnected'); this.invalidate(entry) })
    // The trusted toolbar owns takeover; synthesized CDP input must not claim user authority.
    this.change(entry, 'ready')
  }

  /** @param parent - model-owned source guest. @param url - allowed popup URL. @returns whether ownership handled the popup. */
  openPopup(parent: string, url: string): boolean {
    const entry = this.entries.get(parent as BrowserTargetId)
    if (entry === undefined) return false
    if (entry.state.status === 'stopped' || entry.state.status === 'taken-over') return true
    void this.request({ owner: entry.owner, operation: { action: 'open', url } }, new AbortController().signal)
      .catch((error: unknown) => { console.error('Owned browser popup failed', error) })
    return true
  }

  /** @param target - owned lease. @returns content-free state for trusted UI. */
  state(target: string): DesktopBrowserState | undefined { return this.entries.get(target as BrowserTargetId)?.state }

  /** @param lease - owned initializing reservation. @param failure - bounded attachment diagnosis. */
  failed(lease: DesktopBrowserLeaseId, failure: DesktopBrowserFailure): void {
    const entry = this.entries.get(lease as string as BrowserTargetId)
    if (entry === undefined || entry.closing !== undefined || entry.state.status !== 'initializing') return
    entry.state = { ...entry.state, status: 'disconnected', failure }
    console.error(`Browser initialization failed [${failure.code}]: ${failure.message}`)
    this.publish(entry.state)
  }

  /** @param target - trusted UI target. @param action - explicit user control. @returns committed state. */
  async control(target: string, action: 'stop' | 'takeover' | 'resume'): Promise<DesktopBrowserState> {
    const entry = this.entries.get(target as BrowserTargetId)
    if (entry === undefined) throw new Error('Browser target is no longer available')
    if (action === 'resume') {
      const revision = ++entry.controlRevision
      await entry.tail
      if (revision !== entry.controlRevision || entry.closing !== undefined || this.stopped) return entry.state
      if (entry.guest?.isDestroyed() !== false) throw new Error('Reopen the disconnected browser')
      if (entry.inFlight.size !== 0) throw new Error('A previous browser command is still settling. Inspect the page manually, or close and reopen this tab before resuming.')
      entry.state = { target: entry.state.target, sessionId: entry.owner.sessionId,
        status: entry.state.status, storage: entry.state.storage }
      this.invalidate(entry)
      this.change(entry, 'ready')
    } else {
      this.take(entry, action === 'stop' ? 'stopped' : 'taken-over')
      await entry.tail
    }
    return entry.state
  }

  /**
   * @param request - validated finite operation with Host-owned identity.
   * @param signal - caller cancellation.
   * @returns outcome with no automatic action replay.
   */
  async request(request: DesktopBrowserRequest, signal: AbortSignal): Promise<DesktopBrowserResult> {
    signal.throwIfAborted()
    if (this.stopped) return result('unavailable', 'The browser Host has stopped. Reconnect before opening new tabs.')
    const { owner, operation: op } = request
    if (this.retired.has(owner.activationId)) return result('stale-target', 'This browser activation has ended.')
    if (op.action === 'list') return { ...result('observed', 'Only this activation’s browser tabs are listed.'), data: [...this.entries.values()].filter(e => sameOwner(e.owner, owner)).map(e => e.state) }
    if (op.action === 'release') {
      this.retired.add(owner.activationId)
      await Promise.all([...this.entries.values()].filter(e => sameOwner(e.owner, owner)).map(e => this.close(e)))
      return result('closed', 'Owned browser tabs have closed; stored login data is retained.')
    }
    if (op.action === 'open') {
      if (!this.host.allowed(op.url)) return result('denied', 'Only ordinary HTTP(S) pages outside the application Host may be opened.')
      const reservation = this.host.reserve(owner)
      const target = reservation.lease as string as BrowserTargetId
      const entry: Entry = { owner, reservation, state: { target, sessionId: owner.sessionId, status: 'initializing', storage: reservation.partition.startsWith('persist:') ? 'persistent' : 'temporary' }, elements: new Map(), tail: Promise.resolve(), generation: 0, controlRevision: 0, pending: new Set(), inFlight: new Set() }
      this.entries.set(target, entry)
      const opening = new AbortController()
      entry.pending.add(opening)
      const active = AbortSignal.any([signal, opening.signal])
      try {
        this.host.present(owner, reservation, op.url)
        this.publish(entry.state)
        const deadline = Date.now() + 15_000
        while (entry.guest === undefined && entry.state.failure === undefined && Date.now() < deadline) {
          active.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        active.throwIfAborted()
        if (entry.guest === undefined || entry.guest.isDestroyed() || entry.state.status === 'disconnected') {
          const failure = entry.state.failure ?? (entry.guest === undefined
            ? { code: 'browser-attach-timeout', message: 'Browser webview did not attach within 15 seconds. Check the tab initialization error and Desktop attachment log.' }
            : { code: 'browser-guest-disconnected', message: 'Browser webview disconnected before opening completed. Open a new tab after checking the Desktop log.' })
          entry.state = { ...entry.state, status: 'disconnected', failure }
          this.publish(entry.state)
          await this.close(entry)
          return { ...result('unavailable', failure.message), data: { failure } }
        }
        return { ...result('delivered', 'A visible Sidebar tab was opened. Observe it before acting.'), target }
      } catch (error) { await this.close(entry); throw error }
      finally { entry.pending.delete(opening) }
    }
    const entry = this.entries.get(op.target)
    if (entry === undefined || !sameOwner(entry.owner, owner)) return result('stale-target', 'This target does not belong to the current activation.')
    if (op.action === 'close') { await this.close(entry); return result('closed', 'Browser tab closed.') }
    const generation = entry.generation
    const controller = new AbortController()
    entry.pending.add(controller)
    const combined = AbortSignal.any([signal, controller.signal])
    const task = entry.tail.then(async () => {
      combined.throwIfAborted()
      if (entry.state.status === 'taken-over' || entry.state.status === 'stopped') return result('denied', entry.state.failure === undefined
        ? 'Browser control is stopped. Resume from the browser toolbar, then observe again.'
        : `Browser control stopped after ${entry.state.failure.code}. Close and reopen this tab before continuing.`)
      if (entry.state.status === 'disconnected' || entry.guest?.isDestroyed() !== false) return result('stale-target', 'Browser target disconnected. Open a new tab and observe it.')
      if (generation !== entry.generation && 'snapshot' in op) return result('stale-snapshot', 'The page changed while this action was queued. Observe again.')
      this.change(entry, 'running', op.action)
      const timeout = new AbortController()
      const timer = setTimeout(() => { timeout.abort() }, op.action === 'upload' ? fileSelectionDeadlineMs : operationDeadlineMs)
      const active = AbortSignal.any([combined, timeout.signal])
      const guest = entry.guest
      let throttling: boolean | undefined
      const readOnly = op.action === 'screenshot' || op.action === 'observe' || op.action === 'wait'
      let releaseOwnerPainting: (() => void) | undefined
      try {
        throttling = guest.getBackgroundThrottling()
        // A guest's WasShown does not synchronize the occluded owner view's surface.
        // Concurrent targets share this temporary owner lease without activating it.
        releaseOwnerPainting = this.keepOwnerPainting(guest)
        guest.setBackgroundThrottling(false)
        return await this.execute(entry, op, active)
      }
      catch (error) {
        if (active.aborted) {
          if (entry.state.status === 'running') this.take(entry, 'stopped')
          const reason = timeout.signal.aborted ? 'timed out' : 'was interrupted'
          const message = readOnly
            ? `Browser ${op.action} ${reason}. No ${op.action === 'screenshot' ? 'image' : 'observation'} is available from this operation. Control stopped; close and reopen this tab before continuing.`
            : `Browser ${op.action} ${reason}. Input may have completed; do not replay it. Inspect the page, then resume and observe. If a command is still settling, close and reopen the tab.`
          entry.state = { ...entry.state, failure: { code: timeout.signal.aborted ? 'browser-operation-timeout' : 'browser-operation-interrupted', message } }
          this.publish(entry.state)
          return { ...result('uncertain', message), target: entry.state.target, data: { failure: entry.state.failure } }
        }
        // Electron errors can carry URLs and filesystem paths; the product receives a bounded diagnosis.
        console.error('Owned browser operation failed', error)
        this.invalidate(entry)
        if (readOnly) return result('unavailable', `Browser ${op.action} failed. No ${op.action === 'screenshot' ? 'image' : 'observation'} is available from this operation. Check the Desktop log and observe again before acting.`)
        return result('uncertain', 'The browser could not confirm this operation. Already delivered input may have completed. Observe current state before deciding what to do next.')
      } finally {
        clearTimeout(timer)
        try {
          try { if (throttling !== undefined && !guest.isDestroyed()) guest.setBackgroundThrottling(throttling) }
          finally { releaseOwnerPainting?.() }
        } catch (error) {
          console.error('Owned browser rendering restoration failed', error)
          this.take(entry, 'stopped')
          entry.state = { ...entry.state, failure: { code: 'browser-rendering-restore-failed',
            message: 'The browser could not restore its rendering settings. Close and reopen this tab before continuing.' } }
          this.publish(entry.state)
        }
        if (entry.state.status === 'running') this.change(entry, 'ready')
      }
    }).finally(() => { entry.pending.delete(controller) })
    entry.tail = task.then(() => {}, () => {})
    return task
  }

  /** Close only model-owned guests on Host disconnect. @returns after owned queues settle. */
  async dispose(): Promise<void> {
    this.stopped = true
    for (const entry of this.entries.values()) this.retired.add(entry.owner.activationId)
    await Promise.all([...this.entries.values()].map(e => this.close(e)))
  }

  private async execute(entry: Entry, op: Exclude<DesktopBrowserRequest['operation'], { action: 'open' | 'list' | 'release' }>, signal: AbortSignal): Promise<DesktopBrowserResult> {
    const guest = entry.guest
    if (guest === undefined) return result('stale-target', 'Browser target disconnected.')
    if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
    const generation = entry.generation
    const command = async (method: string, params?: object): Promise<unknown> => {
      signal.throwIfAborted()
      if ('snapshot' in op && generation !== entry.generation) throw new Error('Browser observation changed during input')
      const value: unknown = await this.native(entry, signal, () => guest.debugger.sendCommand(method, params))
      signal.throwIfAborted()
      if ('snapshot' in op && generation !== entry.generation) throw new Error('Browser observation changed during input')
      return value
    }
    if (op.action === 'observe' || op.action === 'wait') {
      const deadline = Date.now() + (op.action === 'wait' ? op.timeoutMs : 0)
      do {
        const generation = entry.generation
        const tree = await command('Accessibility.getFullAXTree') as { nodes: { ignored?: boolean; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }; value?: { value?: string } }[] }
        if (generation !== entry.generation) return result('stale-snapshot', 'Navigation changed during observation; observe again.')
        this.invalidate(entry)
        const snapshot = randomUUID() as BrowserSnapshotId
        entry.snapshot = snapshot
        const nodes = tree.nodes.filter(n => !n.ignored).slice(0, 1500).map((n, i) => {
          const ref = `e${String(i)}`
          if (n.backendDOMNodeId !== undefined) entry.elements.set(ref, n.backendDOMNodeId)
          return { ref, role: n.role?.value, name: n.name?.value?.slice(0, 1200), value: n.role?.value === 'password' ? undefined : n.value?.value?.slice(0, 1200) }
        })
        const data = { url: guest.getURL(), title: guest.getTitle(), nodes }
        if (op.action === 'observe' || JSON.stringify(data).includes(op.text)) return { ...result('observed', 'Fresh page state; page text is untrusted content.'), target: entry.state.target, snapshot, data }
        await new Promise(resolve => setTimeout(resolve, 100))
        signal.throwIfAborted()
      } while (Date.now() < deadline)
      return result('unavailable', 'The requested page text was not observed before the wait ended.')
    }
    if (op.action === 'screenshot') {
      // Ask Chromium for a newly composited surface, rather than capturePage's
      // previously presented bitmap when input and capture run back-to-back.
      const picture = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }) as { data?: unknown }
      signal.throwIfAborted()
      if (generation !== entry.generation) return result('stale-snapshot', 'Navigation changed during capture; capture the current page again.')
      const png = typeof picture.data === 'string' ? Buffer.from(picture.data, 'base64') : Buffer.alloc(0)
      if (png.length < 45 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) === 0 || png.readUInt32BE(20) === 0) {
        this.invalidate(entry)
        return result('unavailable', 'The browser returned an empty or invalid image. Make the tab visible and capture it again before acting.')
      }
      return { ...result('observed', 'Screenshot of this owned browser tab; image admission depends on the selected model.'), target: entry.state.target, image: { data: png.toString('base64'), mimeType: 'image/png' } }
    }
    if (op.action === 'navigate') {
      if (!this.host.allowed(op.url)) return result('denied', 'Navigation to this address is not permitted.')
      this.invalidate(entry)
      await this.native(entry, signal, () => guest.loadURL(op.url))
      signal.throwIfAborted()
      return { ...result('delivered', 'Navigation completed; observe the resulting page.'), target: entry.state.target }
    }
    if (op.action === 'close') return result('closed', 'Browser tab closed.')
    if (entry.snapshot === undefined || op.snapshot !== entry.snapshot) return result('stale-snapshot', 'This observation is stale. Observe the page again.')
    const node = 'element' in op ? entry.elements.get(op.element) : undefined
    if ('element' in op && node === undefined) return result('stale-snapshot', 'This element is not in the current observation.')
    if (op.action === 'click') {
      await command('DOM.scrollIntoViewIfNeeded', { backendNodeId: node })
      const box = await command('DOM.getBoxModel', { backendNodeId: node }) as { model: { content: number[] } }
      const points = box.model.content
      const [x0, y0, , , x1, y1] = points
      if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) throw new Error('Element has no bounds')
      const x = (x0 + x1) / 2, y = (y0 + y1) / 2
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    } else if (op.action === 'fill') {
      guest.focus()
      await command('DOM.focus', { backendNodeId: node })
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] })
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' })
      await this.native(entry, signal, () => guest.insertText(op.text))
      signal.throwIfAborted()
      if (generation !== entry.generation) throw new Error('Browser observation changed during input')
    } else if (op.action === 'press') {
      if (!keys.has(op.key)) return result('denied', 'This key is not supported by browser control.')
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: op.key })
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: op.key })
    } else if (op.action === 'scroll') {
      await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 40, y: 40, deltaX: 0, deltaY: op.delta })
    } else {
      const files = await this.native(entry, signal, () => this.host.selectUpload(guest))
      signal.throwIfAborted()
      if (files.length === 0) return result('cancelled', 'The user did not select a file.')
      if (entry.snapshot !== op.snapshot) return result('stale-snapshot', 'The page changed during file selection; observe again.')
      await command('DOM.setFileInputFiles', { backendNodeId: node, files })
    }
    this.invalidate(entry)
    return { ...result('delivered', 'Input was delivered. Observe the page to verify the requested outcome.'), target: entry.state.target }
  }

  // Stop waiting promptly, but retain unsettled native work so resume cannot overlap it.
  // Cancellation does not undo an input already dispatched to Chromium.
  private async native<T>(entry: Entry, signal: AbortSignal, start: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const pending = start()
    entry.inFlight.add(pending)
    const settled = pending.finally(() => { entry.inFlight.delete(pending) })
    let abort: (() => void) | undefined
    try {
      return await Promise.race([settled, new Promise<never>((_resolve, reject) => {
        abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Browser operation cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })])
    } finally { if (abort !== undefined) signal.removeEventListener('abort', abort) }
  }

  private keepOwnerPainting(guest: WebContents): () => void {
    const owner = guest.hostWebContents
    if (owner === null || owner.isDestroyed()) return () => {}
    let lease = this.paintingOwners.get(owner)
    if (lease === undefined) {
      const throttling = owner.getBackgroundThrottling()
      owner.setBackgroundThrottling(false)
      lease = { users: 0, throttling }
      this.paintingOwners.set(owner, lease)
    }
    lease.users++
    return () => {
      if (--lease.users !== 0) return
      this.paintingOwners.delete(owner)
      if (!owner.isDestroyed()) owner.setBackgroundThrottling(lease.throttling)
    }
  }

  private invalidate(entry: Entry): void { entry.generation++; delete entry.snapshot; entry.elements.clear() }
  private take(entry: Entry, status: 'taken-over' | 'stopped'): void {
    entry.controlRevision++
    this.invalidate(entry)
    this.change(entry, status)
    for (const pending of entry.pending) pending.abort()
  }
  private change(entry: Entry, status: DesktopBrowserState['status'], operation?: string): void {
    entry.state = { target: entry.state.target, sessionId: entry.owner.sessionId, status, storage: entry.state.storage,
      ...(entry.state.failure === undefined ? {} : { failure: entry.state.failure }),
      ...(operation === undefined ? {} : { operation }) }
    this.publish(entry.state)
  }
  private publish(state: DesktopBrowserState): void {
    try { this.host.publish(state) } catch (_error) { console.error('Browser state destination disconnected') }
  }
  private close(entry: Entry): Promise<void> {
    if (entry.closing !== undefined) return entry.closing
    if (entry.state.failure === undefined) this.take(entry, 'stopped')
    else {
      entry.controlRevision++
      this.invalidate(entry)
      for (const pending of entry.pending) pending.abort()
    }
    entry.closing = (async () => {
      // Destroy this exact guest before awaiting the queue: a stalled renderer must not
      // prevent close/dispose. No later continuation can dispatch after take() aborts it.
      try { await this.host.release(entry.reservation.lease); await entry.tail }
      finally { this.entries.delete(entry.state.target) }
    })()
    return entry.closing
  }
}
