# Computer use

English | [中文](computer-use.zh.md)

Computer use lets a model observe and operate the local desktop through a configured provider. The shared DSH capability is called **computer use**; **Cua Driver** names the upstream implementation.

## Choose a provider

Mount [`dsh-computer-use`](../../packages/computer-use/computer-use/README.md) and one provider in the same composition. Both Cua Driver providers are experimental public npm packages and require explicit activation.

| Provider | Runtime |
|---|---|
| [Cua Driver MCP](../../packages/experimental/computer-use-cua-driver-mcp/README.md) | An already installed `cua-driver` executable connected through MCP |
| [Cua Driver native](../../packages/experimental/computer-use-cua-driver-native/README.md) | The platform-native runtime installed with the npm dependency |

Each provider supplies its upstream tool catalog. The shared service registers only a name and rejects any second provider, including another instance with the same name. It has no common desktop-operation methods or model-controlled selector.

## Lifetime and desktop sharing

A provider retains its registration while it shuts down its tools and owned resources. Startup failure releases the attempted registration. The MCP provider keeps its registration during reconnects.

The registry itself does not reserve the desktop. The native candidate provider reserves complete observe, act and verify work segments for one exact Agent within its Host; separate DSH processes, users and other applications remain outside that coordination. Every input consumes a fresh target observation. A cancelled call cannot undo input that the desktop already received.

The optional `computerAuthorization` adapter binds `ComputerAuthorizationRequest`, its `ComputerActivationId` and SDK digest to one trusted native dialog. `ComputerAuthorizationDecision` is allow, deny or cancel; models cannot supply it. Expiry, cancellation, revocation and Host exit invalidate pending approvals. OS permission checks use `prompt: false`; granting accessibility or screen recording permissions remains a separate user operation. The pinned native provider classifies explicit SDK refusals before admitting results, including known `isError=false` envelopes; ordinary page text is not globally classified as an error.

## Results and platform requirements

Tools use the normal execution pipeline and Session log. Image-capable model routes with an attachment store receive durable screenshots; unsupported image routes receive the existing MCP image diagnostic. Provider READMEs own installation, permission, and platform limitations.

The [decision record](../../.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.md) explains the registration-only service and the two Cua Driver integrations.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputerauthorization--computerauthorization"></a>

### `ctx.computerAuthorization` — `ComputerAuthorization`

Trusted Host-to-Desktop adapter; it is independent of provider registration.

```ts cordis-catalog
/**
 * Ask the user about exactly one attested browser/profile attachment.
 * @param request - SDK digest, expiry, activation, and trusted display fields.
 * @param signal - cancellation invalidates any late approval.
 * @returns a single decision; dismissal, expiry, and cancellation never allow.
 */
request(request: ComputerAuthorizationRequest, signal: AbortSignal): Promise<ComputerAuthorizationDecision>

/**
 * Cancel pending requests for an activation; native grants are revoked by SDK session close.
 * @param activationId - exact Host-lifetime activation being retired.
 * @returns after the adapter can no longer approve its pending requests.
 */
revoke(activationId: ComputerActivationId): Promise<void>
```

Source: [`packages/computer-use/computer-use/src/authorization.ts`](../../packages/computer-use/computer-use/src/authorization.ts)

<a id="ctxcomputeruse--computeruseregistry"></a>

### `ctx.computerUse` — `ComputerUseRegistry`

Owns one optional provider registration in the shared computer-use service.

```ts cordis-catalog
/**
 * Reserve the sole provider slot until the contribution is disposed.
 * A second registration fails even when it repeats the current name. Providers
 * must stop their tools and await owned work before releasing this registration.
 * @param name - provider-owned name used in registration diagnostics.
 * @returns the effect disposer for this exact registration.
 */
register(name: ComputerUseProviderName): () => Promise<void>
```

Source: [`packages/computer-use/computer-use/src/index.ts`](../../packages/computer-use/computer-use/src/index.ts)
<!-- END GENERATED cordis-surface -->
