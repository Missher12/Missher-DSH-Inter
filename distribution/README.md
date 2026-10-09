# Community Desktop distribution

English | [中文](README.zh.md)

Missher publishes desktop installers separately from upstream releases and removable plugins. Installers contain Host extensions from the source revision recorded in each release. Private profiles, credentials and conversations are excluded.

## Packaging

The `Missher Ubuntu Desktop packages` workflow builds on a native Ubuntu runner. It checks the packaged runtime, installs the package, starts an isolated Desktop, checks its renderer and captures a PNG. Verified artifacts are collected with the Mac build into a release; failed platform jobs cannot supply verified downloads.

Ubuntu uses `.env.linux.example` and `pnpm run package:desktop:linux:x64`. Xvfb checks the actual renderer; screenshot failures fail the job. Mac identity and data preservation are owned by [the Mac bootstrap](macos/isolated-bootstrap.mjs).

## Plugins

A clean computer installs the independent plugins from the [fixed package manifest](plugin-set.json). The matching plugin ZIP contains the original public archives and their checksums. Archive deletion requires Session Bridge and the Host deletion interface; browser automation requires matching Host adapters. OpenViking needs a separately configured service and embedding model. Private Media is excluded.

Package loading, native interactions and real model acceptance are separate checks. See the [download guide](../README.md#downloads) and each plugin repository for the applicable scope.
