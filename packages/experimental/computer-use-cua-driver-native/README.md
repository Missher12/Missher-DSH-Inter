---
description: "Run Cua Driver computer-use tools from its native npm SDK, with durable screenshots and explicit host desktop permissions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-computer-use-cua-driver-native

English | [中文](README.zh.md)

## Summary

Use Cua Driver to inspect and operate desktop windows without installing its separate CLI or application. The native npm dependency runs inside the DSH host and exposes Cua Driver's own tools. Screenshots reach image-capable models through durable attachments. This published experimental package requires the launching host's desktop permissions and remains an explicit composition choice.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already supplies the live Agent registry, tool registry, and system prompt.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'
```

The provider loads the exact Cua Driver npm version declared in [package.json](package.json) and permits only the SDK standard permission mode. `browserTools` defaults to `true`; set it to `false` when a Browser Use provider owns browser interaction. This hides both typed browser tools and the legacy `page` tool; their executors also refuse while Browser Use is registered. `sessionTtlSeconds` defaults to `3600` and `idleTtlSeconds` to `600`; both accept integers from 1 to 86400, and the idle lifetime cannot exceed the session lifetime. Native import, runtime initialization, malformed catalog, duplicate tool name, or occupied computer-use registration failures reject activation and roll back owned resources. The registered provider name is `cua-driver-native`.

Use an attachment store and a model route that explicitly declares image input to receive screenshots. The [MCP result adapter](../../mcp/mcp-client/README.md) owns image admission and diagnostic behavior; programmatic callers retain the canonical raw result when a model cannot receive its images. Calls use Cua Driver's upstream tool parameters and results. Desktop observations and actions require an exact live Agent owner. A successful fresh snapshot of the same target precedes each window action; sending input consumes that observation, so the next action requires another snapshot.

### Host requirements

The native dependency supplies platform binaries through npm optional dependencies. Keep optional dependencies enabled. Grant desktop permissions to the application that launches DSH; this provider neither installs a permission-owning app nor changes OS grants. The native runtime shares the host process, so native crashes can terminate that process. Use the [installed MCP provider](../computer-use-cua-driver-mcp/README.md) when the separate Cua Driver application should own permissions and execution.

Existing-profile browser attachment uses the optional trusted `computerAuthorization` Desktop adapter. The adapter receives the exact SDK digest, expiry, and resource identity; these fields never enter model arguments or session logs. A missing adapter denies attachment. Denial or dismissal suppresses repeat requests for that resource until the user explicitly resumes control. Closing the SDK session revokes its grants; pending approvals cannot survive cancellation, expiry, takeover, or activation disposal. Permission queries always use `prompt: false`; a tool cannot request OS authorization.

### Verify the installed SDK

From the repository root, run this opt-in check against the installed native dependency. It discovers tools, reads permission status with `prompt: false`, and verifies teardown; it captures no screenshots, sends no input, and requests no OS permissions. Clearing `NODE_USE_ENV_PROXY` prevents Node from installing the launching shell's proxy before test setup.

```sh
env -u NODE_USE_ENV_PROXY DSH_COMPUTER_USE_NATIVE_E2E=1 node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts packages/experimental/computer-use-cua-driver-native/tests/native.e2e.ts
```

The separate [native window check](tests/native-window.mjs) requires explicit permission to create and control an account-free test window on macOS and a disposable Electron app under a temporary `dsh-cbu-*` directory. It temporarily replaces that app's fixture entry, restores it on exit, and deletes its temporary profile. This opt-in includes foreground input to that test window if independent read-back confirms background input had no effect. The script selects only its own PID and exact window, checks stale-token and unavailable-target refusals, and records the fixture's independent renderer read-back. It never requests OS permissions or opens existing browser profiles. This validates the native SDK separately from the Loader and model composition tests.

SDK session management, configuration writes, dependency installation, trajectory replay, and recording controls are Host responsibilities and are not exposed as model tools. Recording accepts unrestricted output directories and can capture the main display; its stop operation can affect another session. Replay cannot supply this provider's required fresh observation. The provider therefore excludes these tools rather than forwarding model-supplied authority or file paths.

```sh
DSH_COMPUTER_USE_NATIVE_ACTION_E2E=1 DSH_NATIVE_ELECTRON_APP=/tmp/dsh-cbu-fixture/Electron.app DSH_NATIVE_EVIDENCE_DIR=/tmp/dsh-cbu-evidence node packages/experimental/computer-use-cua-driver-native/tests/native-window.mjs
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider reserves the shared computer-use registration before loading native code. Each live Agent receives a separately bound SDK session. One Agent owns the complete desktop observation, action, and verification segment until its turn stops, control is transferred, or its activation is disposed. Calls within that segment are serialized; another Session is rejected as busy. A child plugin owns discovery, model tools, guidance, and the native runtime. The parent retains the registration until child teardown has removed tools, interrupted native calls and image-capability admission, awaited settlement, and completed native shutdown. Cancellation does not undo input already delivered to an application.

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Native runtime ownership, catalog validation, tool registration, and provider guidance |
| [src/sessions.ts](src/sessions.ts) | Activation authority, trusted authorization, desktop work segments, stop, and takeover |
| [src/results.ts](src/results.ts) | SDK-specific structured refusal classification |
| — | No runtime invariant companion is published; resource ownership has no independently observed state to compare. |

Tool definitions reuse the existing MCP result adapter. Cua Driver's JSON catalog determines the schemas; its raw result supplies canonical text, structured output, and image bytes. The computer-use service carries only the provider name and exclusive registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Computer-use service](../../computer-use/computer-use/README.md) — exclusive named registration.
- [MCP client](../../mcp/mcp-client/README.md) — shared result and image projection.
- [Cua Driver SDK](https://cua.ai/docs/reference/cua-driver/sdk-reference) — upstream runtime API and host facilities.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The provider contributes the following computer-use guidance while its native tools are mounted.

##### Native Cua Driver guidance

```markdown
Cua Driver native computer-use tools operate the host desktop. Discover the exact app and window, then get a fresh window snapshot before acting. Use element_token from that snapshot, or coordinates from its screenshot. A new snapshot of that window invalidates its earlier element tokens. Select either target or the legacy pid/window_id fields; do not combine them.

Prefer background delivery. A refusal does not authorize a foreground retry. Verify the requested outcome from fresh state after an action; a delivered click alone does not prove the outcome. After cancellation, inspect current state before retrying because completed input is not rolled back. A desktop work segment belongs to one live session until its turn stops; other sessions cannot interleave native calls. After a user stop or takeover, only the user can resume control and a fresh window snapshot is required. This coordinates this Host only; the user and other applications can still change the desktop.

On macOS, cursor-overlay operations may return facility_unavailable even when screenshots and input work.
```

#### Token effect

This fixed guidance adds system-prompt tokens while the provider is mounted. Upstream guidance resources are not automatically loaded.

#### KV Cache effect

The unchanged guidance preserves its repeated prompt prefix. Mounting, removing, or editing it changes that prefix and can reduce cache reuse.

### Discovered Cua Driver tools and results

#### What the model sees

Tools use the `cua_driver_native__` prefix followed by the upstream name and retain the upstream descriptions and input schemas. SDK error codes and `ActionEffect.Refused` become tool errors even when the upstream envelope says `isError: false`. The pinned SDK also has one exact `get_browser_state` consent-message fallback; ordinary page text is never searched for refusal words. Supported screenshots appear as durable image references beside result text. Successful canonical raw results remain available to programmatic callers; `CuaDriverRefusalError.rawResult` retains the original envelope for direct same-process callers, while the shared ToolRuntime failure format intentionally carries no raw value.

#### Token effect

The discovered catalog adds tool definitions to each request. Accessibility trees, result text, and admitted screenshots add per-call context. Raw base64 remains in execution-local canonical values and is not copied into model history.

#### KV Cache effect

An unchanged catalog preserves its tool-definition prefix. Tool results append to Session history. Replacing the provider or its catalog changes the model-visible tools and can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The package preserves the upstream driver's platform and application limits.

- **Host permissions and graphics session** — npm installation does not grant desktop access or create a graphical session.
- **Native cursor overlay** — a headless macOS Node host can receive `facility_unavailable` for overlay operations while screenshots and background input remain usable.
- **Shared desktop** — coordination covers this Provider in one Host. Users, other applications, and other DSH processes can still alter the desktop. Native input must not target a browser already controlled through Browser Use; browser-specific Cua tools reject when a Browser Use provider is registered.
- **Cancellation** — an aborted call can have delivered input already. A trusted user must resume stopped control; then inspect fresh state before retrying. The provider waits for SDK shutdown during unload but does not promise native action rollback.
- **Failed shutdown** — if native shutdown fails, the registration remains occupied. Restart the host before mounting another computer-use provider.
- **Authorization and native acceptance** — offline tests verify decisions and lifecycle. The permission smoke checks discovery, promptless permissions, session binding, and shutdown. The separate opt-in window check records actual SDK input and independent fixture read-back; an unconfirmed background route is not counted as successful input. Neither test grants access or inspects an existing browser profile.
- **Experimental release** — tool schemas follow the pinned upstream SDK and have no DSH stability promise.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
