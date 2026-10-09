# Missher DeepSeek Harness Desktop

[English](README.md) | 中文

这是一个可以连接 AI 模型、操作项目文件、调用工具并安装扩展的桌面应用。本仓库维护 **Missher 社区版 DeepSeek Harness**。普通用户下载下面对应系统的安装包即可，不需要学习编译源码。

应用不附带模型账号或 API 额度，安装后需配置自己的模型服务。桌面安装包、插件源码和个人数据分别管理；下载本仓库不会带走他人的聊天、密钥或学习记录。

<a id="downloads"></a>

## 下载安装

Intel 芯片的 Mac 选择 **Intel Mac**；使用 Intel/AMD 64 位处理器的 Ubuntu 电脑选择 **Ubuntu x64**。Intel 是处理器名称，旧仓库曾写成 Inter。本页安装包不包含 Apple Silicon 原生版或 Linux ARM 版。

| 电脑 | 下载 | 适用范围 |
| --- | --- | --- |
| **Intel Mac** | [DMG 安装包](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/releases/download/desktop-v0.2.0-rc.2-missher.20261009.1/missher-deepseek-harness-0.2.0-rc.2-20261009-mac-x64.dmg) · [版本说明](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/releases/tag/desktop-v0.2.0-rc.2-missher.20261009.1) | Intel Mac；社区未公证包 |
| **Ubuntu x64** | [DEB 安装包（推荐）](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/releases/download/desktop-v0.2.0-rc.2-missher.20261009.1/deepseek-harness-0.2.0-rc.2-linux-amd64-unsigned.deb) · [版本说明](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/releases/tag/desktop-v0.2.0-rc.2-missher.20261009.1) | Ubuntu 24.04 x64 |
| **Ubuntu x64 便携格式** | [AppImage](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/releases/download/desktop-v0.2.0-rc.2-missher.20261009.1/deepseek-harness-0.2.0-rc.2-linux-x86_64-unsigned.AppImage) | 已构建；未单独完成 AppImage 启动验收 |

本次发行包含归档删除、模型行内设置和浏览器集成所需的 Missher 宿主扩展。请另外安装[配套插件合集](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/releases/download/desktop-v0.2.0-rc.2-missher.20261009.1/missher-dsh-plugins-20261009.zip)中的独立插件；精确版本和校验值见[包清单](distribution/plugin-set.json)。宿主基础版本为 0.2.0-rc.2，官方 0.2.1-alpha.1 属于尚未验收的另一轮迁移。

每个发布页提供 SHA-256 校验文件和验证范围，[全部发布记录](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/releases)保留早期安装包。GitHub 的 **Code → Download ZIP** 下载的是源码，不能代替安装包。这些社区包尚未配置自动安装更新源。

### Intel Mac 安装

1. 下载上面的 DMG 并打开，把 **DeepSeek Harness.app** 拖进 **Applications（应用程序）**。
2. 替换已有应用前先正常退出，保留数据和旧应用备份，确认新版正常后再处理备份。
3. 从应用程序中打开。如果 macOS 拦截此社区未公证包，先核对来源与校验值，再在 **系统设置 → 隐私与安全性** 中对该应用单独允许打开；无需关闭系统整体安全检查。

社区 Intel 版沿用独立的 `~/Library/Application Support/DeepSeek Harness Intel` 数据目录。替换应用本体不会复制或重置其中的插件配置、会话与凭据。

### Ubuntu 安装

下载 `.deb` 后，在下载文件所在目录打开终端，运行：

```bash
sudo apt install ./deepseek-harness-0.2.0-rc.2-linux-amd64-unsigned.deb
```

安装后在应用菜单中打开 **DeepSeek Harness**。DEB 已在 Ubuntu 24.04 完成安装及 Xvfb 下的 Electron 窗口启动验证；这证明应用能启动，不代表每种模型或插件流程都已验收。

### 第一次打开

1. 选择一个项目文件夹作为工作区。如果系统没有可用的“文档”目录，手动选择文件夹即可。
2. 打开模型设置，填入自己的服务商、地址、API Key 和模型名称；文本、图片与思考档位取决于模型实际能力。
3. 发一条简单消息检查服务是否可用，模型调用费用由所使用的服务商计算。
4. 解压配套插件合集，通过 **插件 → 添加插件** 逐个安装所需 `.tgz`。已有插件在版本旁检查更新，按提示选择新版包，准备好后等任务结束再正常重启；对照清单检查显示版本。桌面安装包不会自动安装个人插件。

## 独立插件：按需要选择

本页集中展示当前开发的插件。每一行都能跳转到插件自己的 GitHub。各仓库 README 说明安装方法、应用内入口、设置与限制，并能返回本页。桌面版通过 **插件 → 添加插件** 安装；具体配置组和移除方式见[安装指南](docs/cookbook/install-cordis-plugins.zh.md)。

| 插件 | 主要用途 |
| --- | --- |
| [上下文管理](https://github.com/Missher12/Missher-DSH-Context-Manager) | 查看当前会话上下文、来源、用量和压缩记录 |
| [使用统计](https://github.com/Missher12/Missher-DSH-Usage-Statistics) | 查看跨会话活动、用量、排行及可调色方格 |
| [输出外观](https://github.com/Missher12/Missher-DSH-Output-Renderer) | 四种阅读布局、字号间距与流式动效 |
| [会话桥接](https://github.com/Missher12/Missher-DSH-Session-Bridge) | 复制会话 ID、跨会话投递、临时工作区和归档会话永久删除 |
| [思考强度](https://github.com/Missher12/Missher-DSH-Reasoning-Effort) | 思考滑块、配色以及模型能力与档位设置 |
| [MSE 持久学习](https://github.com/Missher12/Missher-MSE-Learning) | 保存纠错和方法，并按任务与预算召回 |
| [电脑与浏览器](https://github.com/Missher12/Missher-DSH-Computer-Browser) | 可见浏览器操作与按会话隔离的电脑控制；需要配套 Missher Host 适配器；真实电脑及模型操作仍需分平台验收 |
| [Media 媒体采集（私有）](https://github.com/Missher12/Missher-Media) | 通过 Chrome CDP 采集、保留证据和选择导出 |

Media 保持私有：GitHub 显示 404 可能是账号没有访问权限。MSE 只公开产品代码，不包含私人学习记录。所有插件按需选择；取消宿主版本号限制不等于保证未来所有版本都兼容。

## 常见问题

**为什么安装后找不到插件？** 检查当前应用及配置组是否正确、插件是否启用和加载错误；按宿主提示重启或重新加载。只更新 Git 源码不会自动更新已安装的应用。

**为什么没有归档删除？** 安装配套合集中的会话桥接插件，并使用本次 Missher 桌面版。入口仅在已归档会话且宿主提供删除接口时显示；纯官方宿主可能没有该接口。

**另一台电脑拉取 Git，会同步聊天吗？** 不会。仓库提供产品源码与可分发文件，私人数据需要另行备份迁移；不要把 API Key、Cookie、聊天记录或学习数据库放入公开 Git。

**Mac、Windows 和 Ubuntu 能共用修改吗？** 可以共用桌面源码；原生程序和安装包必须分别构建。Mac 的 DMG 不能直接在 Ubuntu 运行。

**问题应该反馈到哪里？** 插件功能问题交给对应插件仓库的 Issues；安装与桌面启动问题交给本仓库。请提供系统、应用/插件版本、复现步骤及脱敏错误。

<a id="run"></a>

<a id="run-from-source"></a>

## 给开发者

使用 Node.js `^22.19.0 || >=24.0.0` 与 pnpm `11.7.0`。宿主在本仓库构建，插件在各自独立仓库开发；SDK 接入见[插件开发指南](docs/cookbook/build-cordis-plugins.zh.md)。

```sh
git clone https://github.com/Missher12/Missher-DeepseekHarness-Desktop.git
cd Missher-DeepseekHarness-Desktop
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh web
```

与已有安装同时开发时使用独立数据目录。进一步阅读[桌面打包](apps/desktop/README.zh.md)、[插件安装](docs/cookbook/install-cordis-plugins.zh.md)、[架构](docs/architecture.zh.md)、[安全说明](SAFETY.zh.md)与[贡献指南](CONTRIBUTING.zh.md)。

## 项目来源与许可

本项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，由 [DeepSeek AI](https://deepseek.com) 开发，并沿用 [Cordis](https://github.com/cordiverse/cordis) 插件架构。Missher 维护这里的社区分发与独立扩展，保留上游作者、历史和许可；本仓库不是 DeepSeek 官方发行渠道。

宿主采用 [MIT](LICENSE)，同时遵循[第三方声明](THIRD_PARTY_NOTICES.md)及各插件自己的许可证；仓库分工见 [CORDIS.md](CORDIS.md)。
