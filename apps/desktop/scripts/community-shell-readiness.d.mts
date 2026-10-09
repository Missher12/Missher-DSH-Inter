export interface DesktopDocumentState {
  ready: string
  boot: boolean
  controls: number
  width: number
  height: number
  text: string
}
export function isDesktopUiReady(document: DesktopDocumentState | undefined): boolean
