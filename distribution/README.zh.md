# 社区桌面发行

[English](README.md) | 中文

Missher 桌面安装包、上游发行和可卸载插件分别发布。安装包包含发布记录中对应源码版本的宿主扩展，不包含个人 profile、凭据或会话。

## 打包

`Missher Ubuntu Desktop packages` 工作流在原生 Ubuntu 运行器构建，检查打包运行时、实际安装软件、启动隔离桌面、检查界面并截取 PNG。通过的产物与 Mac 包汇总到同一发行版本；失败的平台任务不能提供已验收下载。

Ubuntu 使用 `.env.linux.example` 和 `pnpm run package:desktop:linux:x64`。Xvfb 检查实际界面，截图失败仍判定任务失败。Mac 应用标识及数据保留由 [Mac 启动入口](macos/isolated-bootstrap.mjs) 管理。

## 插件

全新电脑按[固定包清单](plugin-set.json)安装独立插件。配套插件 ZIP 保留公开原包和校验值。归档删除需要会话桥接插件及宿主删除接口，浏览器自动化需要配套 Host 适配器。OpenViking 需要另行配置服务和向量模型，私有 Media 不包含在合集里。

包加载、原生交互和真实模型验收分别记录；适用范围见[下载指南](../README.zh.md#downloads)及各插件仓库。
