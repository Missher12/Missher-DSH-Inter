# 计算机操作

[English](computer-use.md) | 中文

计算机操作让模型通过配置的提供方观察并操作本地桌面。DSH 的共享能力称为 **computer use（计算机操作）**；**Cua Driver** 是上游实现的名称。

## 选择提供方

在同一组合中挂载 [`dsh-computer-use`](../../packages/computer-use/computer-use/README.zh.md) 和一个提供方。两个 Cua Driver 提供方都是公开发布到 npm 的实验性包，均需显式启用。

| 提供方 | 运行时 |
|---|---|
| [Cua Driver MCP](../../packages/experimental/computer-use-cua-driver-mcp/README.zh.md) | 通过 MCP 连接已安装的 `cua-driver` 可执行文件 |
| [Cua Driver 原生](../../packages/experimental/computer-use-cua-driver-native/README.zh.md) | 随 npm 依赖安装的平台原生运行时 |

各提供方提供上游工具目录。共享服务只注册名称，并拒绝任何第二个提供方，包括使用相同名称的另一个实例。服务不包含通用桌面操作方法或模型控制的选择器。

## 生命周期和桌面共享

提供方在关闭工具和自有资源期间保留注册。启动失败会释放此次尝试的注册。MCP 提供方在重连期间保留注册。

注册表本身不会预留桌面。原生候选提供方在其 Host 内为一个确切 Agent 预留完整的观察、操作和验证工作段；独立 DSH 进程、用户和其他应用不受此协调约束。每次输入消耗一次准确目标的新鲜观察。取消调用无法撤销桌面已收到的输入。

可选 `computerAuthorization` 适配器将 `ComputerAuthorizationRequest`、其 `ComputerActivationId` 和 SDK 摘要绑定到一次可信原生对话框。`ComputerAuthorizationDecision` 为允许、拒绝或取消，模型不能提供该决定。过期、取消、撤销及 Host 退出会使待批准请求失效。OS 权限检查使用 `prompt: false`；辅助功能或屏幕录制授权仍是独立的用户操作。固定版本原生提供方在接纳结果前识别明确的 SDK 拒绝，包括已知的 `isError=false` 结果；不把普通页面正文全局判为错误。

## 结果和平台要求

工具使用常规执行流程和 Session 日志。支持图像的模型路由在挂载附件存储时接收持久化截图；不支持图像的路由接收现有 MCP 图像诊断。提供方 README 负责说明安装、权限和平台限制。

[决策记录](../../.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.zh.md)解释只负责注册的服务和两个 Cua Driver 集成。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
