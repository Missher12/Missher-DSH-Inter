/** Legacy Linux entry; the same renderer check also runs natively on Windows. */
if (process.platform !== 'linux') throw new Error('Linux shell smoke requires Linux')
await import('./smoke-community-shell.mjs')
