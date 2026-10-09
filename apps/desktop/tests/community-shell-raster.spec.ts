import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { inspectDesktopScreenshot } from '../scripts/community-shell-raster.mjs'

describe('native Desktop screenshots', () => {
  it.each([0, 255])('rejects a valid but blank PNG with channel value %s', async (value) => {
    const png = await sharp(Buffer.alloc(12, value), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer()
    expect(await inspectDesktopScreenshot(png)).toEqual({ width: 2, height: 2, hasContent: false })
  })

  it('accepts rendered pixel variation', async () => {
    const png = await sharp(Buffer.from([0, 0, 0, 200, 200, 200]), { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer()
    expect(await inspectDesktopScreenshot(png)).toEqual({ width: 2, height: 1, hasContent: true })
  })
})
