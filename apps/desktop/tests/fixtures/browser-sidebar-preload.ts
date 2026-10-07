/** Private native fixture transport; product browser IPC remains unchanged. */
import { contextBridge, ipcRenderer } from 'electron'
import { createDesktopBrowserBridge } from '../../src/preload-browser.ts'

contextBridge.exposeInMainWorld('sidebarFixture', {
  browser: createDesktopBrowserBridge(),
  ready: () => { ipcRenderer.send('fixture:ready') },
  state: (lease: string, value: object) => { ipcRenderer.send('fixture:state', lease, value) },
})
