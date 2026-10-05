# Browser use

English | [中文](browser-use.zh.md)

Browser use lets a model inspect and operate web pages through a configured backend. DSH owns the task loop; the provider supplies browser operations and keeps browser state across turns of one live Session.

## Choose a provider

Mount [`dsh-browser-use`](../../packages/browser-use/browser-use/README.md) and one provider in the same composition. The existing upstream providers are experimental public npm packages; the Electron provider below is a local candidate. All require explicit activation and use Chromium.

| Provider | Integration |
|---|---|
| [Playwright MCP](../../packages/experimental/browser-use-playwright-mcp/README.md) | Playwright's browser-control MCP tools |
| [Chrome DevTools MCP](../../packages/experimental/browser-use-chrome-devtools-mcp/README.md) | Chrome DevTools inspection and control through MCP |
| [Stagehand](../../packages/experimental/browser-use-stagehand-native/README.md) | Native browser operations with AI-assisted actions, observation, and extraction |
| [Electron Sidebar](../../packages/experimental/browser-use-electron/README.md) | Exact visible guest control through the matching Desktop candidate |

The shared service registers only a name and rejects any second provider, including another instance with the same name. It has no common browser-operation methods, browser resources, or model-controlled selector. Provider configuration in a profile or preset selects launch or attachment for that activation.

## Session ownership

A launched browser belongs to the exact live Agent and Session that uses it. Calls across turns reuse that browser. Disposing the Session runtime closes its launched resources; reloading or forking a Session starts fresh browser state. Browser profiles and login state are not restored from the Session log.

An attached browser remains externally owned. The provider reserves it for one Session within that provider instance, preserves its existing browser state, and rejects simultaneous attachment by another Session. Teardown disconnects and leaves the external browser running. Separate DSH processes and other clients remain outside this reservation.

Provider shutdown stops tool admission and waits for owned work and resource cleanup before releasing the shared provider registration. Cancellation cannot undo a browser action already delivered.

## Visible control and recovery

The Electron provider exposes one `browser_use` tool and derives the owner from the live Agent. The optional `desktopBrowser` adapter accepts `DesktopBrowserRequest` and returns `DesktopBrowserResult`; the Desktop main process owns opaque guest leases, fresh snapshots and finite operations. It exposes no global debugging port. `browserInteraction` projects provider-owned stop, takeover and resume controls to trusted Desktop UI without adding methods to the provider registry.

`DesktopBrowserState.failure` optionally carries a bounded initialization `code` and `message`. State reads are valid for owned reservations before guest attachment. Failed or disconnected openings return `unavailable` with the diagnosis in `data.failure` and release the reservation; they do not return a usable target or replay input.

Independent Playwright browsers are visible when selected by the Computer Browser Bundle. The Sidebar provider operates the actual visible guest. Stop and takeover prevent queued actions; resume requires a fresh observation. Inputs already delivered cannot be undone or automatically retried. Changing providers requires unloading the old profile and restarting the selected composition.

Sidebar login storage is temporary by default. The user can opt the current Session into a managed persistent partition for newly opened tabs. Its cookies live below Electron userData, separate from external browsers. Restart restores only explicitly persisted login data and the existing Sidebar URL checkpoint; old Agent leases, snapshots and page execution state do not survive. Uninstall retains managed login data. Uploads use explicit native file selection; downloads require a one-transfer grant and a new destination, reject overwrites and symbolic links, and discard partial staging.

## MCP initialization

An MCP provider initializes one client for each live Agent created after the provider loads. The existing serial `agent/created` event awaits connection and discovery before creation or resume completes and queued input runs. The client remains with the Session across turns. Startup failure or cancellation rejects creation or resume and triggers client cleanup.

If an attachment is busy, that activation continues without the browser and does not retry on later turns. After release, a newly created or resumed activation can acquire it. Loading or reloading the provider does not adopt already active Sessions; the [shared runtime](../../packages/experimental/browser-use-runtime/README.md) owns these initialization rules.

## Tools and recorded results

Provider tools use the normal DSH execution pipeline and Session log. The providers own their tool schemas, result rendering, image support, configuration, and upstream limitations; the shared service adds no model-visible content. Stagehand's AI-assisted operations use its explicitly configured native model while DSH retains the task loop. DSH model routing, credential reuse, underlying inference request/response capture, and integration into Session usage accounting are deferred; returned SDK data and metadata remain ordinary logged tool results.

Browser MCP connections also expose [resources and server instructions](mcp.md). Resource calls addressed to a browser server use its Session queue and reject other Sessions; server instructions are assembled only for its owning Session.

The [decision record](../../.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.md) explains the registration-only service and per-Session ownership.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowserinteraction--browserinteractionregistry"></a>

### `ctx.browserInteraction` — `BrowserInteractionRegistry`

Optional trusted consumer; providers retain state and resource ownership.

```ts cordis-catalog
/**
 * Publish controls for one exact live activation, rejecting duplicate ownership.
 * @param agent - live owner whose identity must be checked by every consumer action.
 * @param control - provider controls, never exposed directly to model tool parameters.
 * @returns a disposer that removes only this registration.
 */
register(agent: Agent, control: BrowserInteractionController): () => void
```

Types: [Agent](core.md)

Source: [`packages/experimental/browser-use-runtime/src/control.ts`](../../packages/experimental/browser-use-runtime/src/control.ts)

<a id="ctxbrowseruse--browseruseregistry"></a>

### `ctx.browserUse` — `BrowserUseRegistry`

Owns one optional provider registration in the shared browser-use service.

```ts cordis-catalog
/**
 * Reserve the sole provider slot until the contribution is disposed.
 * A second registration fails even when it repeats the current name. Providers
 * must stop their tools and await owned work before releasing this registration.
 * @param name - provider-owned name used in registration diagnostics.
 * @returns the effect disposer for this exact registration.
 */
register(name: BrowserUseProviderName): () => Promise<void>
```

Source: [`packages/browser-use/browser-use/src/index.ts`](../../packages/browser-use/browser-use/src/index.ts)

<a id="ctxdesktopbrowser--desktopbrowserservice"></a>

### `ctx.desktopBrowser` — `DesktopBrowserService`

Trusted Host-to-Desktop adapter.

```ts cordis-catalog
/**
 * Execute one finite operation against the requesting activation's owned guest.
 * @param request - exact owner and finite operation.
 * @param signal - cancellation.
 * @returns observed result; dispatched input is never rolled back.
 */
request(request: DesktopBrowserRequest, signal: AbortSignal): Promise<DesktopBrowserResult>
```

Source: [`packages/browser-use/browser-use/src/desktop.ts`](../../packages/browser-use/browser-use/src/desktop.ts)
<!-- END GENERATED cordis-surface -->
