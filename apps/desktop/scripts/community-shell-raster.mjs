/** Reject uniform screenshots from noninteractive Windows display surfaces. */
import sharp from 'sharp'

export async function inspectDesktopScreenshot(png) {
  const metadata = await sharp(png).metadata()
  const statistics = await sharp(png).stats()
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    hasContent: metadata.format === 'png' && statistics.channels.slice(0, 3).some(channel => channel.max > channel.min),
  }
}
