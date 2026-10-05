/** External native SDK fixture usable by Vitest and test-only Node module hooks. */

import type { ConfiguredDriverOptions, DriverAuthorizationHost, ToolResult, TrustedSessionOptions } from '@trycua/cua-driver'

/** Pinned SDK enum values; the fixture never loads native code. */
export const SessionPermissionMode = { Standard: 0 }
/** Pinned SDK decision values. */
export const DriverAuthorizationAction = { Allow: 0, Deny: 1, Cancel: 2 }

/** A valid one-pixel PNG keeps image admission on the real attachment path. */
export const screenshotBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'

/** Fixture-native tool inventory, using the upstream catalog fields. */
export const catalog = {
  schema_version: '1',
  capability_version: '1',
  tools: [
    {
      name: 'get_window_state',
      description: 'Capture a Cua Driver window screenshot.',
      inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, window_id: { type: 'integer' } }, required: ['pid', 'window_id'] },
      outputSchema: { type: 'object', properties: { window_id: { type: 'integer' }, clicked: { type: 'boolean' } }, required: ['window_id', 'clicked'] },
    },
    {
      name: 'click',
      description: 'Click the selected Cua Driver window.',
      inputSchema: {
        type: 'object', properties: {
          pid: { type: 'integer' }, window_id: { type: 'integer' }, element_token: { type: 'string' },
          target: { type: 'object', properties: { kind: { const: 'window' }, pid: { type: 'integer' }, window_id: { type: 'integer' } }, required: ['kind', 'pid', 'window_id'] },
        },
      },
    },
    {
      name: 'check_permissions',
      description: 'Read host desktop permissions without prompting.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}

/** Mutable controls represent only the external native implementation. */
export const fixture: {
  creates: number
  destroys: number
  shutdowns: number
  clicked: boolean
  closes: number
  sessions: string[]
  authorizationHost?: DriverAuthorizationHost
  nativeResult?: Partial<ToolResult>
  calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }>
  createError?: Error
  list?: (signal?: AbortSignal) => Promise<string>
  call?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  shutdown?: () => Promise<void>
} = { creates: 0, destroys: 0, shutdowns: 0, closes: 0, clicked: false, calls: [], sessions: [] }

/** Reset the external fixture between independently owned test contexts. */
export function resetFixture(): void {
  fixture.creates = 0
  fixture.destroys = 0
  fixture.shutdowns = 0
  fixture.clicked = false
  fixture.closes = 0
  fixture.sessions = []
  fixture.calls = []
  delete fixture.createError
  delete fixture.list
  delete fixture.call
  delete fixture.shutdown
  delete fixture.authorizationHost
  delete fixture.nativeResult
}

/** The subset of the published SDK exercised by the provider. */
export class CuaDriver {
  static create(): CuaDriver {
    fixture.creates += 1
    if (fixture.createError) throw fixture.createError
    return new CuaDriver()
  }

  static createConfiguredWithAuthorizationHost(_options: ConfiguredDriverOptions, host: DriverAuthorizationHost): CuaDriver {
    fixture.authorizationHost = host
    return CuaDriver.create()
  }

  async listToolsJson(options?: { signal: AbortSignal }): Promise<string> {
    return fixture.list ? fixture.list(options?.signal) : JSON.stringify(catalog)
  }

  async callTool(name: string, argsJson: string, options?: { signal: AbortSignal }): Promise<ToolResult> {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    fixture.calls.push({ name, args, ...options ? { signal: options.signal } : {} })
    if (fixture.call) return nativeResult(await fixture.call(name, args, options?.signal))
    if (name === 'get_window_state') {
      return nativeResult({
        content: [
          { type: 'text', text: 'Cua Driver fixture window.' },
          { type: 'image', mimeType: 'image/png', data: screenshotBase64 },
        ],
        structuredContent: { window_id: 7, clicked: fixture.clicked },
      })
    }
    if (name === 'click') fixture.clicked = true
    return nativeResult({ content: [{ type: 'text', text: name === 'click' ? 'Cua Driver fixture clicked.' : 'Desktop permissions granted.' }] })
  }

  async shutdown(): Promise<void> {
    fixture.shutdowns += 1
    await fixture.shutdown?.()
  }

  uniffiDestroy(): void {
    fixture.destroys += 1
  }
}

function nativeResult(raw: unknown): ToolResult {
  return { text: '', images: [], isError: typeof raw === 'object' && raw !== null && 'isError' in raw && raw.isError === true, degraded: false, rawJson: JSON.stringify(raw), ...fixture.nativeResult }
}

/** One fixture-native authority, closed independently from the shared runtime. */
export function createTrustedSession(driver: CuaDriver, options: TrustedSessionOptions) {
  fixture.sessions.push(options.publicSession)
  let closed = false
  return {
    callTool(name: string, args: string, asyncOptions?: { signal: AbortSignal }) {
      if (closed) throw new Error('Closed native authority')
      return driver.callTool(name, args, asyncOptions)
    },
    close() {
      if (!closed) fixture.closes += 1
      closed = true
    },
  }
}
