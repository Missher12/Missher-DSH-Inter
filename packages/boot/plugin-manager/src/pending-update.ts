/** On-disk staged update contract shared by preparation and the pre-Host Desktop consumer. No Cordis runtime is required. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { packageFiles } from './package-files.ts'

/** The sole published descriptor; preparation directories alone never authorize activation. */
export const PENDING_UPDATE_PATH = '.plugin-manager/pending-update.json'
/** Original declarations and configuration whose bytes bind the prepared graph to its base profile. */
export const UPDATE_BASE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml', '.npmrc', 'compatibility.json'] as const
/** The consumer may replace only these files and node_modules. */
export const UPDATE_REPLACEMENT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const

/** Digests bind file presence as well as contents; null means absent. */
export interface UpdateBaseBindings {
  files: Record<typeof UPDATE_BASE_FILES[number], string | null>
  nodeModules: string | null
}
/** The complete staged dependency graph the consumer verifies before moving it into place. */
export interface UpdateCandidateBindings {
  files: Record<typeof UPDATE_REPLACEMENT_FILES[number], string | null>
  nodeModules: string | null
}
/** One fully prepared update, published atomically after validation and before shutdown. */
export interface PendingBundleUpdate {
  schema: 1
  id: string
  profileRealPath: string
  producerPid: number
  target: string
  beforeVersion: string
  nextVersion: string
  baseBindings: UpdateBaseBindings
  candidateRelativePath: string
  candidateBindings: UpdateCandidateBindings
  createdAt: number
}

const digest = z.string().regex(/^[a-f0-9]{64}$/).nullable()
const fileDigests = z.strictObject({ 'package.json': digest, 'pnpm-lock.yaml': digest, 'pnpm-workspace.yaml': digest })
const pendingSchema = z.strictObject({
  schema: z.literal(1), id: z.uuid(), profileRealPath: z.string().min(1),
  producerPid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), target: z.string().min(1),
  beforeVersion: z.string().min(1), nextVersion: z.string().min(1), createdAt: z.number().int().nonnegative(),
  baseBindings: z.strictObject({ files: fileDigests.extend({ 'cordis.patch.yml': digest, 'cordis.yml': digest, '.npmrc': digest, 'compatibility.json': digest }), nodeModules: digest }),
  candidateRelativePath: z.string(), candidateBindings: z.strictObject({ files: fileDigests, nodeModules: digest }),
}).refine(value => value.candidateRelativePath === `.plugin-manager/updates/${value.id}/candidate`, 'candidate path does not match its update id')

/** Parse a strict descriptor; malformed files never become activation authority.
 * @param content Exact JSON descriptor bytes.
 * @returns A schema-1 descriptor restricted to its UUID-owned candidate path.
 */
export function parsePendingBundleUpdate(content: string): PendingBundleUpdate {
  return pendingSchema.parse(JSON.parse(content))
}

/** Read the one published descriptor, without treating malformed content as absence.
 * @param profile Original profile directory.
 * @returns The descriptor, or undefined only when it is absent.
 */
export async function readPendingBundleUpdate(profile: string): Promise<PendingBundleUpdate | undefined> {
  try { return parsePendingBundleUpdate(await readFile(join(profile, PENDING_UPDATE_PATH), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Hash one file without disclosing its contents, including private registry settings.
 * @param path Exact file path.
 * @param signal Cancellation/deadline for the read.
 * @returns SHA-256, or null when absent.
 */
export async function updateFileDigest(path: string, signal: AbortSignal): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(path, { signal })).digest('hex') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Hash a dependency directory with the same algorithm preparation and activation use.
 * @param path Exact node_modules or installed package directory.
 * @param signal Bounds the traversal.
 * @param logicalRoot Original node_modules location while verifying an intact moved backup.
 * @returns SHA-256, or null when absent.
 */
export async function updateDirectoryDigest(path: string, signal: AbortSignal, logicalRoot?: string): Promise<string | null> {
  return await packageFiles(path, signal, true, logicalRoot) ?? null
}

/** Fingerprint the original profile's bound declarations, configuration, and complete node_modules directory.
 * @param profile Original profile directory.
 * @param signal Bounds the reads and tree traversal.
 * @returns The base binding recorded before preparation.
 */
export async function readUpdateBaseBindings(profile: string, signal: AbortSignal): Promise<UpdateBaseBindings> {
  const files = {} as UpdateBaseBindings['files']
  for (const file of UPDATE_BASE_FILES) files[file] = await updateFileDigest(join(profile, file), signal)
  return { files, nodeModules: await updateDirectoryDigest(join(profile, 'node_modules'), signal) }
}

/** Fingerprint exactly the paths the pre-Host consumer may activate.
 * @param candidate Fully prepared candidate profile.
 * @param signal Bounds the reads and tree traversal.
 * @returns The candidate binding published with the descriptor.
 */
export async function readUpdateCandidateBindings(candidate: string, signal: AbortSignal): Promise<UpdateCandidateBindings> {
  const files = {} as UpdateCandidateBindings['files']
  for (const file of UPDATE_REPLACEMENT_FILES) files[file] = await updateFileDigest(join(candidate, file), signal)
  return { files, nodeModules: await updateDirectoryDigest(join(candidate, 'node_modules'), signal) }
}
