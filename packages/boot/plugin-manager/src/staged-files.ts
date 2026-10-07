/** Prepare a relocatable dependency graph without installing into the running profile. */
import { cp, lstat, mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse, stringify } from 'yaml'
import { UPDATE_BASE_FILES } from './pending-update.ts'

type PackageJson = Record<string, unknown> & {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}
const groups = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Create only manager-owned real directories, checking each parent before creating a child.
 * @param profile Canonical profile directory.
 * @param branch One fixed manager-owned directory name.
 * @returns The checked preparation parent.
 */
export async function ensurePreparationDirectory(profile: string, branch: 'updates' | 'install-sources'): Promise<string> {
  let path = profile
  for (const name of ['.plugin-manager', branch]) {
    path = join(path, name)
    let stat
    try { stat = await lstat(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(path, { mode: 0o700 })
      stat = await lstat(path)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The package preparation path must contain only real directories')
  }
  return path
}

/** Resolve a saved local dependency at the original manifest, retaining its source kind. */
function anchored(value: string, base: string): string {
  const match = /^(file|link):(.+)$/.exec(value)
  const protocol = match?.[1]
  const source = match?.[2]
  if (protocol === undefined || source === undefined || isAbsolute(source)) return value
  return `${protocol}:${resolve(base, source)}`
}

/** Translate lockfile local references as well as importer specs to the original source directory. */
function anchorLock(value: unknown, base: string, field?: string): unknown {
  if (typeof value === 'string') {
    if (field === 'directory' && !isAbsolute(value)) return resolve(base, value)
    const at = value.indexOf('file:')
    const link = value.indexOf('link:')
    const start = at >= 0 ? at : link
    if (start < 0) return value
    const tail = value.slice(start)
    const peer = tail.indexOf('(')
    const source = peer < 0 ? tail : tail.slice(0, peer)
    return value.slice(0, start) + anchored(source, base) + (peer < 0 ? '' : tail.slice(peer))
  }
  if (Array.isArray(value)) return value.map(item => anchorLock(item, base))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(anchorLock(key, base)), anchorLock(item, base, key)]))
  }
  return value
}

async function walkLinks(root: string, visit: (path: string, target: string) => string, signal: AbortSignal): Promise<void> {
  try { await lstat(root) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      signal.throwIfAborted()
      const path = join(dir, name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) {
        const target = await readlink(path)
        const next = visit(path, target)
        if (next !== target) { await unlink(path); await symlink(next, path) }
      } else if (stat.isDirectory()) await walk(path)
    }
  }
  await walk(root)
}

/** Copy bound profile files and the installed graph, then anchor local sources at the original profile.
 * @param profile Canonical original profile directory.
 * @param candidate Newly created isolated profile directory.
 * @param signal Cancellation and preparation deadline.
 * @returns After candidate file and link preparation completes.
 */
export async function copyUpdateCandidate(profile: string, candidate: string, signal: AbortSignal): Promise<void> {
  await mkdir(candidate, { recursive: false, mode: 0o700 })
  for (const file of UPDATE_BASE_FILES) {
    signal.throwIfAborted()
    try { await writeFile(join(candidate, file), await readFile(join(profile, file), { signal }), { mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) as PackageJson
  for (const group of groups) {
    const entries = manifest[group]
    if (entries !== undefined) {
      manifest[group] = Object.fromEntries(Object.entries(entries).map(([name, spec]) => [name, anchored(spec, profile)]))
    }
  }
  await writeFile(join(candidate, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  try {
    const lock = parse(await readFile(join(candidate, 'pnpm-lock.yaml'), 'utf8')) as unknown
    await writeFile(join(candidate, 'pnpm-lock.yaml'), stringify(anchorLock(lock, profile)), { mode: 0o600 })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const originalModules = join(profile, 'node_modules')
  const candidateModules = join(candidate, 'node_modules')
  let hasModules = true
  try {
    const stat = await lstat(originalModules)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The original node_modules must be a real directory before staging an update')
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') hasModules = false; else throw error }
  if (hasModules) {
    await cp(originalModules, candidateModules, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
      filter: () => { signal.throwIfAborted(); return true } })
  }
  await walkLinks(candidateModules, (path, target) => {
    const originalPath = join(originalModules, relative(candidateModules, path))
    const resolved = resolve(dirname(originalPath), target)
    return within(originalModules, resolved)
      ? relative(dirname(path), join(candidateModules, relative(originalModules, resolved)))
      : resolved
  }, signal)
  if (hasModules) await rewriteManagerPaths(candidateModules, profile, candidate, signal)
}

/** Preserve original non-target saved specs while keeping the lock's now-absolute local package resolutions valid.
 * @param profile Canonical original profile directory.
 * @param candidate Prepared candidate directory.
 * @param target Updated direct dependency.
 * @param signal Cancellation and preparation deadline.
 * @returns After manifest, importer specifiers and package-manager link metadata become relocatable.
 */
export async function finalizeUpdateCandidate(profile: string, candidate: string, target: string, signal: AbortSignal): Promise<void> {
  const original = JSON.parse(await readFile(join(profile, 'package.json'), { encoding: 'utf8', signal })) as PackageJson
  const prepared = JSON.parse(await readFile(join(candidate, 'package.json'), { encoding: 'utf8', signal })) as PackageJson
  const savedSpec = prepared.dependencies?.[target]
  if (savedSpec === undefined) throw new Error('The prepared graph does not contain its target dependency')
  for (const group of groups) {
    const before = Object.entries(original[group] ?? {}).filter(([name]) => name !== target)
    const after = Object.entries(prepared[group] ?? {}).filter(([name]) => name !== target)
    if (before.length !== after.length || before.some(([name, spec]) => anchored(spec, profile) !== anchored(prepared[group]?.[name] ?? '', candidate))) {
      throw new Error('The prepared graph changed another direct dependency')
    }
  }
  const nextSpec = anchored(savedSpec, candidate)
  const manifest: PackageJson = { ...original, dependencies: { ...original.dependencies, [target]: nextSpec } }
  await writeFile(join(candidate, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, signal })
  const lockPath = join(candidate, 'pnpm-lock.yaml')
  const lock = anchorLock(parse(await readFile(lockPath, { encoding: 'utf8', signal })), candidate) as { importers?: Record<string, Record<string, Record<string, { specifier?: string }>>> }
  const importer = lock.importers?.['.']
  if (importer === undefined) throw new Error('The candidate lockfile has no root importer')
  for (const group of groups) {
    for (const [name, spec] of Object.entries(manifest[group] ?? {})) {
      const record = importer[group]?.[name]
      if (record === undefined) throw new Error(`The candidate lockfile omits ${name}`)
      record.specifier = spec
    }
  }
  await writeFile(lockPath, stringify(lock), { mode: 0o600, signal })
  const modules = join(candidate, 'node_modules')
  await walkLinks(modules, (path, targetPath) => {
    const resolved = resolve(dirname(path), targetPath)
    if (within(candidate, resolved) && !within(modules, resolved)) throw new Error(`Candidate dependency links outside the movable node_modules graph: ${path}`)
    return within(modules, resolved) ? relative(dirname(path), resolved) : resolved
  }, signal)
  await rewriteManagerPaths(modules, candidate, profile, signal)
}

/** Rewrite only pnpm-generated layout metadata and text shims, never package source. */
async function rewriteManagerPaths(modules: string, from: string, to: string, signal: AbortSignal): Promise<void> {
  // pnpm's shims and layout metadata can include their creation path; package source files are never rewritten.
  const metadata = join(modules, '.modules.yaml')
  try {
    const content = await readFile(metadata, { encoding: 'utf8', signal })
    await writeFile(metadata, content.replaceAll(from, to), { signal })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const rewriteBins = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      signal.throwIfAborted()
      const path = join(dir, name)
      const stat = await lstat(path)
      if (stat.isDirectory()) await rewriteBins(path)
      else if (stat.isFile() && dirname(path).endsWith(`${sep}.bin`)) {
        const bytes = await readFile(path, { signal })
        if (bytes.includes(0)) continue
        const content = bytes.toString('utf8')
        if (content.includes(from)) await writeFile(path, content.replaceAll(from, to), { signal })
      }
    }
  }
  await rewriteBins(modules)
}
