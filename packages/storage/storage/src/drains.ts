/**
 * Consumer work that must settle before a storage owner closes its handles.
 * @module @deepseek-ai/dsh-storage/src/drains
 */

import { StorageError } from './error.ts'

/** Shares each consumer's cleanup across concurrent consumer and storage disposal. */
export class StorageDrains {
  private readonly consumers = new Set<() => Promise<void>>()
  private closing: Promise<void> | undefined

  /**
   * Register bounded cleanup that stops work and persists its final writes.
   * Registration after shutdown starts throws `closed`. The returned effect
   * disposer runs cleanup once and removes it only after settlement.
   * @param drain - Cleanup that must not await its owning storage's close.
   * @returns an idempotent asynchronous consumer disposer.
   */
  register(drain: () => Promise<void>): () => Promise<void> {
    if (this.closing !== undefined) throw new StorageError('closed', 'storage consumer drain has started')
    let pending: Promise<void> | undefined
    const finish = (): Promise<void> => {
      pending ??= Promise.resolve().then(drain).finally(() => { this.consumers.delete(finish) })
      return pending
    }
    this.consumers.add(finish)
    return finish
  }

  /**
   * Stop registration and await all registered cleanup, including cleanup
   * already started by a consumer disposer. Failures do not skip other drains.
   * @returns the shared completion; rejects with all consumer failures after settlement.
   */
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.consumers].map(finish => finish()))
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length !== 0) throw new AggregateError(failures, 'storage consumer cleanup failed')
    })
    return this.closing
  }
}
