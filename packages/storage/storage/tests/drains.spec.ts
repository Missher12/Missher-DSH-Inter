import { describe, expect, it, vi } from 'vitest'
import { StorageDrains } from '../src/index.ts'

describe('storage consumer cleanup', () => {
  it('shares consumer cleanup with concurrent shutdown and rejects late registration', async () => {
    const drains = new StorageDrains()
    const held = Promise.withResolvers<undefined>()
    const cleanup = vi.fn(() => held.promise)
    const dispose = drains.register(cleanup)
    const consumer = dispose()
    const close = drains.close()
    expect(drains.close()).toBe(close)
    expect(dispose()).toBe(consumer)
    expect(() => drains.register(async () => {})).toThrow(expect.objectContaining({ code: 'closed' }))
    let finished = false
    void close.then(() => { finished = true })
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    held.resolve(undefined)
    await Promise.all([close, consumer])
    await dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('waits for other cleanup before reporting a failure', async () => {
    const drains = new StorageDrains()
    const held = Promise.withResolvers<undefined>()
    drains.register(async () => { throw new Error('failed consumer') })
    drains.register(() => held.promise)
    const close = drains.close()
    const rejected = expect(close).rejects.toThrow('storage consumer cleanup failed')
    let settled = false
    void close.catch(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    held.resolve(undefined)
    await rejected
  })
})
