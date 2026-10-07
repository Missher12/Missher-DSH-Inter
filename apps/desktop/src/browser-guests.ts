/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { createHash, randomUUID } from 'node:crypto'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'
import type { DesktopBrowserFailure } from '@deepseek-ai/dsh-browser-use/desktop'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  pendingGuest?: WebContents
  releaseInput?: () => void
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly guestLeases = new Map<number, DesktopBrowserLeaseId>()

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(
    private readonly hostUrl: () => string | undefined,
    private readonly download?: (event: Electron.Event, item: Electron.DownloadItem, guest: WebContents) => void,
    private readonly openRequested?: (lease: DesktopBrowserLeaseId, url: string) => boolean,
  ) {}

  /**
   * Reserve one guest in a workspace's process-lifetime partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown, persistent = false): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    const storageKey = `${persistent ? 'persistent' : 'temporary'}:${workspace}`
    let partition = this.partitions.get(storageKey)
    if (partition === undefined) {
      partition = persistent ? `persist:dsh-browser-${createHash('sha256').update(workspace).digest('hex')}` : `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(storageKey, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false })
    return { lease, partition }
  }

  /** @param owner - trusted caller. @param id - pre-issued model guest. @returns the reservation if still owned and unattached. */
  claim(owner: WebContents, id: unknown): DesktopBrowserReservation {
    const lease = this.owned(owner, id)
    if (lease.attached) throw new Error('Browser reservation already attached')
    return { lease: id as DesktopBrowserLeaseId, partition: lease.partition }
  }

  /** @param owner - trusted caller. @param id - main-issued lease. @returns exact attached guest. */
  guest(owner: WebContents, id: unknown): WebContents {
    const value = this.owned(owner, id).guest
    if (value === undefined || value.isDestroyed()) throw new Error('Browser target unavailable')
    return value
  }

  private owned(owner: WebContents, id: unknown): GuestLease {
    if (typeof id !== 'string') throw new Error('Invalid browser lease')
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    if (lease === undefined || lease.owner !== owner) throw new Error('Browser target belongs to another window')
    return lease
  }

  /** @param owner - authenticated caller. @param id - reservation, which need not be attached. @returns validated lease identity. */
  assertOwned(owner: WebContents, id: unknown): DesktopBrowserLeaseId {
    this.owned(owner, id)
    return id as DesktopBrowserLeaseId
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    lease.releaseInput?.()
    this.leases.delete(key)
    const guest = lease.guest ?? lease.pendingGuest
    if (guest !== undefined) this.guestLeases.delete(guest.id)
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void,
    attached?: (lease: DesktopBrowserLeaseId, guest: WebContents) => void,
    failed?: (lease: DesktopBrowserLeaseId, failure: DesktopBrowserFailure) => void): void {
    const owner = window.webContents
    let creating: { id: DesktopBrowserLeaseId; lease: GuestLease } | undefined
    // Electron creates webContents synchronously immediately after will-attach returns.
    // This one-call boundary expires at the next microtask; it is never a FIFO of tabs.
    const created = (_event: Electron.Event, guest: WebContents): void => {
      const current = creating
      if (current === undefined || guest.getType() !== 'webview' || guest.hostWebContents !== owner
        || guest.session !== session.fromPartition(current.lease.partition) || this.leases.get(current.id) !== current.lease) return
      creating = undefined
      current.lease.pendingGuest = guest
      this.guestLeases.set(guest.id, current.id)
      guest.once('destroyed', () => {
        current.lease.releaseInput?.()
        this.guestLeases.delete(guest.id)
        this.leases.delete(current.id)
      })
    }
    app.on('web-contents-created', created)
    owner.once('destroyed', () => { app.off('web-contents-created', created) })
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached
        || params.partition !== lease.partition || creating !== undefined) {
        event.preventDefault()
        const reason = lease === undefined ? 'unknown lease or invalid initial URL'
          : lease.owner !== owner ? 'foreign window' : lease.attached ? 'lease already attached'
            : params.partition !== lease.partition ? 'partition mismatch' : 'overlapping guest creation'
        console.error(`Browser webview attachment rejected: ${reason}`)
        // A rejected duplicate or foreign caller must not invalidate an existing guest.
        if (lease?.owner === owner && !lease.attached) failed?.(id as DesktopBrowserLeaseId,
          { code: 'browser-attach-rejected', message: `Browser webview attachment rejected: ${reason}` })
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
      const current = { id: id as DesktopBrowserLeaseId, lease }
      creating = current
      queueMicrotask(() => {
        if (creating !== current) return
        creating = undefined
        failed?.(current.id, { code: 'browser-guest-not-created', message: 'Electron did not create the approved browser guest during attachment.' })
      })
    })
    owner.on('did-attach-webview', (_event, guest) => {
      const id = this.guestLeases.get(guest.id)
      const lease = id === undefined ? undefined : this.leases.get(id)
      if (id === undefined || lease === undefined || lease.owner !== owner || !lease.attached || lease.guest !== undefined
        || lease.pendingGuest !== guest || guest.hostWebContents !== owner || guest.session !== session.fromPartition(lease.partition)) {
        console.error('Browser webview binding rejected: missing or mismatched native guest reservation')
        if (id !== undefined && lease?.owner === owner && lease.guest === undefined) failed?.(id,
          { code: 'browser-guest-binding-rejected', message: 'Browser webview binding rejected: missing or mismatched native guest reservation' })
        guest.close({ waitForBeforeUnload: false })
        return
      }
      lease.guest = guest
      delete lease.pendingGuest
      lease.releaseInput = attachInput(guest, id)
      attached?.(id, guest)
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const attachedLease = this.guestLeases.get(guest.id)
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          if (this.openRequested?.(attachedLease, request.url) !== true) owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event, item, guest) => {
      if (this.download === undefined || ![...this.leases.values()].some(lease => lease.guest === guest)) event.preventDefault()
      else this.download(event, item, guest)
    })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  /** @param value - requested URL. @returns whether the page may navigate outside the Host. */
  allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
