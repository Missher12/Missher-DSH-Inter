/** Lease-scoped browser operations and one main-process event subscription per window. */
import { ipcRenderer } from 'electron'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopBrowserModelOpen } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopBrowserState } from '@deepseek-ai/dsh-browser-use/desktop'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns browser operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserBridge(): DesktopBrowserBridge {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>()
  ipcRenderer.on(DESKTOP_IPC.browserOpenRequested, (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || typeof request.url !== 'string') return
    const callbacks = listeners.get(request.lease as DesktopBrowserLeaseId)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try { callback(request.url) }
      catch (error) { console.error('Desktop browser link handler failed', error) }
    }
  })
  return {
    automationVersion: 1,
    claim: lease => ipcRenderer.invoke(DESKTOP_IPC.browserClaim, lease) as Promise<import('@deepseek-ai/dsh-client-ui-sidebar-browser/types').DesktopBrowserReservation>,
    state: lease => ipcRenderer.invoke(DESKTOP_IPC.browserState, lease) as Promise<DesktopBrowserState | undefined>,
    control: (lease, action) => ipcRenderer.invoke(DESKTOP_IPC.browserControl, lease, action) as Promise<void>,
    onModelOpen(listener) {
      const receive = (_event: Electron.IpcRendererEvent, request: DesktopBrowserModelOpen): void => { listener(request) }
      ipcRenderer.on(DESKTOP_IPC.browserModelOpen, receive)
      return () => { ipcRenderer.off(DESKTOP_IPC.browserModelOpen, receive) }
    },
    onState(listener) {
      const receive = (_event: Electron.IpcRendererEvent, state: DesktopBrowserState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.browserState, receive)
      return () => { ipcRenderer.off(DESKTOP_IPC.browserState, receive) }
    },
    acquire: workspace => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace) as ReturnType<DesktopBrowserBridge['acquire']>,
    release: lease => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease) as Promise<void>,
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}
