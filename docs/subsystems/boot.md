# Profile management

English | [中文](boot.zh.md)

The [boot package group](../../packages/boot/README.md) owns launcher-provided profile access and the plugin manager. [Plugin Manager](../../packages/boot/plugin-manager/README.md) documents persistence, reload and package-operation behavior.

## Callable plugin references

[`dsh-host-plugin-inventory`](../../packages/host/plugin-inventory/README.md) projects composition diagnostics and the current Agent's callable tool owners. `PluginInventorySnapshot` contains Loader entries and optional preset compositions; it grants no execution authority.

`PluginInstanceId` is the opaque identity of a module, Loader entry, and host or preset source. `PluginCapabilityId` identifies one tool within that owner. `PluginCapabilityCandidate` contains the identity, label, canonical mention, module/entry/preset display data, bounded `PluginToolCapability` summaries, and total `capabilityCount`; each tool summary includes its id, name, description, and native/PTC/both invocation mode. The original marker remains user text; separately recorded guidance carries attribution only. Availability is checked again on new submission and pre-step, not during history replay.

## Management records

`PluginEntryId` identifies one Loader entry; callers obtain it from `listPlugins` rather than constructing a patch id.

`PluginInfo` carries module identity, effective enablement, fiber phase and optional display `meta`, plus a unique `patchId` or a `readOnlyReason`.

`BundleInfo` carries the package name, optional installed version, selected enablement, removal availability and optional resolution error. Its optional `meta` and each `BundleRowInfo.meta` contain display text or a metadata diagnostic; Clients select a language at render time.

`InstallBundleOptions.enabled` defaults to true. False installs without selecting the bundle layer. `approvedBuilds` grants persistent script permission to the supplied pending package names before installation. `registry` names the registry asked first; absent, the configured one.

`BundleUpdateCheck` distinguishes an exact newer registry candidate from current, manual-source and refused results. It retains the current version and the checked source. `UpdateBundleOptions` requires `expectedVersion` and inherits request identity, registry and script approvals from installation options; it does not accept an enablement override.

`BundleInfo.pendingUpdate` identifies a prepared update by its `id` and target `version`; the installed `version` stays unchanged until restart applies it. `ChangeResult.stagedVersion` names a successfully prepared version. `discardBundleUpdate` checks that exact pending id before archiving it.

`PluginRegistries` carries the configured first registry, `null` for the one pnpm's own configuration names, the fallbacks asked after it, and `resolved`, the URL pnpm's own configuration names or `null` while unread. `InspectOptions.registry` names the registry a lookup asks first.

`ChangeResult.changed` reports a disk edit independently of `application`: `applied`, `restart-required`, `overridden` or `failed`. Optional `error` carries a localizable code and external diagnostic. `packageResult` records the pnpm exit code, bounded output, truncation flag and complete diagnostic log path, plus `timedOut` when the manager terminated a run that stopped printing. A terminated run is classified `timeout` whatever exit status the signal left behind, so installation and removal report failure instead of success and no further registry is asked. `pendingBuilds` lists undecided packages across the profile; `approvedBuilds` records the names granted permission by this operation; `registries` lists the registries an installation asked, in order; `failedAt` says whether the last failed run could not reach the registry it asked or the host a git or tarball spec is fetched from.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconfigeditor--configeditor"></a>

### `ctx.configEditor` — `ConfigEditor`

Persist complete raw configs and apply them through the normal Loader path.

```ts cordis-catalog
/** Addressable profile rows; nested Includes have independent configuration ownership.
 * @returns Active entries with unique profile patch ids.
 */
entries(): Entry[]

/** Read inherited and explicit profile values for the active entries.
 * @returns Detached layer values alongside their Loader entries.
 */
configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }>

/** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
 * @param entry Current Loader entry, also used to detect replacement during the write.
 * @param change Derive a raw config from the current entry and its inherited layer.
 * @returns Fulfillment after Loader reconciliation completes.
 */
async edit( entry: Entry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>, ): Promise<void>
```

Source: [`packages/boot/config-editor/src/index.ts`](../../packages/boot/config-editor/src/index.ts)

<a id="ctxhmr--hmr"></a>

### `ctx.hmr` — `Hmr`

Hot reload service with Cordis-compatible module configuration and events.

```ts cordis-catalog
/** Serialize a caller-owned mutation with all automatic reload paths.
 * @param operation Work that must not overlap module or configuration replacement.
 * @returns The operation result after its asynchronous work completes.
 */
runExclusive<T>(operation: () => Promise<T>): Promise<T>

/** Watch a configuration path through the same queue as module replacement.
 * @param filename Absolute path, which may not exist yet.
 * @param refresh Rebuilds configuration from its current files and awaits Loader completion.
 * @returns Disposer closing this registration and waiting for its pending refresh.
 */
async watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>>

/** Read direct module dependency URLs from the active Node loader.
 * @param url Module URL.
 * @returns Linked module URLs, or an empty list for an uncached module.
 */
async getLinked(url: string): Promise<string[]>
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="ctxplugininventory--plugininventorygateway"></a>

### `ctx.pluginInventory` — `PluginInventoryGateway`

Loader inventory and Agent-scoped callable-plugin discovery.

```ts cordis-catalog
/**
 * Read the Loader directly on every call. Cordis's internal plugin/status
 * events already maintain Entry.fiber and Fiber.state, so a second cache
 * would only add another lifecycle truth to keep synchronized.
 *
 * When an agent-preset roster is composed, the snapshot also carries each
 * preset's composition rows, because those rows — not the Loader's own
 * entries — are where a deployment that mounts the roster runs its
 * model-facing plugins.
 * @returns Current non-group Loader entries in Loader order, with optional display metadata
 * and per-preset compositions when a roster is composed.
 */
@Remote('list') async list(): Promise<PluginInventorySnapshot>

/**
 * List only currently callable plugin instances for a target Agent.
 * @param agent - target Agent resolved by the Remote's Session lookup.
 * @param query - case-insensitive module, title or tool-name substring.
 * @param signal - caller cancellation, checked before reading the catalog.
 * @returns bounded candidates with canonical mentions and execution modes.
 */
@Remote('candidates') async candidates(agent: Agent, query: string, signal: AbortSignal): Promise<PluginCapabilityCandidate[]>

/**
 * Resolve selected identities against the current Agent, without candidate pagination.
 * @param agent - target Agent entering the request.
 * @param ids - validated stable identities from direct user text.
 * @returns current summaries, in first-reference order.
 * @throws RemoteError when any referenced owner has no currently visible tools.
 */
resolveReferences(agent: Agent, ids: readonly PluginInstanceId[]): PluginCapabilityCandidate[]
```

Types: [Agent](core.md)

Source: [`packages/host/plugin-inventory/src/index.ts`](../../packages/host/plugin-inventory/src/index.ts)

<a id="ctxpluginmanager--pluginmanager"></a>

### `ctx.pluginManager` — `PluginManager`

Manage profile files and apply their declared reload lifecycle.

```ts cordis-catalog
/** Read exact plugin-version exemptions saved in this profile.
 * @returns Accepted package-name@version keys with the runtime versions they may run on, and any
 * record or file problem the reader rejected, which the caller reports instead of failing.
 */
@Remote listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] }

/** Grant or revoke one exact plugin/runtime exemption and reevaluate live plugins.
 * @param packageVersion Exact manifest package name followed by @ and its version; never an installation spec or alias.
 * @param runtimeVersion Exact current DSH version for grants; revocation may name a previous runtime.
 * @param enabled Whether to grant rather than revoke the exemption.
 * @param acceptRisk Required true for grants after the user accepts possible crashes and data loss.
 * @returns Saved and runtime outcomes. Startup-only profiles require restart.
 */
@Remote setVersionExemption(packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk?: boolean): Promise<ChangeResult>

/** Read current plugins, including why a row cannot be changed through the profile patch.
 * @returns Current runtime entries with persistent patch targets.
 */
@Remote async listPlugins(): Promise<PluginInfo[]>

/** Read the profile's installed bundles, the bundles this dsh installation supplies, and the selected names that are not bundles.
 * A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected.
 * @returns Package versions, manifest descriptions, rows, optional display metadata, activation selections,
 * whether the installation offers the bundle, and removal availability.
 */
@Remote async listBundles(): Promise<BundleInfo[]>

/** Read the registries this manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names.
 * @returns The registries in pnpm's comparison form; null is the one pnpm's own configuration names, `resolved` as pnpm reads it now.
 */
@Remote async registries(): Promise<PluginRegistries>

/** Read what a spec names before installing it.
 * @param spec One package spec: a registry name, an absolute path, a git address, or a tarball.
 * @param options The registry asked first.
 * @param signal Ends a registry lookup early.
 * @returns The package the spec names, or why it is refused.
 */
@Remote async inspect(spec: string, options?: InspectOptions, signal?: AbortSignal): Promise<PluginSpecInspection>

/** Check the selected bundle at its profile registry without installing or changing configuration.
 * @param name Profile-owned bundle package name.
 * @returns An exact newer registry spec, the current version, a manual source, or a refusal.
 */
@Remote async checkBundleUpdate(name: string): Promise<BundleUpdateCheck>

/** Inspect a replacement for one installed bundle; unresolved Git/tarball identity is checked after fetching.
 * @param name Exact installed target, never inferred from the replacement spec.
 * @param spec Replacement package spec.
 * @param options Registry selected by the caller; absence uses the profile registry.
 * @param signal Ends a registry lookup early.
 * @returns Accepted metadata or a different-package, non-update, or ordinary inspection refusal.
 */
@Remote async inspectBundleUpdate(name: string, spec: string, options?: InspectOptions, signal?: AbortSignal): Promise<PluginSpecInspection>

/** Prepare an isolated update for a profile-owned bundle, preserving its running version, selection and configuration.
 * @param name Exact installed bundle package name.
 * @param spec Replacement package spec, pinned for automatic registry updates.
 * @param options Expected installed version, request identity, script approvals and registry.
 * @returns Candidate diagnostics and stagedVersion after atomic pending publication; Desktop activates it only after a clean Host exit.
 */
@Remote updateBundle(name: string, spec: string, options: UpdateBundleOptions): Promise<ChangeResult>

/** Archive one still-pending update without changing the running dependency graph.
 * @param name Exact target package shown by listBundles.
 * @param expectedId Pending descriptor id shown by listBundles.
 * @returns Applied after the descriptor is archived; stale ids or an activation already started are refused.
 */
@Remote discardBundleUpdate(name: string, expectedId: string): Promise<ChangeResult>

/** Persist a plugin entry's desired enablement and apply it on live profiles.
 * @param id Loader entry identity returned by listPlugins.
 * @param enabled Whether the plugin should run.
 * @returns Saved and runtime outcomes, including higher-priority overrides.
 */
@Remote setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>

/** Select or remove a bundle layer while retaining installed dependencies.
 * @param name Bundle package name.
 * @param enabled Whether the bundle contributes its patch layer.
 * @returns Persisted and runtime outcomes.
 */
@Remote setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>

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
@Remote installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>

/** Recover the result of an active installation without cancelling it.
 * @param requestId The id supplied when installation started.
 * @returns The installation's outcome after it settles, or null if no active request has that id.
 * Completed results are not retained; null establishes neither success nor cancellation.
 */
@Remote async waitForInstall(requestId: PluginInstallRequestId): Promise<ChangeResult | null>

/** Stop an installation or update preparation this manager owns and await its cleanup.
 * @param requestId The id the installation was started with.
 * @returns `cancelled` after process exit and cleanup, `too-late` during activation or pending publication,
 * `not-running` for any other id, or `failed` when the operation could not clean up safely.
 */
@Remote async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation>

/** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path.
 * @param name Installed dependency name.
 * @returns Removal diagnostics and the remaining profile state.
 */
@Remote removeBundle(name: string): Promise<ChangeResult>
```

Source: [`packages/boot/plugin-manager/src/index.ts`](../../packages/boot/plugin-manager/src/index.ts)

<a id="ctxpluginreferenceresolver--pluginreferenceresolver"></a>

### `ctx.pluginReferenceResolver` — `PluginReferenceResolver`

Optional logged-message admission provider; its live service enables completion candidates.

```ts cordis-catalog
/**
 * Whether the owner still accepts references, including Loader disposal in progress.
 * @returns false as soon as Loader disables the owner or its Fiber stops being active.
 */
isAvailable(): boolean

/**
 * Validate a submitted reference before enqueue; pre-step repeats this check.
 * @param agent - target Agent whose current tools determine availability.
 * @param ids - identities recovered by the canonical parser.
 * @returns the selected live summaries; never executes or grants tool access.
 * @throws RemoteError when the resolver, any reference or the occurrence budget is unavailable.
 */
validate(agent: Agent, ids: readonly PluginInstanceId[]): PluginCapabilityCandidate[]
```

Types: [Agent](core.md)

Source: [`packages/host/plugin-inventory/src/reference-plugin.ts`](../../packages/host/plugin-inventory/src/reference-plugin.ts)

<a id="ctxpluginregistryprobe--pluginregistryprobe"></a>

### `ctx.pluginRegistryProbe` — `PluginRegistryProbe`

Compares public registry responses on the Host; the Client owns the initial selection.

```ts cordis-catalog
/**
 * Race npm and npmmirror HTTPS ping responses through the Host's fetch proxy.
 * Concurrent readers share a probe; a winner cancels and awaits the other request.
 * @returns the first registry with a successful response, or null when disabled or neither responds successfully; results are cached.
 * @throws rejects when the service has been unloaded.
 */
@Remote async fastest(): Promise<string | null>
```

Source: [`packages/client/ui-plugin-manager/src/index.ts`](../../packages/client/ui-plugin-manager/src/index.ts)

<a id="ctxprofilecontext--profilecontext"></a>

### `ctx.profileContext` — `ProfileContext`

Current profile facts; scheduling and mutation belong to their callers.

Source: [`packages/boot/app-boot/src/profile-context.ts`](../../packages/boot/app-boot/src/profile-context.ts)

<a id="app-boot-events"></a>

### `app-boot/*` events

<a id="app-bootconfig-reload--emit"></a>

#### `app-boot/config-reload` — emit

Profile patches were reconciled into the running Loader tree: every entry update settled and no new inactive entry was introduced. Carries no diff; listeners re-read Loader entries.

```ts cordis-catalog
/**
 * Profile patches were reconciled into the running Loader tree: every entry update settled and no new
 * inactive entry was introduced. Carries no diff; listeners re-read Loader entries.
 * @mode emit
 */
'app-boot/config-reload'(): void
```

Source: [`packages/boot/app-boot/src/index.ts`](../../packages/boot/app-boot/src/index.ts)

<a id="hmr-events"></a>

### `hmr/*` events

<a id="hmrchange--emit"></a>

#### `hmr/change` — emit

A watched file has no module or configuration handler.

```ts cordis-catalog
/** A watched file has no module or configuration handler.
 * @mode emit
 * @param url Canonical file URL.
 */
'hmr/change'(url: string): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="hmrreload--emit"></a>

#### `hmr/reload` — emit

Module replacements have finished loading.

```ts cordis-catalog
/** Module replacements have finished loading.
 * @mode emit
 * @param reloads Replaced plugins and their module locations.
 */
'hmr/reload'(reloads: Map<Plugin, Reload>): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="plugin-capabilities-events"></a>

### `plugin-capabilities/*` events

<a id="plugin-capabilitieschanged--emit"></a>

#### `plugin-capabilities/changed` — emit

Invalidate callable-plugin snapshots after registry or Loader lifecycle changes. This notification carries no capability data; consumers re-query their Agent.

```ts cordis-catalog
/**
 * Invalidate callable-plugin snapshots after registry or Loader lifecycle changes.
 * This notification carries no capability data; consumers re-query their Agent.
 * @mode emit
 */
'plugin-capabilities/changed'(): void
```

Source: [`packages/host/plugin-inventory/src/types.ts`](../../packages/host/plugin-inventory/src/types.ts)

<a id="plugin-manager-events"></a>

### `plugin-manager/*` events

<a id="plugin-managerchanged--emit"></a>

#### `plugin-manager/changed` — emit

The profile's plugins, bundles, or composition changed: a manager operation completed. A patch generation applied outside the manager, by HMR's watcher after a CLI or hand edit, announces nothing here.

```ts cordis-catalog
/**
 * The profile's plugins, bundles, or composition changed: a manager
 * operation completed. A patch generation applied outside the manager,
 * by HMR's watcher after a CLI or hand edit, announces nothing here.
 * @mode emit
 * @param change - what changed.
 */
'plugin-manager/changed'(change: PluginChange): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-log--emit"></a>

#### `plugin-manager/install-log` — emit

One chunk of a pnpm run's output, streamed as the run produces it.

```ts cordis-catalog
/**
 * One chunk of a pnpm run's output, streamed as the run produces it.
 * @mode emit
 * @param chunk - the chunk and the run it belongs to.
 */
'plugin-manager/install-log'(chunk: PluginInstallLogChunk): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-state--emit"></a>

#### `plugin-manager/install-state` — emit

An installation moved between its Host phases. `installing` is announced once per registry the installation asks, with the attempt's registry and position; `cancelling` and `applying` once.

```ts cordis-catalog
/**
 * An installation moved between its Host phases. `installing` is announced once per registry the
 * installation asks, with the attempt's registry and position; `cancelling` and `applying` once.
 * @mode emit
 * @param progress - the installation's request id and phase, with the attempt while installing.
 */
'plugin-manager/install-state'(progress: PluginInstallProgress): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)
<!-- END GENERATED cordis-surface -->
