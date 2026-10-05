/** Exact-guest browser actions. The trusted Host supplies owners; model JSON never selects webContents. */
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type {
  BrowserOwner, BrowserTargetId, BrowserSnapshotId, DesktopBrowserRequest, DesktopBrowserResult, DesktopBrowserState,
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

/** Owns model-created guests, queues, control transfer and observation generations. */
export class DesktopBrowserAutomation {
  private stopped = false
  private readonly entries = new Map<BrowserTargetId, Entry>()
  private readonly retired = new Set<string>()
  constructor(private readonly host: BrowserAutomationHost) {}

  /** @param lease - main-issued guest. @param guest - attached webContents. */
  attached(lease: DesktopBrowserLeaseId, guest: WebContents): void {
    const entry = this.entries.get(lease as string as BrowserTargetId)
    if (entry === undefined || entry.closing !== undefined) return
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

  /** @param target - trusted UI target. @param action - explicit user control. @returns committed state. */
  async control(target: string, action: 'stop' | 'takeover' | 'resume'): Promise<DesktopBrowserState> {
    const entry = this.entries.get(target as BrowserTargetId)
    if (entry === undefined) throw new Error('Browser target is no longer available')
    if (action === 'resume') {
      const revision = ++entry.controlRevision
      await entry.tail
      if (revision !== entry.controlRevision || entry.closing !== undefined || this.stopped) return entry.state
      if (entry.guest?.isDestroyed() !== false) throw new Error('Reopen the disconnected browser')
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
      const entry: Entry = { owner, reservation, state: { target, sessionId: owner.sessionId, status: 'initializing', storage: reservation.partition.startsWith('persist:') ? 'persistent' : 'temporary' }, elements: new Map(), tail: Promise.resolve(), generation: 0, controlRevision: 0, pending: new Set() }
      this.entries.set(target, entry)
      const opening = new AbortController()
      entry.pending.add(opening)
      const active = AbortSignal.any([signal, opening.signal])
      try {
        this.host.present(owner, reservation, op.url)
        this.publish(entry.state)
        const deadline = Date.now() + 15_000
        while (entry.guest === undefined && Date.now() < deadline) {
          active.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        active.throwIfAborted()
        if (entry.guest === undefined) { await this.close(entry); return result('unavailable', 'Open this session in the desktop window, then retry opening a browser tab.') }
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
      if (entry.state.status === 'taken-over' || entry.state.status === 'stopped') return result('denied', 'The user has stopped browser control. Resume from the browser toolbar, then observe again.')
      if (entry.guest?.isDestroyed() !== false) return result('stale-target', 'Browser target disconnected. Open a new tab and observe it.')
      if (generation !== entry.generation && 'snapshot' in op) return result('stale-snapshot', 'The page changed while this action was queued. Observe again.')
      this.change(entry, 'running', op.action)
      try { return await this.execute(entry, op, combined) }
      catch (error) {
        if (combined.aborted) return result('uncertain', 'Browser work was interrupted. Already delivered input is not undone; observe before deciding what to do next.')
        // Electron errors can carry URLs and filesystem paths; the product receives a bounded diagnosis.
        console.error('Owned browser operation failed', error)
        this.invalidate(entry)
        return result('uncertain', 'The browser could not confirm this operation. Already delivered input may have completed. Observe current state before deciding what to do next.')
      } finally {
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
      const value: unknown = await guest.debugger.sendCommand(method, params)
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
      const picture = await guest.capturePage()
      signal.throwIfAborted()
      return { ...result('observed', 'Screenshot of this visible browser tab; image admission depends on the selected model.'), target: entry.state.target, image: { data: picture.toPNG().toString('base64'), mimeType: 'image/png' } }
    }
    if (op.action === 'navigate') {
      if (!this.host.allowed(op.url)) return result('denied', 'Navigation to this address is not permitted.')
      this.invalidate(entry)
      await guest.loadURL(op.url)
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
      await guest.insertText(op.text)
      signal.throwIfAborted()
      if (generation !== entry.generation) throw new Error('Browser observation changed during input')
    } else if (op.action === 'press') {
      if (!keys.has(op.key)) return result('denied', 'This key is not supported by browser control.')
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: op.key })
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: op.key })
    } else if (op.action === 'scroll') {
      await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 40, y: 40, deltaX: 0, deltaY: op.delta })
    } else {
      const files = await this.host.selectUpload(guest)
      signal.throwIfAborted()
      if (files.length === 0) return result('cancelled', 'The user did not select a file.')
      if (entry.snapshot !== op.snapshot) return result('stale-snapshot', 'The page changed during file selection; observe again.')
      await command('DOM.setFileInputFiles', { backendNodeId: node, files })
    }
    this.invalidate(entry)
    return { ...result('delivered', 'Input was delivered. Observe the page to verify the requested outcome.'), target: entry.state.target }
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
      ...(operation === undefined ? {} : { operation }) }
    this.publish(entry.state)
  }
  private publish(state: DesktopBrowserState): void {
    try { this.host.publish(state) } catch (_error) { console.error('Browser state destination disconnected') }
  }
  private close(entry: Entry): Promise<void> {
    if (entry.closing !== undefined) return entry.closing
    this.take(entry, 'stopped')
    entry.closing = (async () => {
      try { await entry.tail; await this.host.release(entry.reservation.lease) }
      finally { this.entries.delete(entry.state.target) }
    })()
    return entry.closing
  }
}
