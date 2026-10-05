---
description: "通过原生 npm SDK 运行 Cua Driver 的电脑操作工具，持久化截图，并明确主机桌面权限要求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-computer-use-cua-driver-native

[English](README.md) | 中文

## 概述

使用 Cua Driver 检查和操作桌面窗口，无需安装其独立 CLI 或应用。原生 npm 依赖在 DSH 主机进程内运行，提供 Cua Driver 自己的工具。截图通过持久化附件传给支持图像的模型。此实验性软件包会发布到 npm，需要启动主机的桌面权限，并且必须在组合配置中显式启用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已经提供活动 Agent 注册表、工具注册表和系统提示词的组合中挂载此提供者。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'
```

此提供者加载 [package.json](package.json) 声明的确切 Cua Driver npm 版本，只允许 SDK 的标准权限模式。`browserTools` 默认为 `true`；使用 Browser Use 提供者时设为 `false`，同时隐藏 typed browser 工具与旧 `page` 工具；注册了 Browser Use 时，这些工具的执行器也拒绝访问。`sessionTtlSeconds` 默认为 `3600`，`idleTtlSeconds` 默认为 `600`；两者接受 1 至 86400 的整数，空闲有效期不能大于会话有效期。原生模块导入、运行时初始化、目录格式、工具重名或电脑操作注册冲突会使激活失败，并回滚所拥有的资源。注册的提供者名称为 `cua-driver-native`。

挂载附件存储并使用明确声明支持图像输入的模型路由，才能接收截图。[MCP 结果适配器](../../mcp/mcp-client/README.zh.md) 负责图像接纳和诊断行为；模型无法接收图像时，程序调用方仍保留规范原始结果。调用采用 Cua Driver 上游的工具参数和结果。桌面观察与操作需要准确的活动 Agent 所有者。每次窗口动作前必须成功获取同一目标的新快照；发送输入会消耗这次观察，因此下次动作需要再次获取快照。

### 主机要求

原生依赖通过 npm 可选依赖提供各平台二进制文件，因此必须保留可选依赖安装。请向启动 DSH 的应用授予桌面权限；此提供者既不安装独立持有权限的应用，也不更改操作系统授权。原生运行时与主机共享进程，因此原生崩溃可能终止该进程。如果需要由独立的 Cua Driver 应用持有权限并执行操作，请使用[已安装的 MCP 提供者](../computer-use-cua-driver-mcp/README.zh.md)。

既有浏览器 profile 接入使用可选的可信 `computerAuthorization` Desktop 适配器。适配器接收 SDK 的准确摘要、到期时间和资源身份；这些字段不进入模型参数或会话日志。缺少适配器时拒绝接入。拒绝或关闭对话框后，不会重复申请同一资源，直到用户明确恢复控制。关闭 SDK 会话撤销其授权；待决批准不能在取消、到期、接管或激活实例销毁后生效。权限查询始终使用 `prompt: false`；工具不能申请操作系统授权。

### 验证已安装的 SDK

在仓库根目录运行这项显式启用的检查，验证已安装的原生依赖。它发现工具、通过 `prompt: false` 读取权限状态，并验证卸载；它不截图、不发送输入，也不请求操作系统权限。清除 `NODE_USE_ENV_PROXY` 可防止 Node 在测试初始化之前采用启动 shell 的代理设置。

```sh
env -u NODE_USE_ENV_PROXY DSH_COMPUTER_USE_NATIVE_E2E=1 node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts packages/experimental/computer-use-cua-driver-native/tests/native.e2e.ts
```

独立的[原生窗口检查](tests/native-window.mjs)需要明确获准在 macOS 创建并控制不含账号的测试窗口，并准备位于临时 `dsh-cbu-*` 目录下的可丢弃 Electron 应用。脚本暂时替换该应用的 fixture 入口，退出时恢复入口并删除临时 profile。此 opt-in 包含以下范围：独立读回确认后台输入没有效果后，可以对该测试窗口发送前台输入。脚本只选择自己的 PID 和精确窗口，检查过期令牌及不可用目标的拒绝，并记录 fixture 渲染器的独立读回。它不请求 OS 权限，也不打开既有浏览器 profile。此项单独验证原生 SDK，与 Loader 和模型组合测试分开报告。

SDK 会话管理、配置写入、依赖安装、轨迹重放及录制控制归 Host 管理，不作为模型工具暴露。录制接受不受限的输出目录并可捕获主显示器，其停止操作也可影响其他会话；轨迹重放不能满足此提供者要求的新鲜观察。因此提供者排除这些工具，不转发模型指定的授权或文件路径。

```sh
DSH_COMPUTER_USE_NATIVE_ACTION_E2E=1 DSH_NATIVE_ELECTRON_APP=/tmp/dsh-cbu-fixture/Electron.app DSH_NATIVE_EVIDENCE_DIR=/tmp/dsh-cbu-evidence node packages/experimental/computer-use-cua-driver-native/tests/native-window.mjs
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

此提供者在加载原生代码前占用共享电脑操作注册名额。每个活动 Agent 绑定独立的 SDK 会话。一个 Agent 持有完整的桌面观察、动作和验证工作段，直到回合结束、控制权交接或该激活实例销毁。工作段内的调用串行执行；其他 Session 会收到占用拒绝。子插件拥有目录发现、模型工具、指导文本和原生运行时。父插件保留注册名额，直到子插件卸载完成工具移除、中断原生调用和图像能力准入、等待调用结束及原生关闭。取消不会撤销已经传给应用的输入。

| 文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 原生运行时所有权、目录校验、工具注册和提供者指导文本 |
| [src/sessions.ts](src/sessions.ts) | 激活实例权限、可信授权、桌面工作段、停止和接管 |
| [src/results.ts](src/results.ts) | SDK 专用的结构化拒绝分类 |
| — | 不发布运行时不变量伴随模块；资源所有权没有可独立观测并比较的状态。 |

工具定义复用现有 MCP 结果适配器。Cua Driver 的 JSON 目录决定 schema，其原始结果提供规范文本、结构化输出和图像字节。电脑操作服务只保存提供者名称并保证独占注册。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [电脑操作服务](../../computer-use/computer-use/README.zh.md)——独占的具名注册。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md)——共享结果与图像投影。
- [Cua Driver SDK](https://cua.ai/docs/reference/cua-driver/sdk-reference)——上游运行时 API 和主机能力。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

在原生工具挂载期间，此提供者加入以下电脑操作指导文本。

##### 原生 Cua Driver 指导文本

```markdown
Cua Driver native computer-use tools operate the host desktop. Discover the exact app and window, then get a fresh window snapshot before acting. Use element_token from that snapshot, or coordinates from its screenshot. A new snapshot of that window invalidates its earlier element tokens. Select either target or the legacy pid/window_id fields; do not combine them.

Prefer background delivery. A refusal does not authorize a foreground retry. Verify the requested outcome from fresh state after an action; a delivered click alone does not prove the outcome. After cancellation, inspect current state before retrying because completed input is not rolled back. A desktop work segment belongs to one live session until its turn stops; other sessions cannot interleave native calls. After a user stop or takeover, only the user can resume control and a fresh window snapshot is required. This coordinates this Host only; the user and other applications can still change the desktop.

On macOS, cursor-overlay operations may return facility_unavailable even when screenshots and input work.
```

#### Token 影响

提供者挂载期间，这段固定指导文本增加系统提示词 token。上游指导资源不会自动加载。

#### KV Cache 影响

指导文本不变时，其重复提示词前缀保持稳定。挂载、移除或编辑它会改变此前缀，并可能减少缓存复用。

### 发现的 Cua Driver 工具与结果

#### 模型看到什么

工具名称使用 `cua_driver_native__` 前缀并附加上游名称，保留上游描述和输入 schema。即使上游信封为 `isError: false`，SDK 错误码和 `ActionEffect.Refused` 也会转为工具错误。锁定 SDK 还使用一条完整精确的 `get_browser_state` 授权技术文本兜底；不会搜索普通页面中的拒绝词语。支持的截图作为持久化图像引用出现在结果文本旁。成功时程序调用方仍可读取规范原始结果；`CuaDriverRefusalError.rawResult` 为进程内直接调用者保留原始信封，而共享 ToolRuntime 失败格式按既有约定不携带原始值。

#### Token 影响

发现的目录为每个请求加入工具定义。无障碍树、结果文本和获准接纳的截图增加每次调用的上下文。原始 base64 保留在执行期间的规范值中，不复制到模型历史。

#### KV Cache 影响

目录不变时，工具定义前缀保持稳定。工具结果追加到 Session 历史。替换提供者或其目录会改变模型可见工具，并可能减少前缀复用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

此软件包保留上游驱动的平台和应用限制。

- **主机权限与图形会话**——npm 安装不会授予桌面访问权限或创建图形会话。
- **原生光标覆盖层**——无界面的 macOS Node 主机可能对覆盖层操作返回 `facility_unavailable`，同时截图和后台输入仍可用。
- **共享桌面**——协调仅覆盖同一 Host 的此提供者。用户、其他应用和其他 DSH 进程仍可改变桌面。原生输入不得操作已经由 Browser Use 控制的浏览器；注册了 Browser Use 提供者时，Cua 浏览器专用工具拒绝执行。
- **取消**——被取消的调用可能已经传入输入。停止后需要可信用户恢复控制，重试前必须检查新状态。卸载时提供者等待 SDK 关闭，但不承诺回滚原生操作。
- **关闭失败**——如果原生关闭失败，注册名额保持占用。挂载其他电脑操作提供者之前必须重启主机。
- **授权与原生验收**——离线测试验证决策和生命周期。权限冒烟检查目录发现、无提示权限读取、会话绑定与关闭。独立 opt-in 窗口检查记录真实 SDK 输入和 fixture 独立读回；未确认的后台路线不计为输入成功。两种测试均不授予访问，也不读取既有浏览器 profile。
- **实验性发布**——工具 schema 跟随锁定的上游 SDK，不作 DSH 稳定性承诺。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
