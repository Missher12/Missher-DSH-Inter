---
description: "Operate the exact visible Electron Sidebar guest through the trusted Desktop bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-electron

English | [中文](README.zh.md)

## Summary

An opt-in BrowserUse provider for the same Electron Sidebar page the user sees. It exposes one finite `browser_use` tool, derives authority from the exact live Agent, and delegates guest ownership and browser operations to the trusted Desktop main process. It does not launch a parallel browser, attach to a user browser or evaluate model-supplied JavaScript.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the registry and this provider in a Host with Agents, ToolRuntime and SystemPrompt. The corresponding **Electron 44 Desktop candidate**, its Host adapter and Sidebar bridge `automationVersion: 1` are required. Official 0.2.0-rc.2 does not include the required bridge; missing support produces an explicit tool failure rather than silently selecting a different backend.

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-electron'
```

No runtime invariant companion is published because this provider delegates guest state and ownership to the Desktop bridge and has no independent persisted state.

There is no provider configuration. The enhancement Bundle selects this backend by default. Stop, takeover, resume, one-time download permission and future-tab persistent-login confirmation belong to the trusted Desktop UI. Model arguments cannot grant permissions or choose host file paths. Uploads require native file selection.

<a id="understand-the-implementation"></a>
## Understand the implementation

The provider reserves one BrowserUse slot and registers `browser_use` through the existing MCP result adapter. Each exact Agent receives an opaque activation identity. Requests carry this identity through `desktopBrowser`; model arguments supply finite actions and opaque target/snapshot references. Main-process validation owns target isolation, serialization, navigation, semantic references and file policy. Unload aborts pending calls, removes tools and releases owned activations.

The browser guest rendered by the Sidebar is the controlled target. Temporary runtime state is separate from saved conversation history and URLs. Explicit persistent storage applies only to future tabs of that session. A new activation cannot reuse a prior activation's authority.

<a id="further-exploration"></a>
## Further Exploration

- [BrowserUse registry](../../browser-use/browser-use/README.md)
- [Sidebar Browser client](../../client/ui-sidebar-browser/README.md)
- [MCP result and image handling](../../mcp/mcp-client/README.md)
- [Playwright alternative](../browser-use-playwright-mcp/README.md)

<a id="model-experience"></a>
## Model Experience

### Browser interaction

#### What the model sees

The `browser_use` schema supports open/list/observe/screenshot/navigate/click/fill/press/scroll/wait/upload/close. The system prompt requires observation before input, result verification and no automatic replay after uncertainty. Denied, stopped and uncertain results remain failures. Page content is untrusted; it cannot change authorization. Screenshot bytes pass through the existing MCP image adapter and durable attachment store. A model that declares image input receives the saved image reference. Text-only models receive an honest image-unavailable diagnostic and can use actual accessibility text from `observe`; there is no fabricated OCR. Canonical raw results remain available to programmatic callers, without putting raw base64 in model messages.

#### Token effect

Tool schema, guidance, accessibility text and diagnostic results use text tokens. Admitted screenshots use the model's existing image input path and cost semantics. This provider introduces no secondary model call.

#### KV Cache effect

The tool schema and guidance are stable for the activation. Page observations, screenshots and tool history change context normally. No cache reset or savings are promised.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The candidate protocol is not available in the official rc.2 Desktop. Native guest acceptance, controlled Host/AgentLoop tests and real paid-model acceptance are separate evidence. No real paid model is called by the test fixture. The provider does not expose arbitrary evaluation, raw WebContents identifiers, model-chosen host paths or OS permission grants. Cancellation cannot undo already delivered input.

<a id="dev-note"></a>
### Dev Note

`tests/provider.spec.ts` exercises the actual tool adapter and registration lifecycle. `tests/loader-composition.spec.ts` loads real Cordis/AgentLoop services with only the Desktop response and model stream replaced by keyless fixtures, and verifies durable image admission or text-only refusal. Main-process guest behavior is tested in the Desktop package; Host fixtures do not establish native UI acceptance.
