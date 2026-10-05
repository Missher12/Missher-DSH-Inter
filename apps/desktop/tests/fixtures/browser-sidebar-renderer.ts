/** Real page and presentation composition, with two explicit failure injections. */
import { createElectronPage } from '../../../../packages/client/ui-sidebar-browser/src/client/electron/pages.ts'
import { ElectronWebviewPresentation } from '../../../../packages/client/ui-sidebar-browser/src/client/electron/ElectronWebviewPresentation.ts'
import type { DesktopBrowserBridge } from '../../../../packages/client/ui-sidebar-browser/src/types.ts'

declare global {
  interface Window {
    sidebarFixture: { browser: DesktopBrowserBridge; ready(): void; state(lease: string, value: object): void }
  }
}

const fixture = window.sidebarFixture
fixture.browser.onModelOpen?.((request) => {
  const container = document.createElement('section')
  container.id = `guest-${request.lease}`
  container.style.cssText = 'display:flex;width:800px;height:400px'
  const status = document.createElement('p')
  status.dataset.lease = request.lease
  document.body.append(status, container)
  const page = createElectronPage({ initial: undefined, automationLease: request.lease, persist: () => {}, openRequested: () => {} },
    fixture.browser, async () => 'fixture-only')
  if (!(page.presentation instanceof ElectronWebviewPresentation)) throw new Error('Expected native webview presentation')
  const pathname = new URL(request.url).pathname
  if (pathname === '/client-failure') {
    page.presentation.present = () => { throw new Error('Fixture presentation container unavailable') }
  } else if (pathname === '/partition-deny') {
    const create = page.presentation.createElement.bind(page.presentation)
    page.presentation.createElement = (reservation) => {
      const element = create(reservation)
      element.setAttribute('partition', 'fixture-invalid-partition')
      return element
    }
  }
  page.frame.subscribe(() => {
    const state = page.frame.getSnapshot()
    status.textContent = state.error?.description ?? state.automation?.failure?.message ?? state.automation?.status ?? ''
    fixture.state(request.lease, state)
  })
  page.presentation.mount(container.id)
  page.frame.loadUrl({ kind: 'http', url: request.url, title: 'Owned fixture form' })
})
fixture.ready()
