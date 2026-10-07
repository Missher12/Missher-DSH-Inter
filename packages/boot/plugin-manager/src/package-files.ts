/** Read installed package files without executing them, including local packages whose manifest stayed unchanged. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Fingerprint a directly installed package's files and symlink destinations.
 * The package root is resolved once; internal links are recorded without traversing other packages.
 * @param root Installed package directory, possibly a pnpm symlink.
 * @param signal Bounds the traversal before any package operation begins.
 * @param followLinks Also bind reachable linked dependency contents, visiting each resolved target once.
 * @param logicalRoot Original logical root while verifying a directory moved intact to backup.
 * @returns File digest, or undefined when the package root does not exist.
 */
export async function packageFiles(
  root: string, signal: AbortSignal, followLinks = false, logicalRoot?: string,
): Promise<string | undefined> {
  let directory: string
  try { directory = await realpath(root) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const hash = createHash('sha256')
  const visited = new Set<string>([directory])
  const logical = logicalRoot === undefined ? directory : resolve(logicalRoot)
  const physicalTarget = (path: string): string => {
    const rel = relative(logical, path)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ? join(directory, rel) : path
  }
  const walk = async (dir: string, prefix: string, logicalDir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      signal.throwIfAborted()
      const path = join(dir, name)
      const stat = await lstat(path)
      hash.update(JSON.stringify([prefix + name, stat.mode, stat.isFile() ? stat.size : null]))
      if (stat.isSymbolicLink()) {
        const link = await readlink(path)
        hash.update(JSON.stringify(['link', link]))
        if (followLinks) {
          const logicalTarget = resolve(logicalDir, link)
          const target = await realpath(physicalTarget(logicalTarget))
          if (!visited.has(target)) {
            visited.add(target)
            const targetStat = await lstat(target)
            if (targetStat.isDirectory()) await walk(target, prefix + name + '/', logicalTarget)
            else if (targetStat.isFile()) hash.update(await readFile(target, { signal }))
          }
        }
      }
      else if (stat.isDirectory()) await walk(path, prefix + name + '/', join(logicalDir, name))
      else if (stat.isFile()) hash.update(await readFile(path, { signal }))
      else throw new Error(`Unsupported installed package member: ${path}`)
    }
  }
  await walk(directory, '', logical)
  signal.throwIfAborted()
  return hash.digest('hex')
}
