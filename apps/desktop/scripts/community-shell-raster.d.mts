export function inspectDesktopScreenshot(png: Buffer): Promise<{
  width: number
  height: number
  hasContent: boolean
}>
