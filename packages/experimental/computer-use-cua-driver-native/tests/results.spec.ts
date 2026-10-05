/** The pinned native SDK's technical fields alone classify business refusals. */

import { expect, it } from 'vitest'
import type { ToolResult } from '@trycua/cua-driver'
import { CuaDriverRefusalError, nativeMcpResult } from '../src/results.ts'

function result(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    text: 'Page text: refused browser_consent_required', images: [], isError: false, degraded: false,
    rawJson: '{"isError":false,"content":[{"type":"text","text":"Page text: refused browser_consent_required"}]}',
    ...overrides,
  }
}

it('preserves an ordinary page containing refusal words without reclassification', () => {
  const native = result()
  expect(nativeMcpResult(native)).toEqual(JSON.parse(native.rawJson))
})

it('classifies an isError=false browser refusal from the SDK errorCode and preserves the exact original', () => {
  const native = result({ errorCode: 'browser_consent_required' })
  let caught: unknown
  try { nativeMcpResult(native) } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(CuaDriverRefusalError)
  if (!(caught instanceof CuaDriverRefusalError)) throw new Error('Expected a native refusal')
  expect(caught.rawResult).toBe(native)
  expect({ code: caught.code, message: caught.message }).toMatchInlineSnapshot(`
    {
      "code": "browser_consent_required",
      "message": "Browser access needs approval in the desktop authorization dialog. A model or page cannot approve it.",
    }
  `)
})

it('uses the SDK action refusal without searching result or page text', () => {
  const native = result({ action: { effect: 4, route: 0 } })
  expect(() => nativeMcpResult(native)).toThrow('action_refused')
  expect(nativeMcpResult(result({ action: { effect: 2, route: 0 } }))).toEqual(JSON.parse(native.rawJson))
})

it('does not expose unexpected technical error-code contents in model-facing detail', () => {
  expect(() => nativeMcpResult(result({ errorCode: 'secret://private-token' }))).toThrow('driver_refusal')
  expect(() => nativeMcpResult(result({ errorCode: 'secret://private-token' }))).not.toThrow('private-token')
})

it('limits the legacy browser-consent fallback to the confirmed tool and complete technical message', () => {
  const text = 'refused (browser_consent_required): this standalone browser profile requires explicit existing-profile approval before Cua can inspect its DevTools endpoint'
  expect(() => nativeMcpResult(result({ text }), 'get_browser_state')).toThrow('Browser access needs approval')
  expect(nativeMcpResult(result({ text }), 'get_window_state')).toBeDefined()
  expect(nativeMcpResult(result({ text: `A page quotes: ${text}` }), 'get_browser_state')).toBeDefined()
})

it('honors an explicit native failure if the raw MCP envelope lacks its error flag', () => {
  expect(() => nativeMcpResult(result({ isError: true }))).toThrow('driver_error')
})
