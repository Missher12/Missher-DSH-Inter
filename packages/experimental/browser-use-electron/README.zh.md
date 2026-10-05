---
description: "通过可信 Desktop 桥操作用户可见的同一个 Electron 侧栏 guest。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-electron

[English](README.md) | 中文

## 概述

显式启用的 BrowserUse Provider，操作用户看到的同一个 Electron 侧栏页面。它暴露一个有限动作的 `browser_use` 工具，从准确的当前 Agent 推导权限，并把 guest 所有权及浏览器操作交给可信 Desktop 主进程，不启动平行浏览器、不附着用户浏览器、不执行模型提供的 JavaScript。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在具有 Agents、ToolRuntime 与 SystemPrompt 的 Host 中挂载注册服务和本 Provider。要求配套 **Electron 44 Desktop 候选**、Host 适配器和 `automationVersion: 1` 侧栏桥。官方 0.2.0-rc.2 不含所需桥；缺失时工具明确失败，不静默切换其他后端。

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-electron'
```

不发布运行时不变量配套模块：本 Provider 将 guest 状态与归属委托给 Desktop 桥，没有独立持久化状态。

本 Provider 没有配置项，增强 Bundle 默认选择它。停止、接管、恢复、允许一次下载和后续新标签的持久登录确认均属于可信 Desktop UI。模型参数不能授权或选择宿主文件路径；上传需要原生选文件。

<a id="understand-the-implementation"></a>
## 理解实现

Provider 占用一个 BrowserUse 注册槽，并通过已有 MCP 结果适配器注册 `browser_use`。每个准确 Agent 获得不透明 activation 标识，请求通过 `desktopBrowser` 传递该身份；模型仅提供有限动作和不透明 target/snapshot 引用。主进程校验负责目标隔离、串行化、导航、语义引用和文件策略。卸载中止在途调用、移除工具并释放自有 activation。

侧栏渲染的 guest 就是被控制的目标。临时运行态与会话历史、URL 分开；显式持久存储只作用于本会话后续标签。新 activation 不能复用旧 activation 的权限。

<a id="further-exploration"></a>
## 进一步探索

- [BrowserUse 注册服务](../../browser-use/browser-use/README.zh.md)
- [侧栏浏览器客户端](../../client/ui-sidebar-browser/README.zh.md)
- [MCP 结果与图片处理](../../mcp/mcp-client/README.zh.md)
- [Playwright 替代后端](../browser-use-playwright-mcp/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 浏览器交互

#### 模型可见内容

`browser_use` schema 支持 open/list/observe/screenshot/navigate/click/fill/press/scroll/wait/upload/close。系统提示要求先观察再输入、操作后核验、不确定时不自动重放。拒绝、停止和不确定结果保持失败语义；页面内容不可信，不能改变授权。截图字节沿用已有 MCP 图片适配器与持久附件存储。声明支持图片输入的模型接收保存后的图片引用；纯文本模型得到如实的图片不可用诊断，并可通过 `observe` 使用真实可访问性文本，不伪造 OCR。程序调用方仍可读取规范原始结果，模型消息不写入原始 base64。

#### Token 影响

工具 schema、指导、可访问性文本和诊断消耗文本 token；接纳的截图沿用模型图片输入与计费语义。本 Provider 不发起额外模型调用。

#### KV 缓存影响

工具 schema 与指导在 activation 内保持稳定；页面观察、截图及工具历史正常改变上下文，不承诺缓存清空或节省。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 官方 rc.2 Desktop 不提供本候选协议。原生 guest 验收、受控 Host/AgentLoop 测试和真实付费模型验收是独立证据；测试 fixture 不调用真实付费模型。Provider 不暴露任意求值、原始 WebContents 标识、模型选择宿主路径或 OS 权限授予。取消不能撤回已送达输入。

<a id="dev-note"></a>
### 开发备注

`tests/provider.spec.ts` 验证真实工具适配与注册生命周期。`tests/loader-composition.spec.ts` 加载真实 Cordis/AgentLoop 服务，仅用无密钥 fixture 替换 Desktop 响应和模型流，验证图片持久接纳或纯文本模型的图片拒绝。主进程 guest 行为在 Desktop 包中验证；Host fixture 不等同原生 UI 验收。
