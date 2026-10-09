# Community desktop distribution

Missher publishes installers separately from the upstream product and from removable plugins. Release installers contain the Host extensions from their pinned source commit; private profiles, credentials and conversations are excluded.

The `Missher Desktop packages` workflow builds natively on Ubuntu and Windows. It verifies the packaged runtime, installs the resulting package, starts an isolated Desktop, checks a nonempty renderer and captures a real PNG. The artifacts stay in Actions until the maintainer collects the matching Mac and plugin assets into a versioned release. A failed platform job must not be presented as a verified download.

Windows community packaging uses `apps/desktop/.env.community-windows.example`, copied to the ignored `.env.windows`, and `pnpm run package:desktop:win:x64:unsigned`. `DSH_DESKTOP_COMMUNITY_BUILD=1` requires a separate application identity and an unsigned build; it omits the upstream mandatory-update service. Ordinary product releases still require their own policy configuration. There is no invented update server and no automatic replacement with upstream binaries.

Windows CI checks out the exact source commit under a short drive-root path so bundled Python extensions stay within Windows DLL path limits during the packaged-runtime check. Ubuntu uses `.env.linux.example` and `pnpm run package:desktop:linux:x64`. Both platform jobs run under their native OS. The Xvfb check captures the presented page rather than relying on an unavailable compositor surface; screenshot errors still fail the job. Mac community identity and data preservation are managed by `distribution/macos/`.

Plugins remain independent. A clean computer must install the fixed plugin releases linked from the download guide. Archive deletion requires Session Bridge and the Host deletion interface; browser automation additionally requires its matching Host adapters. Release and full native model acceptance are reported separately.

## 中文

Windows 与 Ubuntu 使用同一套宿主源码，在各自系统构建。通过运行时、安装和界面截图检查后，安装包先保留在 Actions，维护者再与 Mac 及对应插件收进同一个发行版本；失败构建不能冒充正式可用包。

社区 Windows 包使用独立应用标识和明确的未签名模式，不连接官方强制更新服务。官方构建的原有校验保持。用户数据和私有插件不打入公开包。插件仍独立安装；归档删除必须同时具备会话桥接插件和宿主接口。
