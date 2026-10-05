/** Trusted request lifecycle prevents cancelled or revoked approvals becoming authority. */
import { describe, it, expect, vi } from 'vitest'
import { DesktopComputerAuthorization } from '../src/computer-authorization.ts'
import { parseBrowserRequest } from '../src/browser-request.ts'
const request = () => ({ requestId: 'one', sessionId: 'session', activationId: 'activation', requestDigest: 'digest', summary: 'Test browser profile', resourceJson: '{}', expiresAt: Date.now() + 5000 })
describe('trusted computer authorization', () => {
  it('accepts exactly one live decision and refuses reuse and malformed requests', async () => {
    const prompt = vi.fn(async () => true)
    const auth = new DesktopComputerAuthorization(prompt)
    expect(await auth.request(request(), new AbortController().signal)).toBe('allow')
    expect(await auth.request(request(), new AbortController().signal)).toBe('cancel')
    expect(await auth.request({ ...request(), requestId: 'two', requestDigest: undefined }, new AbortController().signal)).toBe('deny')
    expect(prompt).toHaveBeenCalledTimes(1)
  })
  it.each(['cancel', 'revoke', 'dispose', 'expire'] as const)('rejects late approval after %s', async (kind) => {
    let finish!: (allow: boolean) => void
    const auth = new DesktopComputerAuthorization(() => new Promise((resolve) => { finish = resolve }))
    const signal = new AbortController(), value = request()
    const pending = auth.request(value, signal.signal)
    if (kind === 'cancel') signal.abort()
    if (kind === 'revoke') auth.revoke('activation')
    if (kind === 'dispose') auth.dispose()
    if (kind === 'expire') value.expiresAt = Date.now() - 1
    finish(true)
    expect(await pending).toBe('cancel')
  })
  it('keeps a negative trusted choice negative', async () => {
    expect(await new DesktopComputerAuthorization(async () => false).request(request(), new AbortController().signal)).toBe('deny')
  })
})
describe('browser wire validation', () => {
  const owner = { sessionId: 's', activationId: 'a' }
  it('refuses arbitrary debugger methods, missing snapshots and out-of-range inputs', () => {
    for (const operation of [
      { action: 'Runtime.evaluate', target: '1' }, { action: 'click', target: 't', element: 'e1' },
      { action: 'wait', target: 't', text: 'hello', timeoutMs: 999999 },
      { action: 'scroll', target: 't', snapshot: 's', delta: Infinity },
    ]) expect(() => parseBrowserRequest({ owner, operation })).toThrow()
  })
  it('projects only finite operation fields and keeps identity separate', () => {
    expect(parseBrowserRequest({ owner, operation: { action: 'open', url: 'https://example.test/', webContentsId: 1 } })).toEqual({ owner, operation: { action: 'open', url: 'https://example.test/' } })
  })
})
