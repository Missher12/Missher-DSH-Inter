/** Native webview events controlled by each test; presentation and navigation stay real. */
import { vi } from 'vitest'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopBrowserReservation } from '../src/types.ts'
import type { BrowserTabState } from '../src/client/browser/BrowserPersistence.ts'
import { createElectronPage } from '../src/client/electron/pages.ts'
import { ElectronWebviewPresentation } from '../src/client/electron/ElectronWebviewPresentation.ts'
import type { DesktopBrowserState } from '@deepseek-ai/dsh-browser-use/desktop'

let sequence = 0

/** @returns one isolated, explicitly mounted page with native operations replaced by spies. */
export function electronFixture(initial?: BrowserTabState, modelState?: DesktopBrowserState) {
  const opens = new Set<(url: string) => void>()
  const states = new Set<(state: DesktopBrowserState) => void>()
  const reservation: DesktopBrowserReservation = { lease: (modelState?.target ?? `lease-${++sequence}`) as DesktopBrowserLeaseId, partition: 'partition' }
  const bridge = {
    automationVersion: 1,
    claim: vi.fn(async (_lease: DesktopBrowserLeaseId) => reservation),
    state: vi.fn(async (_lease: DesktopBrowserLeaseId) => modelState),
    reportFailure: vi.fn(async (_lease: DesktopBrowserLeaseId, _failure: Parameters<NonNullable<DesktopBrowserBridge['reportFailure']>>[1]) => {}),
    control: vi.fn(async (_lease: DesktopBrowserLeaseId, _action: Parameters<NonNullable<DesktopBrowserBridge['control']>>[1]) => {}),
    onState: (listener: (state: DesktopBrowserState) => void) => { states.add(listener); return () => { states.delete(listener) } },
    acquire: vi.fn(async (_workspace: string) => reservation),
    release: vi.fn(async (_lease: DesktopBrowserLeaseId) => {}),
    onOpenRequested: vi.fn((_lease: DesktopBrowserLeaseId, listener: (url: string) => void) => {
      opens.add(listener)
      return () => { opens.delete(listener) }
    }),
  } satisfies DesktopBrowserBridge
  const workspace = vi.fn(async (_signal: AbortSignal) => 'cwd:/workspace')
  const persist = vi.fn()
  const openRequested = vi.fn()
  const page = createElectronPage({ initial, persist, openRequested,
    ...modelState === undefined ? {} : { automationLease: reservation.lease } }, bridge, workspace)
  const presentation = page.presentation
  if (!(presentation instanceof ElectronWebviewPresentation)) throw new Error('expected the Electron presentation')
  const create = presentation.createElement.bind(presentation)
  const guests: ReturnType<typeof prepareGuest>[] = []
  function prepareGuest(approved: DesktopBrowserReservation) {
    const element = create(approved)
    const state = { url: 'about:blank', title: '', loading: true, back: false, forward: false }
    const methods = {
      loadURL: vi.fn(async (_url: string) => {}), getURL: vi.fn(() => state.url), getTitle: vi.fn(() => state.title),
      canGoBack: () => state.back, canGoForward: () => state.forward, clearHistory: vi.fn(),
      goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => state.loading,
    }
    Object.assign(element, methods)
    const emit = (type: string, fields: object = {}): void => { element.dispatchEvent(Object.assign(new Event(type), fields)) }
    return { element, state, emit, ...methods }
  }
  const createElement = vi.spyOn(presentation, 'createElement').mockImplementation((approved) => {
    const guest = prepareGuest(approved)
    guests.push(guest)
    return guest.element
  })
  const host = document.createElement('div')
  host.id = `electron-fixture-${sequence}`
  document.body.append(host)
  return {
    ...page, presentation, bridge, workspace, persist, openRequested, opens, states, guests, host, reservation,
    mount: () => presentation.mount(host.id),
    async guest() {
      await vi.waitFor(() => { expectGuest() })
      return guests.at(-1)!
    },
    async dispose() {
      await page.frame.dispose()
      createElement.mockRestore()
      host.remove()
    },
  }
  function expectGuest(): void {
    if (host.firstElementChild === null || guests.length === 0) throw new Error('guest has not attached')
  }
}
