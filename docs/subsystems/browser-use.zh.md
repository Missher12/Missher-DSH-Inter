# 浏览器操作

[English](browser-use.md) | 中文

浏览器操作让模型通过配置的后端检查与操作网页。DSH 拥有任务循环；提供方提供浏览器操作，并在一个实时 Session 的多个轮次之间保留浏览器状态。

## 选择提供方

在同一组合中挂载 [`dsh-browser-use`](../../packages/browser-use/browser-use/README.zh.md) 和一个提供方。既有上游提供方是实验性公共 npm 包；下列 Electron 提供方是本地候选。所有提供方均需显式激活，并使用 Chromium。

| 提供方 | 集成方式 |
|---|---|
| [Playwright MCP](../../packages/experimental/browser-use-playwright-mcp/README.zh.md) | Playwright 的浏览器控制 MCP 工具 |
| [Chrome DevTools MCP](../../packages/experimental/browser-use-chrome-devtools-mcp/README.zh.md) | 通过 MCP 进行 Chrome DevTools 检查与控制 |
| [Stagehand](../../packages/experimental/browser-use-stagehand-native/README.zh.md) | 原生浏览器操作，支持 AI（人工智能）辅助的动作、观测与提取 |
| [Electron 侧栏](../../packages/experimental/browser-use-electron/README.zh.md) | 通过配套 Desktop 候选控制准确的可见 guest |

共享服务只注册名称，并拒绝任何第二次提供方注册，包括同名实例。它不包含通用浏览器操作方法、浏览器资源或模型控制的选择器。Profile 或 preset 中的提供方配置为此次激活选择启动或附加模式。

## Session 所有权

启动的浏览器属于使用它的确切实时 Agent 与 Session。跨轮次的调用复用该浏览器。Session 运行时释放时关闭其启动的资源；重新加载或 fork Session 时创建全新浏览器状态。浏览器 profile 和登录状态不会从 Session 日志恢复。

附加的浏览器仍归外部所有。提供方在该提供方实例内将浏览器保留给一个 Session，保留现有浏览器状态，并拒绝另一个 Session 同时附加。清理会断开连接并保持外部浏览器运行。独立 DSH 进程与其他客户端不受此保留约束。

提供方关闭时先停止接收工具调用，并等待自有工作与资源清理完成，再释放共享提供方注册。取消无法撤销已交付的浏览器操作。

## 可见控制与恢复

Electron 提供方提供一个 `browser_use` 工具，并从实时 Agent 派生所有者。可选 `desktopBrowser` 适配器接收 `DesktopBrowserRequest` 并返回 `DesktopBrowserResult`；Desktop 主进程拥有不透明 guest lease、新鲜快照与有限操作。它不开放全局调试端口。`browserInteraction` 将提供方拥有的停止、接管及恢复控制投影到可信 Desktop UI，不向提供方注册表添加操作方法。

`DesktopBrowserState.failure` 可携带有界的初始化错误 `code` 与 `message`。所属预约尚未挂载 guest 时也可读取状态。初始化失败或开页前已断开的请求返回 `unavailable`，在 `data.failure` 中给出诊断并释放预约，不返回可操作目标或重放输入。

Computer Browser Bundle 选择的独立 Playwright 浏览器可见。侧栏提供方操作真实可见的 guest。停止与接管阻止排队动作；恢复后必须重新观察。已投递输入不能撤销或自动重试。切换提供方必须卸载原 profile 的组合并重启选定组合。

侧栏登录环境默认为临时存储。用户可为当前 Session 明确选择托管持久 partition，用于随后新开的标签页。cookie 位于 Electron userData 下，与外部浏览器分离。重启只恢复明确持久化的登录数据与既有侧栏 URL 检查点；旧 Agent lease、快照和页面运行状态不会恢复。卸载保留托管登录数据。上传使用原生文件明确选择；下载需要单次许可与新保存位置，拒绝覆盖和符号链接，并清理未完成的暂存文件。

## MCP 初始化

MCP 提供方为其加载后创建的每个活动 Agent 初始化一个客户端。现有的串行 `agent/created` 事件等待连接和发现结束后，创建或恢复才完成，排队输入才开始运行。客户端跨轮次归 Session 所有。启动失败或取消会拒绝创建或恢复，并触发客户端清理。

如果附加连接已被占用，本次激活不使用浏览器，但继续运行，后续轮次不会重试。连接释放后，新创建或恢复的激活可以获取它。加载或重新加载提供方不会接管已经活动的 Session；[共享运行时](../../packages/experimental/browser-use-runtime/README.zh.md)拥有这些初始化规则。

## 工具与记录结果

提供方工具使用常规 DSH 执行管线与 Session 日志。提供方拥有自己的工具 schema、结果渲染、图像支持、配置和上游限制；共享服务不添加模型可见内容。Stagehand 的 AI 辅助操作使用其显式配置的原生模型，DSH 保留任务循环。DSH 模型路由、凭据复用、底层推理请求/响应捕获，以及与 Session 用量计量的集成均属暂缓工作；返回的 SDK 数据和元数据仍作为普通工具结果记录。

浏览器 MCP 连接还提供[资源和服务器指令](mcp.zh.md)。发往浏览器服务器的资源调用使用其 Session 队列，并拒绝其他 Session 的请求；服务器指令只会组装到所属 Session 的提示词中。

[决策记录](../../.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.zh.md)解释只注册名称的服务与按 Session 管理的所有权。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

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
