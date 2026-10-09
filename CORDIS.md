# Missher DeepSeek Harness Desktop

本仓库维护当前桌面与公共 Host 源码，保留上游历史。各插件在[独立仓库](plugins/README.zh.md)开发、构建、安装和卸载，不增加共同兼容包。

## 源码入口

桌面源码在 apps/desktop，公共 Host 和界面模块在 packages。插件清单与版本入口由 cordis-repositories.json 记录；四个原 plugins 子目录已经独立迁移，不再保留可修改副本。

## 独立项目

[Media](https://github.com/Missher12/Missher-Media) 保持私有；[思考强度](https://github.com/Missher12/Missher-DSH-Reasoning-Effort) 公开；[MSE Learning](https://github.com/Missher12/Missher-MSE-Learning) 只包含独立产品导出，不含父项目和学习记录。

会话、凭据、附件、生产 profile、安装备份和私有验收响应不发布。源码发布、应用安装和真实模型验收是三个不同结果。

## Git 整理

项目统一 Missher 前缀。改名保留历史及原地址重定向；旧 Inter 工作树与未提交工作保留。旧产品使用 Missher-Archive 前缀，有未合并 PR 的仓库保持可写；不删除 PR、分支或历史。上游协作 fork 是 [Missher-DSH-Upstream](https://github.com/Missher12/Missher-DSH-Upstream)，插件目录 fork 是 [Missher-DSH-Plugin-Catalog](https://github.com/Missher12/Missher-DSH-Plugin-Catalog)。

## 平台

本次下载提供 Intel Mac 与 Ubuntu x64。Ubuntu 构建由 Missher Ubuntu Desktop packages 工作流执行，包含运行时 Host、Office 转换、实际安装和 Xvfb 桌面窗口检查。两端复用产品源码，分别生成本机二进制与原生依赖；只有检查通过并已发布的安装包属于下载交付。

根 LICENSE、THIRD_PARTY_NOTICES.md 与独立插件许可证继续保留。
