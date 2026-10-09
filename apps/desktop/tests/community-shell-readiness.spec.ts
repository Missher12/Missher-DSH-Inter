import { describe, expect, it } from 'vitest'
import { isDesktopUiReady } from '../scripts/community-shell-readiness.mjs'

describe('community Desktop renderer acceptance', () => {
  const mounted = { ready: 'complete', boot: false, controls: 4, width: 1280, height: 820, text: 'New conversation\nSettings\nPlugins' }

  it('accepts the mounted application with usable controls', () => {
    expect(isDesktopUiReady(mounted)).toBe(true)
  })

  it('rejects the nonempty loading screenshot previously accepted by CI', () => {
    expect(isDesktopUiReady({ ...mounted, boot: true, controls: 0, text: 'HARNESS\nLoading plugins…' })).toBe(false)
  })

  it('rejects an error page even when it offers a retry button', () => {
    expect(isDesktopUiReady({ ...mounted, text: 'Failed to load plugins\nRetry' })).toBe(false)
  })

  it('rejects incomplete, empty and noninteractive documents', () => {
    expect(isDesktopUiReady(undefined)).toBe(false)
    expect(isDesktopUiReady({ ...mounted, ready: 'loading' })).toBe(false)
    expect(isDesktopUiReady({ ...mounted, controls: 0 })).toBe(false)
    expect(isDesktopUiReady({ ...mounted, text: '' })).toBe(false)
  })
})
