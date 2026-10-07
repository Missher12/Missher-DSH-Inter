/** Validate Host IPC before any Desktop browser operation is admitted. */
import type { BrowserActivationId, BrowserOwner, BrowserSnapshotId, BrowserTargetId, DesktopBrowserRequest } from '@deepseek-ai/dsh-browser-use/desktop'
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid browser request')
  return value as Record<string, unknown>
}
const text = (value: unknown, max = 4096): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new Error('Invalid browser request text')
  return value
}
const urlText = (value: unknown, action: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 8192 || value.includes('\0')) {
    throw Object.assign(new Error(`Browser ${action} requires a non-empty url (up to 8192 characters).`), { code: 'browser-invalid-url' })
  }
  return value
}
/** @param value - untrusted IPC JSON. @returns finite operation and bounded caller identity. */
export function parseBrowserRequest(value: unknown): DesktopBrowserRequest {
  const input = object(value), who = object(input.owner), op = object(input.operation)
  const owner: BrowserOwner = { sessionId: text(who.sessionId, 256), activationId: text(who.activationId, 256) as BrowserActivationId }
  const action = text(op.action, 32)
  if (action === 'open') return { owner, operation: { action, url: urlText(op.url, action) } }
  if (action === 'list' || action === 'release') return { owner, operation: { action } }
  const target = text(op.target, 256) as BrowserTargetId
  if (action === 'observe' || action === 'screenshot' || action === 'close') return { owner, operation: { action, target } }
  if (action === 'navigate') return { owner, operation: { action, target, url: urlText(op.url, action) } }
  if (action === 'wait') {
    if (!Number.isSafeInteger(op.timeoutMs) || Number(op.timeoutMs) < 1 || Number(op.timeoutMs) > 30_000) throw new Error('Invalid browser wait timeout')
    return { owner, operation: { action, target, text: text(op.text, 4096), timeoutMs: Number(op.timeoutMs) } }
  }
  const snapshot = text(op.snapshot, 256) as BrowserSnapshotId
  if (action === 'click' || action === 'upload') return { owner, operation: { action, target, snapshot, element: text(op.element, 128) } }
  if (action === 'fill') {
    if (typeof op.text !== 'string' || op.text.length > 32_768) throw new Error('Invalid browser input text')
    return { owner, operation: { action, target, snapshot, element: text(op.element, 128), text: op.text } }
  }
  if (action === 'press') return { owner, operation: { action, target, snapshot, key: text(op.key, 32) } }
  if (action === 'scroll') {
    if (!Number.isFinite(op.delta) || Math.abs(Number(op.delta)) > 10000) throw new Error('Invalid browser scroll distance')
    return { owner, operation: { action, target, snapshot, delta: Number(op.delta) } }
  }
  throw new Error('Unsupported browser operation')
}
