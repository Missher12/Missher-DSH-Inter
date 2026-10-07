/** Current-profile plugin and bundle management over shared dsh plugin operations. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import { gt, valid, validRange } from 'semver'
import { parse } from 'yaml'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { pluginEntryId, readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import {
  readPluginMeta, readProfileManifest, resolveBundleDir, loadOverlayPatches, composeEntries,
  reconcileProfilePatches, readProfilePatches, OPTIONAL_BUNDLES, bundlePatchPaths,
  evaluatePluginCompatibility, readProfileCompatibility, readProfileVersionExemptions,
  setProfileVersionExemption, PROFILE_COMPATIBILITY_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-hmr'
import type { ProfileContext, ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { activeProfilePackageRun, anchorPathSpec, bundleManifest, readProfileRegistry, registryArguments, runProfilePnpm, saveManifest, viewProfilePackage } from './operations.ts'
import { classifyInstallFailure } from './install-failure.ts'
import { InvalidInstallSpecError, parseInstallSpec, type ParsedInstallSpec } from './install-spec.ts'
import { attributeFailure, normalizeRegistry, NPMMIRROR_REGISTRY, registryPlan } from './registry.ts'
import { writePluginEnabled } from './patch.ts'
import { incompatiblePlugin, ManagementFailure } from './failure.ts'
import { approveBuilds, readPendingBuilds } from './build-approval.ts'
import { checkGithubConnection } from './github-connection.ts'
import { packageFiles } from './package-files.ts'
import { PENDING_UPDATE_PATH, readPendingBundleUpdate, readUpdateBaseBindings, readUpdateCandidateBindings, type PendingBundleUpdate } from './pending-update.ts'
import { copyUpdateCandidate, ensurePreparationDirectory, finalizeUpdateCandidate } from './staged-files.ts'
import type {
  BundleInfo, BundleRowInfo, BundleUpdateCheck, ChangeResult, InspectOptions, InstallBundleOptions,
  ManagementError, PackageResult, PluginChange,
  PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallProgress, PluginInstallRequestId,
  PluginRegistries, PluginSpecInspection, Registry, UpdateBundleOptions, InstallSpecKind,
} from './types.ts'
export type * from './types.ts'
export { classifyInstallFailure, type InstallFailureFacts } from './install-failure.ts'
export { InvalidInstallSpecError, parseInstallSpec, type ParsedInstallSpec } from './install-spec.ts'

/** The pnpm executable, registries, and limits for diagnostics, lookups and connection checks. */
export interface Config {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. */
  pnpmCommand?: string
  /** Maximum retained package-operation diagnostic bytes. */
  outputBytes?: number
  /** Maximum time to wait for another process's profile package operation. */
  lockWaitMs?: number
  /** Bound on one registry lookup an inspection runs, in milliseconds. */
  inspectTimeoutMs?: number
  /** Maximum duration of the GitHub repository connection check before installation, in milliseconds. */
  githubConnectionTimeoutMs?: number
  /** Maximum time one captured package run may print nothing before the manager terminates it, in milliseconds. */
  idleTimeoutMs?: number
  /** Total time allowed to prepare and validate an isolated update candidate. */
  prepareTimeoutMs?: number
  /** The registry lookups and installations ask first, as an http(s) URL; absent, the one pnpm's own configuration names. */
  registry?: string
  /**
   * Registries asked in turn, as http(s) URLs, while the one before is unreachable or holds no copy of the package.
   * A registry outside this set and `registry` is asked alone, and so is the one pnpm's own configuration names
   * unless that is npm's own registry or one of these.
   */
  fallbackRegistries?: string[]
}

/** An http(s) URL, as pnpm's `--registry` takes it. */
const REGISTRY_URL = /^https?:\/\/\S+$/

const protectedModules = new Set([
  '@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory', '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-host-plugin-inventory', '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-frontend-static', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-hmr',
])

/** The profile files an installation writes and a failed or cancelled one restores. */
const RESTORED_FILES = ['package.json', 'pnpm-lock.yaml'] as const

/** pnpm's colour escapes, which a JSON answer may be wrapped in. */
const ANSI_SEQUENCE = /\x1b\[[0-9;]*m/g

/** Flatten only the groups addressable by the profile's patch composer. */
function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : [])])
}

/** Preserve the exact observed diagnostic, including non-Error failures. */
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** An expected refusal keeps its code; anything else becomes an operation error carrying its exact diagnostic. */
function managementError(error: unknown): ManagementError {
  if (!(error instanceof ManagementFailure)) return { code: 'operation-error', diagnostic: messageOf(error) }
  return { code: error.code, ...error.incompatible === undefined ? {} : { incompatible: error.incompatible },
    ...error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic } }
}

/** The caller stopped an installation; its files are restored before this is thrown. */
class InstallCancelledError extends Error {
  constructor() {
    super('Installation cancelled')
    this.name = 'InstallCancelledError'
  }
}

/** Exact versions only; tags, ranges, prefixes and coercion cannot authorize an update. */
function exactVersion(version: string | undefined): version is string {
  return version !== undefined && /^\d/.test(version) && version.trim() === version && valid(version) !== null
}

/** Classify a saved dependency value without interpreting a local or Git source as a registry tag. */
function dependencySource(spec: string): InstallSpecKind | undefined {
  if (/^(?:file|link):|^\.{1,2}[/\\]|^[/\\]/.test(spec)) return /\.(?:tgz|tar\.gz)(?:#.*)?$/i.test(spec) ? 'tarball' : 'path'
  if (validRange(spec) !== null || /^[a-zA-Z][\w.-]*$/.test(spec)) return 'registry'
  try { return parseInstallSpec(spec).kind } catch (error) {
    if (!(error instanceof InvalidInstallSpecError)) throw error
    return undefined
  }
}

/** Direct fields whose names and saved specs an update must preserve. */
function profileDependencies(manifest: ProfileManifest): Record<string, string> {
  const extra = manifest as ProfileManifest & { devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  return { ...extra.devDependencies, ...manifest.dependencies, ...extra.optionalDependencies }
}

interface UpdateTarget {
  name: string
  currentVersion: string
  spec: string
  enabled: boolean
}

interface InstalledPackage {
  manifest: string | undefined
  files: string | undefined
}

/** One installation the manager owns until its call settles. */
interface InstallControl {
  readonly abort: AbortController
  /** `applying` once pnpm has exited and the bundle is being selected and loaded, which cannot be stopped. */
  phase: 'installing' | 'applying'
  /** The active install's result, shared with clients recovering a lost response. */
  result: Promise<ChangeResult | null>
}

/** A manifest field that is a string, when the manifest carries one. */
function stringField(manifest: object, field: string): string | undefined {
  const value = (manifest as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

/** The fields of the dsh installation's own manifest the manager reads. */
interface InstallationManifest {
  dependencies?: Record<string, string>
}

/** What a package manifest says about the package: identity, one-liner, and whether it is a bundle. */
function inspectionOf(kind: 'registry' | 'path', manifest: object, registry: Registry): Extract<PluginSpecInspection, { status: 'accepted' }> {
  const dsh = (manifest as { dsh?: unknown }).dsh
  const declared = typeof dsh === 'object' && dsh !== null ? dsh as { bundle?: unknown } : undefined
  const bundle = declared !== undefined && typeof declared.bundle === 'object' && declared.bundle !== null
  const name = stringField(manifest, 'name')
  const version = stringField(manifest, 'version')
  const description = stringField(manifest, 'description')
  return {
    status: 'accepted', kind, bundle, registry,
    ...name === undefined ? {} : { name },
    ...version === undefined ? {} : { version },
    ...description === undefined || description === '' ? {} : { description },
  }
}

function refused(problem: PluginInspectProblem, reason: string): PluginSpecInspection {
  return { status: 'refused', problem, reason }
}

/** The refusal `pnpm view --json` prints on stdout, `{ error: { code, message } }`, as one log line; empty for anything else. */
function printedError(printed: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(printed || 'null') }
  catch { return '' /* not JSON: nothing pnpm printed as a refusal */ }
  const error = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined
  if (typeof error !== 'object' || error === null) return ''
  const { code, message } = error as { code?: unknown; message?: unknown }
  return [code, message].filter((part): part is string => typeof part === 'string').join('  ')
}

/** The spec's form, for deciding whether a failed attempt was the registry's; a form the parser refuses has no host of its own. */
function parsedForRegistry(spec: string): ParsedInstallSpec {
  try {
    return parseInstallSpec(spec)
  } catch (error) {
    /* v8 ignore next -- parseInstallSpec throws nothing but its own refusal */
    if (!(error instanceof InvalidInstallSpecError)) throw error
    return { kind: 'registry', spec, name: spec }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent management of the current profile's composition and packages. */
    pluginManager: PluginManager
  }
}

/** Manage profile files and apply their declared reload lifecycle. */
export class PluginManager extends TypertRemoteService {
  static inject = ['loader', 'profileContext']
  static Config: z<Config> = z.object({
    pnpmCommand: z.string().default('pnpm'),
    outputBytes: z.number().step(1).min(1).default(16384),
    lockWaitMs: z.number().step(1).min(0).default(120000),
    inspectTimeoutMs: z.number().step(1).min(1000).default(20000),
    githubConnectionTimeoutMs: z.number().step(1).min(1000).default(5000),
    idleTimeoutMs: z.number().step(1).min(1000).default(600000),
    prepareTimeoutMs: z.number().step(1).min(1000).default(120000),
    registry: z.string().pattern(REGISTRY_URL),
    fallbackRegistries: z.array(z.string().pattern(REGISTRY_URL)).default([NPMMIRROR_REGISTRY]),
  })
  /** Management bundles remain protected if their files become unreadable. */
  private readonly managementBundles = new Set<string>()
  private readonly ownerEntryId: string | undefined
  private readonly packageOperations = new Set<Promise<unknown>>()
  private readonly profile: ProfileContext
  private readonly outputBytes: number
  private readonly lockWaitMs: number
  private readonly inspectTimeoutMs: number
  private readonly githubConnectionTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly prepareTimeoutMs: number
  private readonly pnpmCommand: string
  private readonly configuredRegistries: Omit<PluginRegistries, 'resolved'>
  private readonly ownerContext: Context
  private readonly abort = new AbortController()
  /** Installations by request id, from their call until it settles. */
  private readonly installs = new Map<PluginInstallRequestId, InstallControl>()
  /** Undecided scripts from failed isolated preparations, bound to exact source and unchanged original graph. */
  private readonly stagedBuilds = new Map<string, { base: string; names: string[]; id: string; bindings: PendingBundleUpdate['baseBindings'] }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'pluginManager')
    this.ownerEntryId = ctx.fiber.entry?.id
    this.ownerContext = ctx
    this.profile = ctx.profileContext
    for (const name of this.profile.startedBundles) this.protectsManager(name)
    this.outputBytes = (config as Required<Config>).outputBytes
    this.lockWaitMs = (config as Required<Config>).lockWaitMs
    this.inspectTimeoutMs = (config as Required<Config>).inspectTimeoutMs
    this.githubConnectionTimeoutMs = (config as Required<Config>).githubConnectionTimeoutMs
    this.idleTimeoutMs = (config as Required<Config>).idleTimeoutMs
    this.prepareTimeoutMs = (config as Required<Config>).prepareTimeoutMs
    this.pnpmCommand = (config as Required<Config>).pnpmCommand
    this.configuredRegistries = {
      registry: config.registry === undefined ? null : normalizeRegistry(config.registry),
      fallbackRegistries: (config as Required<Config>).fallbackRegistries.map(normalizeRegistry),
    }
    ctx.effect(() => async () => {
      this.abort.abort()
      await Promise.allSettled([...this.packageOperations])
    }, 'plugin-manager: package cancellation')
  }

  /** Read exact plugin-version exemptions saved in this profile.
   * @returns Accepted package-name@version keys with the runtime versions they may run on, and any
   * record or file problem the reader rejected, which the caller reports instead of failing.
   */
  @Remote
  listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] } {
    const { exemptions, warnings } = readProfileCompatibility(this.profile.dir)
    return { exemptions, warnings }
  }

  /** Grant or revoke one exact plugin/runtime exemption and reevaluate live plugins.
   * @param packageVersion Exact manifest package name followed by @ and its version; never an installation spec or alias.
   * @param runtimeVersion Exact current DSH version for grants; revocation may name a previous runtime.
   * @param enabled Whether to grant rather than revoke the exemption.
   * @param acceptRisk Required true for grants after the user accepts possible crashes and data loss.
   * @returns Saved and runtime outcomes. Startup-only profiles require restart.
   */
  @Remote
  setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      await setProfileVersionExemption(this.profile.dir, packageVersion, runtimeVersion, enabled, acceptRisk === true)
      result.warnings = await this.reload()
    }), { stage: 'enable', target: packageVersion, enabled }, 'bundle')
  }

  /** Read current plugins, including why a row cannot be changed through the profile patch.
   * @returns Current runtime entries with persistent patch targets.
   */
  @Remote
  async listPlugins(): Promise<PluginInfo[]> {
    const rows = flatten(composeEntries([readProfilePatches('dsh', this.profile)]))
    const snapshot = await readPluginInventory(this.ctx)
    return snapshot.entries.map((entry) => {
      const actual = [...this.ctx.loader.entries()].find(row => row.id === entry.entryId)
      const candidates = rows.filter(row => row.id === actual?.options.id)
      const candidate = candidates[0]
      if (protectedModules.has(entry.moduleName) || entry.entryId === this.ownerEntryId) {
        return { ...entry, readOnlyReason: 'management-required' as const }
      }
      if (candidate === undefined || candidates.length > 1 || candidate.name !== entry.moduleName
        || actual?.parent.tree.ctx.fiber.entry?.id !== 'include') {
        return { ...entry, readOnlyReason: 'unaddressable' as const }
      }
      return { ...entry, patchId: candidate.id }
    })
  }

  /** Read the profile's installed bundles, the bundles this dsh installation supplies, and the selected names that are not bundles.
   * A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected.
   * @returns Package versions, manifest descriptions, rows, optional display metadata, activation selections,
   * whether the installation offers the bundle, and removal availability.
   */
  @Remote
  async listBundles(): Promise<BundleInfo[]> {
    const pending = await readPendingBundleUpdate(this.profile.dir)
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const exemptions = readProfileVersionExemptions(this.profile.dir)
    const selected = manifest.dsh?.profile?.bundles ?? []
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest
    const names = [...new Set([...selected, ...dependencies, ...Object.keys(installation.dependencies ?? {})])]
    const bundles: BundleInfo[] = []
    for (const name of names) {
      const installed = dependencies.includes(name)
      const optional = OPTIONAL_BUNDLES.includes(name)
      const removable = installed && !Object.hasOwn(installation.dependencies ?? {}, name)
      const enabled = selected.includes(name)
      const readOnlyReason = this.protectsManager(name) ? 'management-required' as const : undefined
      try {
        const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        if (info === undefined) {
          if (enabled) bundles.push({ name, enabled, installed, optional, removable: removable && readOnlyReason === undefined,
            ...(readOnlyReason === undefined ? {} : { readOnlyReason }), error: { code: 'not-bundle' }, rows: [], overrides: [] })
          continue
        }
        const compatibility = evaluatePluginCompatibility(info, exemptions)
        if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
        const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
        const meta = readPluginMeta(info.name ?? name, pathToFileURL(join(dir, 'package.json')).href)
        bundles.push({ name, ...(info.version === undefined ? {} : { version: info.version }),
          ...(info.description === undefined || info.description === '' ? {} : { description: info.description }),
          ...meta === undefined ? {} : { meta },
          enabled, installed, optional, removable: removable && readOnlyReason === undefined,
          ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
          ...this.declaredRows(name, info) })
      } catch (error) {
        if (enabled || installed) {
          bundles.push({ name, enabled, installed, optional, removable: removable && readOnlyReason === undefined,
            ...(readOnlyReason === undefined ? {} : { readOnlyReason }), error: managementError(error), rows: [], overrides: [] })
        }
      }
    }
    if (pending !== undefined) for (const bundle of bundles) {
      if (bundle.name === pending.target) bundle.pendingUpdate = { id: pending.id, version: pending.nextVersion }
    }
    return bundles
  }

  /** Read the registries this manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names.
   * @returns The registries in pnpm's comparison form; null is the one pnpm's own configuration names, `resolved` as pnpm reads it now.
   */
  @Remote
  async registries(): Promise<PluginRegistries> {
    return {
      ...this.configuredRegistries, fallbackRegistries: [...this.configuredRegistries.fallbackRegistries],
      resolved: await readProfileRegistry(this.profile.dir, {
        ...this.profile.packageManager ?? { command: this.pnpmCommand }, timeoutMs: this.inspectTimeoutMs,
      }),
    }
  }

  /** Read what a spec names before installing it.
   * @param spec One package spec: a registry name, an absolute path, a git address, or a tarball.
   * @param options The registry asked first.
   * @param signal Ends a registry lookup early.
   * @returns The package the spec names, or why it is refused.
   */
  @Remote
  async inspect(spec: string, options?: InspectOptions, signal?: AbortSignal): Promise<PluginSpecInspection> {
    return this.inspectSpec(spec, options, signal)
  }

  private async inspectSpec(
    spec: string, options?: InspectOptions, signal?: AbortSignal, target?: string, onlyRegistry?: Registry,
  ): Promise<PluginSpecInspection> {
    let parsed
    try {
      parsed = parseInstallSpec(spec)
    } catch (error) {
      /* v8 ignore next 2 -- parseInstallSpec throws nothing but its own refusal */
      if (!(error instanceof InvalidInstallSpecError)) throw error
      return refused('invalid-spec', error.reason)
    }
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest
    const known = new Set([
      ...manifest.dsh?.profile?.bundles ?? [], ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(installation.dependencies ?? {}),
    ])
    if (target !== undefined) known.delete(target)
    if (target !== undefined && parsed.kind === 'registry' && parsed.name !== target) return refused('target-mismatch', 'the replacement must name the selected bundle')
    const plan = onlyRegistry === undefined ? registryPlan(options?.registry, await this.registries()) : [onlyRegistry]
    const registry = plan[0] as Registry
    switch (parsed.kind) {
      case 'git': return { status: 'accepted', kind: 'git', bundle: null, registry, host: parsed.host }
      case 'tarball':
        if (parsed.path !== undefined && !existsSync(parsed.path)) return refused('not-a-package', 'the tarball does not exist')
        return { status: 'accepted', kind: 'tarball', bundle: null, registry, ...parsed.host === undefined ? {} : { host: parsed.host } }
      case 'path': {
        if (!existsSync(parsed.path)) return refused('not-a-package', 'the path does not exist')
        let read: object
        try {
          read = JSON.parse(await readFile(join(parsed.path, 'package.json'), 'utf8')) as object
        } catch (error) {
          return refused('not-a-package', `no readable package.json at the path: ${messageOf(error)}`)
        }
        const inspection = inspectionOf('path', read, registry)
        if (inspection.name === undefined) return refused('not-a-package', 'the package.json names no package')
        if (target !== undefined && inspection.name !== target) return refused('target-mismatch', 'the replacement must name the selected bundle')
        if (known.has(inspection.name)) return refused('already-installed', `${inspection.name} is already installed`)
        if (!inspection.bundle) return refused('not-a-bundle', `${inspection.name} declares no dsh.bundle`)
        return inspection
      }
      case 'registry': {
        if (known.has(parsed.name)) return refused('already-installed', `${parsed.name} is already installed`)
        const registries: Registry[] = []
        const refusedBy = (problem: PluginInspectProblem, reason: string): PluginSpecInspection =>
          ({ status: 'refused', problem, reason, registries })
        for (const current of plan) {
          registries.push(current)
          const view = await viewProfilePackage(this.profile.dir, spec.trim(), {
            ...this.profile.packageManager ?? { command: this.pnpmCommand },
            timeoutMs: this.inspectTimeoutMs, ...signal === undefined ? {} : { signal }, registry: current,
          })
          const printed = view.stdout.replace(ANSI_SEQUENCE, '').trim()
          if (view.exitCode !== 0 || view.cause !== undefined || view.timedOut) {
            // pnpm prints a refusal as `{ error: { code, message } }` on stdout, with nothing on stderr.
            const log = [view.stderr.trim(), printedError(printed), view.cause === undefined ? '' : messageOf(view.cause)].filter(Boolean).join('\n')
            const kind = classifyInstallFailure({ log, timedOut: view.timedOut, ...view.cause === undefined ? {} : { cause: view.cause } })
            // A lookup the caller dropped is not carried to the next registry.
            if (registries.length < plan.length && signal?.aborted !== true && attributeFailure(kind, log, parsed) === 'registry') continue
            const reason = view.timedOut ? `pnpm view timed out after ${String(this.inspectTimeoutMs)}ms` : log || printed || `pnpm view exited with ${String(view.exitCode)}`
            if (kind === 'not-found' || kind === 'no-matching-version') return refusedBy('not-found', reason)
            if (kind === 'network' || kind === 'timeout') return refusedBy('network', reason)
            return refusedBy('unknown', reason)
          }
          let answer: unknown
          try {
            answer = JSON.parse(printed || 'null')
          } catch (error) {
            return refusedBy('unknown', `unreadable pnpm view output: ${messageOf(error)}`)
          }
          // A range answers one object per matching version, oldest first.
          const latest: unknown = Array.isArray(answer) ? answer.at(-1) : answer
          if (typeof latest !== 'object' || latest === null) return refusedBy('unknown', 'pnpm view answered no package')
          const inspection = inspectionOf('registry', latest, current)
          const named = inspection.name === undefined ? { ...inspection, name: parsed.name } : inspection
          if (target !== undefined && named.name !== target) return refused('target-mismatch', 'the registry answered a different package')
          if (!named.bundle) return refusedBy('not-a-bundle', `${named.name} declares no dsh.bundle`)
          return named
        }
        /* v8 ignore next -- the plan is never empty: every attempt returns or continues to the next */
        throw new Error('no registry was asked')
      }
    }
  }

  /** Check the selected bundle at its profile registry without installing or changing configuration.
   * @param name Profile-owned bundle package name.
   * @returns An exact newer registry spec, the current version, a manual source, or a refusal.
   */
  @Remote
  async checkBundleUpdate(name: string): Promise<BundleUpdateCheck> {
    try {
      const target = this.updateTarget(name)
      const source = dependencySource(target.spec)
      if (source === undefined) throw new ManagementFailure('not-updatable')
      if (source !== 'registry') return { status: 'manual', currentVersion: target.currentVersion, source }
      const registry = await readProfileRegistry(this.profile.dir, {
        ...this.profile.packageManager ?? { command: this.pnpmCommand }, timeoutMs: this.inspectTimeoutMs, packageName: name,
      })
      if (registry === null) throw new Error('The profile registry could not be resolved; no other registry was asked')
      const inspection = await this.inspectSpec(`${name}@latest`, { registry }, this.abort.signal, name, registry)
      if (inspection.status === 'refused') return { status: 'refused', error: { code: 'operation-error', diagnostic: inspection.reason } }
      if (!exactVersion(inspection.version)) throw new ManagementFailure('not-newer')
      if (!gt(inspection.version, target.currentVersion)) return { status: 'current', currentVersion: target.currentVersion }
      return { status: 'available', currentVersion: target.currentVersion, version: inspection.version,
        spec: `${name}@${inspection.version}`, registry: inspection.registry }
    } catch (error) { return { status: 'refused', error: managementError(error) } }
  }

  /** Inspect a replacement for one installed bundle; unresolved Git/tarball identity is checked after fetching.
   * @param name Exact installed target, never inferred from the replacement spec.
   * @param spec Replacement package spec.
   * @param options Registry selected by the caller; absence uses the profile registry.
   * @param signal Ends a registry lookup early.
   * @returns Accepted metadata or a different-package, non-update, or ordinary inspection refusal.
   */
  @Remote
  async inspectBundleUpdate(name: string, spec: string, options?: InspectOptions, signal?: AbortSignal): Promise<PluginSpecInspection> {
    let target: UpdateTarget
    try { target = this.updateTarget(name) }
    catch (error) { return refused('not-updatable', messageOf(error)) }
    const registry = options?.registry === undefined ? null : options.registry
    const inspection = await this.inspectSpec(spec, options, signal, name, registry)
    if (inspection.status === 'refused') return inspection
    if (inspection.name !== undefined && inspection.name !== name) return refused('target-mismatch', 'the replacement must name the selected bundle')
    if (inspection.kind === 'registry' || inspection.kind === 'path') {
      if (!exactVersion(inspection.version) || !gt(inspection.version, target.currentVersion)) {
        return refused('not-newer', 'the replacement must have a strictly newer semantic version')
      }
    }
    return inspection
  }

  /** Prepare an isolated update for a profile-owned bundle, preserving its running version, selection and configuration.
   * @param name Exact installed bundle package name.
   * @param spec Replacement package spec, pinned for automatic registry updates.
   * @param options Expected installed version, request identity, script approvals and registry.
   * @returns Candidate diagnostics and stagedVersion after atomic pending publication; Desktop activates it only after a clean Host exit.
   */
  @Remote
  updateBundle(name: string, spec: string, options: UpdateBundleOptions): Promise<ChangeResult> {
    return this.stageUpdate(name, spec, options)
  }

  /** Archive one still-pending update without changing the running dependency graph.
   * @param name Exact target package shown by listBundles.
   * @param expectedId Pending descriptor id shown by listBundles.
   * @returns Applied after the descriptor is archived; stale ids or an activation already started are refused.
   */
  @Remote
  discardBundleUpdate(name: string, expectedId: string): Promise<ChangeResult> {
    return this.change(async (result) => {
      const profile = await realpath(this.profile.dir)
      await ensurePreparationDirectory(profile, 'updates')
      const descriptorPath = join(profile, PENDING_UPDATE_PATH)
      const assertFile = async (path: string): Promise<boolean> => {
        try {
          const stat = await lstat(path)
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Pending update metadata must be a regular file')
          return true
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
      }
      if (!await assertFile(descriptorPath)) throw new ManagementFailure('stale-update')
      const pending = await readPendingBundleUpdate(profile)
      if (pending?.id !== expectedId || pending.target !== name) throw new ManagementFailure('stale-update')
      if (await assertFile(join(profile, '.plugin-manager/desktop-activation.json'))) throw new Error('Pending update activation already started; complete Desktop recovery before discarding it')
      const directory = join(profile, '.plugin-manager/updates', pending.id)
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Pending update archive must be a real directory')
      const bytes = await readFile(descriptorPath)
      const receiptPath = join(profile, '.plugin-manager/desktop-clean-stop.json')
      let matchingReceipt = false
      if (await assertFile(receiptPath)) {
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { id?: string; descriptorHash?: string; producerPid?: number }
        matchingReceipt = receipt.id === pending.id && receipt.producerPid === pending.producerPid
          && receipt.descriptorHash === createHash('sha256').update(bytes).digest('hex')
      }
      await writeFileAtomic(join(directory, 'discarded-pending.json'), bytes.toString('utf8'), { mode: 0o600 })
      if (matchingReceipt) await rename(receiptPath, join(directory, 'discarded-clean-stop.json'))
      await rm(descriptorPath)
      result.changed = true
      return 'applied'
    }, { stage: 'install', target: name }, 'install')
  }

  private stageUpdate(name: string, spec: string, options: UpdateBundleOptions): Promise<ChangeResult> {
    const requestId = options.requestId
    const control: InstallControl = { abort: new AbortController(), phase: 'installing', result: Promise.resolve(null) }
    if (requestId !== undefined) this.installs.set(requestId, control)
    const signal = AbortSignal.any([this.abort.signal, control.abort.signal, AbortSignal.timeout(this.prepareTimeoutMs)])
    const announce = (phase: PluginInstallProgress['phase']): void => {
      if (requestId !== undefined) this.ownerContext.emit('plugin-manager/install-state', { requestId, phase })
    }
    const result = this.change(async (result) => {
      try {
        signal.throwIfAborted()
        const profile = await realpath(this.profile.dir)
        if (await readPendingBundleUpdate(profile) !== undefined) throw new ManagementFailure('pending-update')
        const target = this.updateTarget(name)
        if (target.currentVersion !== options.expectedVersion) throw new ManagementFailure('stale-update')
        const parsed = parseInstallSpec(anchorPathSpec(spec, this.profile.cwd))
        const inspection = await this.inspectBundleUpdate(name, parsed.spec, options, signal)
        if (inspection.status === 'refused') {
          if (inspection.problem === 'target-mismatch' || inspection.problem === 'not-newer' || inspection.problem === 'not-updatable') throw new ManagementFailure(inspection.problem)
          throw new Error(inspection.reason)
        }
        const installSpec = inspection.kind === 'registry' ? `${name}@${inspection.version as string}` : parsed.spec
        const original = readProfileManifest('dsh', profile)
        const baseBindings = await readUpdateBaseBindings(profile, signal)
        const approvalKey = JSON.stringify([name, installSpec, options.expectedVersion, options.registry ?? null])
        const previous = options.approvedBuilds === undefined ? undefined : this.stagedBuilds.get(approvalKey)
        if (options.approvedBuilds !== undefined && (previous === undefined || previous.base !== JSON.stringify(baseBindings))) throw new ManagementFailure('stale-approval')
        const packages = await this.installedPackages(original, signal)
        const id = previous?.id ?? randomUUID()
        const relativePath = `.plugin-manager/updates/${id}/candidate`
        const directory = join(profile, '.plugin-manager/updates', id)
        const candidate = join(profile, relativePath)
        await ensurePreparationDirectory(profile, 'updates')
        if (previous === undefined) await mkdir(directory, { mode: 0o700 })
        let published = false
        let retained = false
        try {
          if (previous === undefined) await copyUpdateCandidate(profile, candidate, signal)
          else if (JSON.stringify(await readUpdateBaseBindings(candidate, signal)) !== JSON.stringify(previous.bindings)) throw new ManagementFailure('stale-approval')
          if (options.approvedBuilds !== undefined) {
            await approveBuilds(candidate, options.approvedBuilds)
            result.approvedBuilds = options.approvedBuilds
          }
          const registry = options.registry ?? null
          result.registries = [registry]
          announce('installing')
          const connection = previous === undefined ? checkGithubConnection(parsed, candidate, {
            timeoutMs: this.githubConnectionTimeoutMs, outputBytes: this.outputBytes, signal,
            ...this.profile.packageManager?.env === undefined ? {} : { env: this.profile.packageManager.env },
          }) : Promise.resolve(undefined)
          this.packageOperations.add(connection)
          let connectionFailure: PackageResult | undefined
          try { connectionFailure = await connection } finally { this.packageOperations.delete(connection) }
          if (connectionFailure?.kind === 'network' || connectionFailure?.kind === 'timeout') {
            result.packageResult = connectionFailure
            result.failedAt = 'spec-host'
            throw new Error(connectionFailure.output)
          }
          const args = previous === undefined ? [
            'add', installSpec, ...registryArguments(registry),
            '--package-import-method=copy', '--ignore-pnpmfile', '--config.ignore-workspace=true',
            '--modules-dir=node_modules', '--virtual-store-dir=node_modules/.pnpm', `--lockfile-dir=${candidate}`,
            '--config.enable-global-virtual-store=false',
          ] : [
            'approve-builds', ...registryArguments(registry),
            '--config.ignore-pnpmfile=true', '--config.ignore-workspace=true', '--config.modules-dir=node_modules',
            '--config.virtual-store-dir=node_modules/.pnpm', `--config.lockfile-dir=${candidate}`,
            '--config.enable-global-virtual-store=false', '--', ...options.approvedBuilds ?? [],
          ]
          const run = await this.runPnpm(args, signal, requestId, candidate)
          result.packageResult = run
          signal.throwIfAborted()
          if (run.incompatible !== undefined) throw new ManagementFailure('incompatible-version', run.incompatible)
          if (run.exitCode !== 0 || run.timedOut === true) {
            result.pendingBuilds = await readPendingBuilds(candidate)
            const bindings = await readUpdateBaseBindings(candidate, signal)
            if (result.pendingBuilds.length > 0 && bindings.files['pnpm-lock.yaml'] !== null && bindings.nodeModules !== null) {
              this.stagedBuilds.set(approvalKey, { base: JSON.stringify(baseBindings), names: result.pendingBuilds, id, bindings })
              retained = true
            }
            throw new Error(run.output)
          }
          const prepared = readProfileManifest('dsh', candidate)
          const installed = readProfileManifest('dsh', join(candidate, 'node_modules', name))
          if (installed.name !== name || !Object.hasOwn(prepared.dependencies ?? {}, name)) throw new ManagementFailure('target-mismatch')
          if (inspection.version !== undefined && installed.version !== inspection.version) throw new ManagementFailure('target-mismatch')
          if (!exactVersion(installed.version) || !gt(installed.version, options.expectedVersion)) throw new ManagementFailure('not-newer')
          if (installed.dsh?.bundle === undefined) throw new ManagementFailure('not-bundle')
          const compatibility = evaluatePluginCompatibility(installed, readProfileVersionExemptions(profile))
          if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
          for (const file of bundlePatchPaths(join(candidate, 'node_modules', name), installed.dsh.bundle)) loadOverlayPatches('dsh', file)
          // Non-target package specs are restored only after pnpm has resolved them at their original locations.
          await finalizeUpdateCandidate(profile, candidate, name, signal)
          await this.assertUnchangedDependencies(original, readProfileManifest('dsh', candidate), packages, name, candidate)
          if (JSON.stringify(baseBindings) !== JSON.stringify(await readUpdateBaseBindings(profile, signal))) throw new ManagementFailure('stale-update')
          if (this.updateTarget(name).currentVersion !== options.expectedVersion) throw new ManagementFailure('stale-update')
          const pending: PendingBundleUpdate = { schema: 1, id, producerPid: process.pid, profileRealPath: profile, target: name,
            beforeVersion: options.expectedVersion, nextVersion: installed.version, baseBindings, candidateRelativePath: relativePath,
            candidateBindings: await readUpdateCandidateBindings(candidate, signal), createdAt: Date.now() }
          signal.throwIfAborted()
          control.phase = 'applying'
          announce('applying')
          await writeFileAtomic(join(profile, PENDING_UPDATE_PATH), JSON.stringify(pending, null, 2) + '\n', { mode: 0o600 })
          published = true
          this.stagedBuilds.delete(approvalKey)
          result.changed = true
          result.bundle = name
          result.enabled = target.enabled
          result.stagedVersion = installed.version
          return 'restart-required'
        } catch (error) {
          if (control.abort.signal.aborted || this.abort.signal.aborted) throw new InstallCancelledError()
          throw error
        } finally {
          if (!published && !retained) {
            this.stagedBuilds.delete(approvalKey)
            const active = await activeProfilePackageRun(candidate)
            if (active === undefined) await rm(directory, { recursive: true, force: true })
            else throw new Error(`Candidate cleanup refused while its package process is active: ${active}`)
          }
        }
      } catch (error) {
        if ((control.abort.signal.aborted || this.abort.signal.aborted) && error instanceof Error && error.name === 'AbortError') throw new InstallCancelledError()
        throw error
      }
    }, { stage: 'install', target: name }, 'install')
    control.result = result
    this.packageOperations.add(result)
    return result.finally(() => {
      this.packageOperations.delete(result)
      if (requestId !== undefined) this.installs.delete(requestId)
    })
  }

  private updateTarget(name: string): UpdateTarget {
    const profile = readProfileManifest('dsh', this.profile.dir)
    const spec = profile.dependencies?.[name]
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest
    if (!Object.hasOwn(profile.dependencies ?? {}, name) || spec === undefined || Object.hasOwn(installation.dependencies ?? {}, name)) throw new ManagementFailure('not-updatable')
    if (this.protectsManager(name)) throw new ManagementFailure('management-required')
    const manifest = readProfileManifest('dsh', join(this.profile.dir, 'node_modules', name))
    if (manifest.name !== name) throw new ManagementFailure('target-mismatch')
    if (manifest.dsh?.bundle === undefined) throw new ManagementFailure('not-bundle')
    if (!exactVersion(manifest.version)) throw new ManagementFailure('not-updatable')
    return { name, spec, currentVersion: manifest.version, enabled: (profile.dsh?.profile?.bundles ?? []).includes(name) }
  }

  /** Persist a plugin entry's desired enablement and apply it on live profiles.
   * @param id Loader entry identity returned by listPlugins.
   * @param enabled Whether the plugin should run.
   * @returns Saved and runtime outcomes, including higher-priority overrides.
   */
  @Remote
  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      const row = (await this.listPlugins()).find(item => item.entryId === id)
      if (row === undefined) throw new ManagementFailure('unknown-plugin')
      if (row.readOnlyReason !== undefined) throw new ManagementFailure(row.readOnlyReason)
      await writePluginEnabled(this.profile.patchPath, row.patchId, row.moduleName, enabled)
      result.warnings = await this.reload(enabled ? [row.patchId] : [])
      const current = (await this.listPlugins()).find(item => item.entryId === id)
      return current?.enabled !== enabled && this.ownerContext.get('hmr') !== undefined ? 'overridden' : undefined
    }), { stage: 'enable', target: id, enabled }, 'plugin')
  }

  /** Select or remove a bundle layer while retaining installed dependencies.
   * @param name Bundle package name.
   * @param enabled Whether the bundle contributes its patch layer.
   * @returns Persisted and runtime outcomes.
   */
  @Remote
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult> {
    return this.change(result => this.configure(async () => {
      await this.selectBundle(name, enabled)
      result.warnings = await this.reload(enabled ? this.bundleRows(name).map(row => row.id) : [])
    }), { stage: 'enable', target: name, enabled }, 'bundle')
  }

  /**
   * Install a package using the same pnpm implementation as dsh plugin. GitHub
   * repositories get a connection check bounded by githubConnectionTimeoutMs before pnpm starts;
   * only network failures or timeouts stop that check. Git uses pnpm authentication; remote tarballs are captured
   * once with HTTP fetch, so URLs requiring pnpm-specific authentication must be supplied as a local tarball. A run
   * that fails, is cancelled, or adds a package without a bundle patch restores
   * `package.json` and `pnpm-lock.yaml`; installing a newer existing bundle uses the separate staged update path.
   * @param spec One package spec, including local paths relative to the invocation directory.
   * @param options Whether to activate the installed bundle (defaults to true), the request id a cancellation names,
   * the pending build scripts to allow for this profile before pnpm runs, and the registry asked first.
   * @returns Package-manager diagnostics, the registries asked, and the observed activation outcome.
   */
  @Remote
  installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult> {
    return this.installTransaction(spec, options)
  }

  private installTransaction(spec: string, options?: InstallBundleOptions): Promise<ChangeResult> {
    const requestId = options?.requestId
    const control: InstallControl = { abort: new AbortController(), phase: 'installing', result: Promise.resolve(null) }
    const stopped = (): boolean => control.abort.signal.aborted || this.abort.signal.aborted
    if (requestId !== undefined) this.installs.set(requestId, control)
    const announce = (phase: PluginInstallProgress['phase'], attempt?: PluginInstallProgress['attempt']): void => {
      if (requestId !== undefined) this.ownerContext.emit('plugin-manager/install-state', { requestId, phase, ...attempt === undefined ? {} : { attempt } })
    }
    const result = this.change(async (result) => {
      if (spec.trim() === '' || spec.startsWith('-')) throw new ManagementFailure('invalid-spec')
      if (stopped()) throw new InstallCancelledError()
      const beforeManifest = readProfileManifest('dsh', this.profile.dir)
      const before = beforeManifest.dependencies ?? {}
      const parsed = parseInstallSpec(anchorPathSpec(spec, this.profile.cwd))
      const known = new Set([...beforeManifest.dsh?.profile?.bundles ?? [], ...Object.keys(profileDependencies(beforeManifest)), ...Object.keys((JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as InstallationManifest).dependencies ?? {})])
      let named = parsed.kind === 'registry' ? parsed.name : undefined
      if (parsed.kind === 'path' && existsSync(join(parsed.path, 'package.json'))) named = stringField(JSON.parse(await readFile(join(parsed.path, 'package.json'), 'utf8')) as object, 'name')
      if (named !== undefined && known.has(named)) throw new ManagementFailure('update-required')
      let installSpec = spec
      let rebuildApproved = false
      if (options?.approvedBuilds !== undefined) {
        rebuildApproved = await approveBuilds(this.profile.dir, options.approvedBuilds)
        result.approvedBuilds = options.approvedBuilds
      }
      const files = await this.readRestoredFiles()
      let name: string
      try {
        result.registries = []
        const connection = checkGithubConnection(parsedForRegistry(spec), this.profile.dir, {
          timeoutMs: this.githubConnectionTimeoutMs, outputBytes: this.outputBytes,
          signal: AbortSignal.any([this.abort.signal, control.abort.signal]),
          ...this.profile.packageManager?.env === undefined ? {} : { env: this.profile.packageManager.env },
        })
        this.packageOperations.add(connection)
        let connectionFailure: PackageResult | undefined
        try { connectionFailure = await connection }
        finally { this.packageOperations.delete(connection) }
        if (stopped()) throw new InstallCancelledError()
        if (connectionFailure?.kind === 'network' || connectionFailure?.kind === 'timeout') {
          result.packageResult = connectionFailure
          result.failedAt = 'spec-host'
          throw new Error(connectionFailure.output)
        }
        if (parsed.kind === 'git' || parsed.kind === 'tarball') {
          const preparationSignal = AbortSignal.any([this.abort.signal, control.abort.signal, AbortSignal.timeout(this.prepareTimeoutMs)])
          installSpec = await this.prepareOpaqueInstallSpec(parsed, known, preparationSignal,
            (run) => {
              result.packageResult = run
              result.registries = [options?.registry ?? null]
              const failure = run.kind === undefined ? undefined : attributeFailure(run.kind, run.output, parsed)
              if (failure !== undefined && failure !== 'other') result.failedAt = failure
            }, requestId, options?.registry)
          if (stopped()) throw new InstallCancelledError()
        }
        if (rebuildApproved) {
          const approved = await this.runPnpm(['approve-builds', '--', ...options?.approvedBuilds ?? []], control.abort.signal, requestId)
          result.packageResult = approved
          if (stopped()) throw new InstallCancelledError()
          if (approved.exitCode !== 0 || approved.timedOut === true) throw new Error(approved.output)
        }
        // The last run is the result's; the registries asked stay listed whatever the outcome.
        const plan = registryPlan(options?.registry, await this.registries())
        let run: PackageResult | undefined
        for (const [index, registry] of plan.entries()) {
          if (index > 0) await this.restoreFiles(files)
          // A stop that landed while the files went back, or before the first run, starts no run with a dead signal.
          if (stopped()) throw new InstallCancelledError()
          result.registries.push(registry)
          announce('installing', { registry, index: index + 1, total: plan.length })
          run = await this.runPnpm(['add', installSpec, ...registryArguments(registry)], control.abort.signal, requestId)
          result.packageResult = run
          if (stopped()) throw new InstallCancelledError()
          // A compatibility refusal is the package's own answer, so no other registry is asked.
          if (run.incompatible !== undefined) throw new ManagementFailure('incompatible-version', run.incompatible)
          // A run this manager terminated is not a success, even when pnpm trapped the signal and exited 0.
          if (run.exitCode === 0 && run.timedOut !== true) break
          /* v8 ignore next 2 -- runPnpm classifies every run it does not report as succeeded */
          if (run.kind === undefined) break
          // What the last failed run could not reach; a later run that succeeds leaves nothing to say.
          delete result.failedAt
          // A run this manager terminated got no answer from the registry at all, so no registry explains it.
          if (run.timedOut === true) break
          const failedAt = attributeFailure(run.kind, run.output, parsedForRegistry(spec))
          if (failedAt !== 'other') result.failedAt = failedAt
          if (failedAt !== 'registry' || index === plan.length - 1) break
        }
        /* v8 ignore next -- the plan is never empty, so a run always settled */
        if (run === undefined) throw new Error('no registry was asked')
        // A terminated run reports no usable exit status, so neither its files nor its bundle are trusted.
        const succeeded = run.exitCode === 0 && run.timedOut !== true
        if (succeeded) delete result.failedAt
        if (!succeeded) {
          // pnpm-workspace.yaml is not restored, so the names pnpm left undecided there can be offered for approval.
          try { result.pendingBuilds = await readPendingBuilds(this.profile.dir) }
          catch (error) {
            this.ownerContext.logger.warn('Could not read pending build approvals after pnpm failed', error)
          }
          throw new Error(run.output)
        }
        const after = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
        const installed = Object.keys(after).filter(name => before[name] !== after[name])
        // Registry retries can retain the saved range after a partial installation.
        if (installed.length === 0) installed.push(...Object.keys(after).filter(name => spec === name || spec.startsWith(`${name}@`)))
        const target = installed[0]
        if (target === undefined || installed.length !== 1) throw new ManagementFailure('ambiguous-install')
        if (Object.hasOwn(before, target)) throw new ManagementFailure('update-required')
        name = target
        const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
        const manifest = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        if (manifest?.dsh?.bundle === undefined) throw new ManagementFailure('not-bundle')
        const compatibility = evaluatePluginCompatibility(manifest, readProfileVersionExemptions(this.profile.dir))
        if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
        for (const file of bundlePatchPaths(dir, manifest.dsh.bundle)) loadOverlayPatches('dsh', file)
        if (stopped()) throw new InstallCancelledError()
      } catch (error) {
        await this.restoreFiles(files)
        if (stopped() && error instanceof Error && error.name === 'AbortError') throw new InstallCancelledError()
        throw error
      }
      control.phase = 'applying'
      announce('applying')
      result.bundle = name
      result.target = name
      result.stage = 'enable'
      return this.configure(async () => {
        if (options?.enabled !== false) await this.selectBundle(name, true)
        if (Object.hasOwn(before, name)) return 'restart-required'
        if (options?.enabled !== false) result.warnings = await this.reload()
      })
    }, { stage: 'install', target: spec, enabled: options?.enabled !== false }, 'install')
    control.result = result
    this.packageOperations.add(result)
    return result.finally(() => {
      this.packageOperations.delete(result)
      if (requestId !== undefined) this.installs.delete(requestId)
    })
  }

  /** Recover the result of an active installation without cancelling it.
   * @param requestId The id supplied when installation started.
   * @returns The installation's outcome after it settles, or null if no active request has that id.
   * Completed results are not retained; null establishes neither success nor cancellation.
   */
  @Remote
  async waitForInstall(requestId: PluginInstallRequestId): Promise<ChangeResult | null> {
    return this.installs.get(requestId)?.result ?? null
  }

  /** Stop an installation or update preparation this manager owns and await its cleanup.
   * @param requestId The id the installation was started with.
   * @returns `cancelled` after process exit and cleanup, `too-late` during activation or pending publication,
   * `not-running` for any other id, or `failed` when the operation could not clean up safely.
   */
  @Remote
  async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation> {
    const control = this.installs.get(requestId)
    if (control === undefined) return { status: 'not-running' }
    if (control.phase === 'applying') return { status: 'too-late' }
    this.ownerContext.emit('plugin-manager/install-state', { requestId, phase: 'cancelling' })
    control.abort.abort()
    /* v8 ignore next -- change() folds every failure into its result; only a lock or disposal error rejects */
    const result = await control.result.catch(() => null)
    if (result?.application === 'failed') return { status: 'failed', error: result.error ?? { code: 'operation-error' } }
    return { status: 'cancelled' }
  }

  /** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path.
   * @param name Installed dependency name.
   * @returns Removal diagnostics and the remaining profile state.
   */
  @Remote
  removeBundle(name: string): Promise<ChangeResult> {
    return this.change(async (result) => {
      await this.configure(async () => {
        const bundle = (await this.listBundles()).find(item => item.name === name)
        if (bundle === undefined || !bundle.removable) throw new ManagementFailure('not-removable')
        if (this.ownerContext.get('hmr') === undefined && (this.profile.startedBundles.includes(name)
          || (bundle.error === undefined && this.bundleRows(name).some(row => [...this.ctx.loader.entries()]
            .some(entry => entry.options.id === row.id && entry.fiber !== undefined))))) {
          throw new ManagementFailure('stop-profile')
        }
        const contributions = bundle.error === undefined ? this.bundleRows(name) : []
        if (bundle.enabled) {
          await this.selectBundle(name, false)
          result.warnings = await this.reload()
        }
        if ([...this.ctx.loader.entries()].some(entry => entry.fiber?.uid != null
          && contributions.some(row => row.id === entry.options.id && row.name === entry.options.name))) {
          throw new ManagementFailure('bundle-in-use')
        }
      })
      result.packageResult = await this.runPnpm(['remove', name])
      if (result.packageResult.exitCode !== 0 || result.packageResult.timedOut === true) {
        throw new Error(result.packageResult.output)
      }
    }, { stage: 'remove', target: name }, 'remove')
  }

  /** The rows a bundle's patch inserts and the existing rows it changes; an unreadable patch throws. */
  private declaredRows(name: string, info: ProfileManifest): Pick<BundleInfo, 'rows' | 'overrides'> {
    const bundle = info.dsh?.bundle
    /* v8 ignore next -- bundleManifest answers only manifests that declare a patch */
    if (bundle === undefined) return { rows: [], overrides: [] }
    const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    const patches: PatchOptions[] = bundlePatchPaths(dir, bundle).flatMap(file => loadOverlayPatches('dsh', file))
    // One entry per row id: the Loader keeps a single entry for an id, whichever layer declared it last.
    const live = new Map<string, { entryId: PluginEntryId; baseUrl: string | undefined }>()
    for (const entry of this.ctx.loader.entries()) {
      /* v8 ignore next -- the Loader gives every entry an id before it is listed */
      if (typeof entry.options.id === 'string') live.set(entry.options.id, {
        entryId: pluginEntryId(entry.id), baseUrl: entry.parent.tree.ctx.baseUrl,
      })
    }
    const rows: BundleRowInfo[] = []
    const packages = this.ctx.get('pluginPackages')
    for (const row of flatten(composeEntries([patches.filter(item => item.insert !== undefined)]))) {
      if (typeof row.id !== 'string' || typeof row.name !== 'string') continue
      const active = live.get(row.id)
      const entryId = active?.entryId
      const base = active?.baseUrl ?? pathToFileURL(join(dir, 'package.json')).href
      const meta = packages?.metaOf(row.name, base)
      rows.push({ rowId: row.id, moduleName: row.name,
        ...entryId === undefined ? {} : { entryId }, ...meta === undefined ? {} : { meta } })
    }
    const declared = new Set(rows.map(row => row.rowId))
    const overrides = [...new Set(patches.flatMap(item =>
      item.insert === undefined && typeof item.id === 'string' && !declared.has(item.id) ? [item.id] : []))]
    return { rows, overrides }
  }

  /** Bind a previously unknown install identity before the active profile can be touched. */
  private async prepareOpaqueInstallSpec(parsed: Extract<ParsedInstallSpec, { kind: 'git' | 'tarball' }>, known: ReadonlySet<string>, signal: AbortSignal, report: (result: PackageResult) => void, requestId?: PluginInstallRequestId, registry?: Registry): Promise<string> {
    const profile = await realpath(this.profile.dir)
    const parent = await ensurePreparationDirectory(profile, 'install-sources')
    const directory = join(parent, randomUUID())
    const probe = join(directory, 'probe')
    await mkdir(probe, { recursive: true, mode: 0o700 })
    let keepArtifact = false
    try {
      await writeFileAtomic(join(probe, 'package.json'), '{"name":"dsh-install-identity","private":true}\n', { mode: 0o600 })
      for (const file of ['.npmrc', 'pnpm-workspace.yaml', 'compatibility.json']) {
        try { await copyFile(join(profile, file), join(probe, file)) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      let fixed = parsed.spec
      if (parsed.kind === 'tarball') {
        const artifact = join(directory, 'package.tgz')
        if (parsed.path !== undefined) await copyFile(parsed.path, artifact)
        else {
          // Fetch exactly once: the same original bytes are inspected and later installed, with no repacking.
          const response = await fetch(parsed.spec, { signal })
          if (!response.ok || response.body === null) throw new Error(`Could not download the package tarball (HTTP ${String(response.status)}); use a local tarball if this URL requires pnpm-specific authentication`)
          const file = await open(artifact, 'wx', 0o600)
          const reader = response.body.getReader()
          try {
            while (true) {
              signal.throwIfAborted()
              const chunk = await reader.read()
              if (chunk.done) break
              await file.writeFile(chunk.value)
            }
          } finally { reader.releaseLock(); await file.close() }
        }
        fixed = artifact
      }
      const inspected = await this.runPnpm(['add', fixed, ...registryArguments(registry ?? null), '--ignore-scripts', '--ignore-pnpmfile', '--package-import-method=copy',
        '--config.ignore-workspace=true', '--modules-dir=node_modules', '--virtual-store-dir=node_modules/.pnpm', `--lockfile-dir=${probe}`,
        '--config.enable-global-virtual-store=false'], signal, requestId, probe)
      report(inspected)
      signal.throwIfAborted()
      if (inspected.exitCode !== 0 || inspected.timedOut === true) throw new Error(inspected.output)
      const names = Object.keys(readProfileManifest('dsh', probe).dependencies ?? {})
      const name = names[0]
      if (names.length !== 1 || name === undefined) throw new ManagementFailure('ambiguous-install')
      if (known.has(name)) throw new ManagementFailure('update-required')
      const metadata = readProfileManifest('dsh', join(probe, 'node_modules', name))
      if (metadata.name !== name) throw new ManagementFailure('target-mismatch')
      if (metadata.dsh?.bundle === undefined) throw new ManagementFailure('not-bundle')
      if (parsed.kind === 'git') {
        const lock = parse(await readFile(join(probe, 'pnpm-lock.yaml'), { encoding: 'utf8', signal })) as {
          importers?: Record<string, { dependencies?: Record<string, { version?: string }> }>
          packages?: Record<string, { resolution?: { commit?: string; tarball?: string } }>
        }
        const version = lock.importers?.['.']?.dependencies?.[name]?.version
        const resolution = version === undefined ? undefined : (lock.packages?.[version] ?? lock.packages?.[`${name}@${version}`])?.resolution
        const commit = resolution?.commit ?? /(?:#|\/)([a-f0-9]{40})(?:$|\()/i.exec(resolution?.tarball ?? version ?? '')?.[1]
        if (commit === undefined || !/^[a-f0-9]{40}$/i.test(commit)) throw new Error('The Git package could not be pinned to the exact inspected commit')
        fixed = parsed.spec.replace(/#.*$/, '') + '#' + commit
      } else keepArtifact = true
      return fixed
    } finally {
      const active = await activeProfilePackageRun(probe)
      if (active !== undefined) throw new Error(`Install identity probe cleanup refused while its process is active: ${active}`)
      await rm(keepArtifact ? probe : directory, { recursive: true, force: true })
    }
  }

  /** Run one pnpm command in the profile, streaming its output as install-log chunks. */
  private async runPnpm(
    args: readonly string[], signal?: AbortSignal, requestId?: PluginInstallRequestId, directory = this.profile.dir,
  ): Promise<PackageResult> {
    const jobId = randomUUID()
    const argv = ['pnpm', ...args]
    const cwd = directory
    const identity = requestId === undefined ? {} : { requestId }
    const operationSignal = signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, signal])
    const task = runProfilePnpm({ ...this.profile, dir: directory, profile: this.profile.name }, args, {
      execution: 'service', ...this.profile.packageManager ?? { command: this.pnpmCommand },
      signal: operationSignal,
      outputBytes: this.outputBytes, activateNewBundles: false, idleTimeoutMs: this.idleTimeoutMs,
      lookupTimeoutMs: this.inspectTimeoutMs,
      restoreCompatibilityFailure: directory === this.profile.dir,
      onOutput: (text, stream) => {
        this.ownerContext.emit('plugin-manager/install-log', { ...identity, jobId, argv, cwd, stream, text })
      },
    })
    this.packageOperations.add(task)
    try {
      const result = await task
      this.ownerContext.emit('plugin-manager/install-log', {
        ...identity, jobId, argv, cwd, stream: 'stdout', text: '', exitCode: signal?.aborted === true ? null : result.exitCode,
      })
      // A terminated run keeps its own kind even when pnpm trapped the signal and exited 0.
      if (result.exitCode === 0 && result.timedOut !== true) return result
      return {
        ...result,
        kind: classifyInstallFailure({ log: result.output, ...result.timedOut === true ? { timedOut: true } : {} }),
      }
    } catch (error) {
      this.ownerContext.emit('plugin-manager/install-log', { ...identity, jobId, argv, cwd, stream: 'stderr', text: messageOf(error), exitCode: null })
      throw error
    } finally {
      this.packageOperations.delete(task)
    }
  }

  /** The profile files an installation may rewrite, as they are now; absent files read as undefined. */
  private async readRestoredFiles(): Promise<Map<string, string | undefined>> {
    const files = new Map<string, string | undefined>()
    for (const name of RESTORED_FILES) {
      const path = join(this.profile.dir, name)
      files.set(path, existsSync(path) ? await readFile(path, 'utf8') : undefined)
    }
    return files
  }

  /** Put the profile files back; pnpm has exited by the time this runs. */
  private async restoreFiles(files: Map<string, string | undefined>): Promise<void> {
    for (const [path, content] of files) {
      if (content === undefined) await rm(path, { force: true })
      else await writeFileAtomic(path, content, { mode: 0o600 })
    }
  }

  private installedManifest(name: string, directory = this.profile.dir): string | undefined {
    try { return readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async installedPackages(manifest: ProfileManifest, signal: AbortSignal): Promise<Map<string, InstalledPackage>> {
    const result = new Map<string, InstalledPackage>()
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.prepareTimeoutMs)])
    for (const name of Object.keys(profileDependencies(manifest))) {
      result.set(name, { manifest: this.installedManifest(name), files: await packageFiles(join(this.profile.dir, 'node_modules', name), deadline) })
    }
    return result
  }

  private async assertUnchangedDependencies(
    before: ProfileManifest, after: ProfileManifest, installed: Map<string, InstalledPackage>, target: string, directory = this.profile.dir,
  ): Promise<void> {
    const previous = Object.fromEntries(Object.entries(profileDependencies(before)).filter(([name]) => name !== target))
    const current = Object.fromEntries(Object.entries(profileDependencies(after)).filter(([name]) => name !== target))
    const names = Object.keys(previous)
    if (names.length !== Object.keys(current).length || names.some(name => previous[name] !== current[name])) throw new ManagementFailure('target-mismatch')
    const deadline = AbortSignal.timeout(this.prepareTimeoutMs)
    for (const [name, contents] of installed) {
      if (name !== target && (this.installedManifest(name, directory) !== contents.manifest
        || await packageFiles(join(directory, 'node_modules', name), deadline) !== contents.files)) throw new ManagementFailure('target-mismatch')
    }
  }

  private async selectBundle(name: string, enabled: boolean): Promise<void> {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const previous = manifest.dsh?.profile?.bundles ?? []
    if (enabled || !previous.includes(name)) {
      const metadata = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
      if (metadata === undefined) throw new ManagementFailure('not-bundle')
      if (enabled) {
        const compatibility = evaluatePluginCompatibility(metadata, readProfileVersionExemptions(this.profile.dir))
        if (compatibility !== undefined && !compatibility.exempted) throw new ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])
        this.bundleRows(name)
      }
    }
    if (!enabled && previous.includes(name)) {
      if (this.protectsManager(name)) throw new ManagementFailure('management-required')
    }
    const bundles = enabled ? [...previous, ...previous.includes(name) ? [] : [name]] : previous.filter(item => item !== name)
    if (JSON.stringify(previous) === JSON.stringify(bundles)) return
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    await saveManifest(this.profile.dir, manifest)
    if (enabled) this.protectsManager(name)
  }

  private bundleRows(name: string): EntryOptions[] {
    const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
    if (info?.dsh?.bundle === undefined) return []
    const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    return flatten(composeEntries([bundlePatchPaths(dir, info.dsh.bundle).flatMap(file => loadOverlayPatches('dsh', file))]))
  }

  private protectsManager(name: string): boolean {
    if (this.managementBundles.has(name)) return true
    let rows: EntryOptions[]
    try { rows = this.bundleRows(name) } catch (_error) {
      // Unreadable bundles contribute no new rows; listBundles reports their diagnostics.
      return false
    }
    const protectedBundle = rows.some(row => protectedModules.has(row.name) || `include:${row.id}` === this.ownerEntryId)
    if (protectedBundle) this.managementBundles.add(name)
    return protectedBundle
  }

  private configure<T>(operation: () => Promise<T>): Promise<T> {
    const hmr = this.ownerContext.get('hmr')
    const apply = () => { this.abort.signal.throwIfAborted(); return operation() }
    return hmr === undefined ? apply() : hmr.runExclusive(apply)
  }

  private async reload(requiredIds: readonly string[] = []): Promise<string[]> {
    if (this.ownerContext.get('hmr') === undefined) return []
    return reconcileProfilePatches(this.ownerContext.root, readProfilePatches('dsh', this.profile), 'dsh', requiredIds)
  }

  private async change(
    operation: (result: ChangeResult) => Promise<ChangeResult['application'] | void>,
    request: Pick<ChangeResult, 'stage' | 'target' | 'enabled'>,
    reason: PluginChange['reason'],
  ): Promise<ChangeResult> {
    return withFileLock(join(this.profile.dir, 'package.json'), async () => {
      this.abort.signal.throwIfAborted()
      const before = this.diskState()
      const result: ChangeResult = { ...request, changed: false,
        application: this.ownerContext.get('hmr') !== undefined ? 'applied' : 'restart-required' }
      try {
        result.application = await operation(result) ?? result.application
      } catch (error) {
        if (error instanceof InstallCancelledError) {
          result.application = 'cancelled'
        } else {
          result.application = 'failed'
          result.error = managementError(error)
        }
      }
      result.changed = result.changed || before !== this.diskState()
      this.ownerContext.emit('plugin-manager/changed', { reason })
      return result
    }, { waitMs: this.lockWaitMs })
  }

  private diskState(): string {
    return ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', PROFILE_COMPATIBILITY_FILENAME].map((file) => {
      try { return readFileSync(join(this.profile.dir, file), 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    }).join('\0')
  }
}

export default PluginManager
