/** Trusted reservation IPC remains available before a native guest is attached. */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserAutomation } from './browser-automation.ts'
import type { DesktopBrowserGuests } from './browser-guests.ts'
import { DESKTOP_IPC } from './ipc.ts'

/**
 * @param ipc - Desktop main IPC registry.
 * @param assertSender - authenticated primary product frame check.
 * @param guests - reservation and native guest owner.
 * @param automation - current Host generation, resolved for each request.
 */
export function installBrowserReservationIpc(ipc: Pick<IpcMain, 'handle'>,
  assertSender: (event: IpcMainInvokeEvent) => void, guests: DesktopBrowserGuests, automation: () => DesktopBrowserAutomation): void {
  ipc.handle(DESKTOP_IPC.browserClaim, (event, lease: unknown) => {
    assertSender(event)
    return guests.claim(event.sender, lease)
  })
  ipc.handle(DESKTOP_IPC.browserState, (event, lease: unknown) => {
    assertSender(event)
    return automation().state(guests.assertOwned(event.sender, lease))
  })
  ipc.handle(DESKTOP_IPC.browserFailure, (event, lease: unknown, failure: unknown) => {
    assertSender(event)
    const owned = guests.assertOwned(event.sender, lease)
    if (typeof failure !== 'object' || failure === null || !('code' in failure) || !('message' in failure)
      || failure.code !== 'browser-client-initialization-failed' || typeof failure.message !== 'string'
      || failure.message.length === 0 || failure.message.length > 500 || /[\u0000-\u001f\u007f]/u.test(failure.message)) {
      throw new Error('Invalid browser initialization failure')
    }
    automation().failed(owned, { code: failure.code, message: failure.message })
  })
  ipc.handle(DESKTOP_IPC.browserAcquire, (event, workspace: unknown) => {
    assertSender(event)
    return guests.acquire(event.sender, workspace)
  })
  ipc.handle(DESKTOP_IPC.browserRelease, (event, lease: unknown) => {
    assertSender(event)
    return guests.release(event.sender, lease)
  })
}
