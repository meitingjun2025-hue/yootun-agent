# 分册 18：未签名 macOS 包的手动替换更新（2026-11-23）

本文记录桌面端 macOS 未签名包的更新安装方式从「Squirrel.Mac 原生安装」改为「下载后用户在访达拖拽替换」的设计决策、边界与退出路径。登记入口：`yootun/docs/inline-changes.md` #9（新文件）与 #4/#7 的同批扩展。

## 1. 背景与问题

- yootun 的 macOS 安装包未签名（决策点 6，分册 04 第 5 节）。macOS 原生自动更新（Squirrel.Mac）在安装前校验新包是否满足当前运行 App 的代码签名要求，未签名包必然失败，真机报错为「代码未能满足指定的代码要求」。
- 失败点在用户点击「安装并重启」之后：清单读取、下载、SHA512 校验、进度与取消全部正常（这些由 electron-updater 的 `MacUpdater.doDownloadUpdate` 完成），安装阶段的签名校验才被 Squirrel.Mac 拒绝。用户看到的是一次安装失败，而不是可理解的引导。

## 2. 方案：下载链不动，只换安装交接

- 新增 `apps/desktop/src/manual-install-mac-updater.ts`：继承 electron-updater 的 `MacUpdater`，只覆盖两处——`doDownloadUpdate` 在 `super.doDownloadUpdate()` 完成后把已校验的 zip 解压到「下载」文件夹（`/usr/bin/ditto`），校验解压结果恰有一个真实 `.app` 目录且其 `CFBundleShortVersionString` 与清单版本一致；`quitAndInstall` 改为访达显示解压出的 App、尽力打开当前应用所在文件夹、退出应用，由用户把新 App 拖到原来的位置完成替换。
- 启用条件取两个必要条件的合取：运行平台为 `darwin`，且安装包清单带 `dshDesktopUpdateInstall: 'manual'` 标记。标记由打包链写入（内联 #4 扩展），只在 `packagesMacOS && unsigned` 时存在。Windows 与签名 macOS 包一律走原有更新器，行为零变化。
- 下载、校验、进度、取消、差分下载与缓存完全复用基类实现，不复制、不改写；更新器的 HTTP 执行器（超时策略）经 `installDesktopUpdateHttpExecutor` 与协调器同型装配。
- 失败语义：解压或校验的任何失败都从 `doDownloadUpdate` 抛出，由协调器归为「下载失败」，此时后台任务尚未停止、应用照常运行，用户可重试；访达显示失败通过更新器 `error` 事件上报且不退出（主进程恢复已停止的后台）；打开安装文件夹失败仅记警告，不影响退出。

## 3. 为什么不「先尝试系统安装、失败再回退」

- Squirrel.Mac 的签名校验失败发生在原生安装流程内部，主进程只能通过更新器的 `error` 事件事后得知。此时后台任务已按安装前确认停掉、应用正准备退出，回退意味着「先让用户经历一次必然失败的重启流程，再重新拉起应用提示换一种方式」，体验与状态恢复都更差。
- 失败发生在每个用户的每一次更新上（未签名包 100% 失败），不是概率性的兼容问题：对确定性失败做「尝试—回退」没有信息增益，只增加一次确定的失败体验与一条难以诊断的错误路径。
- 打包链在构建期就知道包是否签名，清单标记在安装前就决定了交接方式，无需运行期探测。

## 4. 签名后如何自动回到系统安装

- 回归路径是删除而不是新增：购入 Apple 开发者证书后，打包链走官方 signed 链（`macos-packaging/production.env.example` 所列 env），`packagesMacOS && unsigned` 不再成立，`extraMetadata` 不写入 `dshDesktopUpdateInstall` 标记，运行中的旧版本读不到标记即用回 `autoUpdater` 原生安装。
- 过渡期内的已装用户（装着 unsigned 包、跑手动替换逻辑）收到签名版更新时，最后一次更新仍是手动拖拽替换；替换后的新包不再带标记，之后的更新回到原生「安装并重启」。
- 代码清理：`manual-install-mac-updater.ts`、main.ts 的手动分支、八语言的三条 manual 文案、登记簿 #9 一并移除；分册 04 的 unsigned 期描述归档。

## 5. 将来如何移除（分步清单）

1. 打包链：删除 `electron-builder-config.mjs` 中 `dshDesktopUpdateInstall` 的条件写入（内联 #4 扩展段随之收缩）。
2. 运行时：删除 `apps/desktop/src/manual-install-mac-updater.ts` 与 `apps/desktop/tests/manual-install-mac-updater.spec.ts`，还原 main.ts 的三处手动分支与协调器第三参数为 `undefined`。
3. 文案：删除八语言字典的 `updateDetailManual`/`updateDownloadedDetailManual`/`updateOpenAndReplace`，还原 `desktopUpdateReadyConfirmation` 签名。
4. 登记：inline-changes.md 的 #9 标记为已移除（保留行历史），本分册归档。

## 6. 已知限制

- 本批在 Linux 上开发，macOS 真机更新链尚未跑通验证：解压产物的访达显示、拖拽替换后的 Gatekeeper 首启引导、版本号前进，都待真机确认（步骤见 `yootun/docs/feed-upload-runbook.md` 第五节）。
- 未签名 App 拖入「应用程序」后首启仍需右键打开或 `xattr -cr`（Gatekeeper 对 unsigned 包的既有限制，与首装一致，不随本机制变化）。
- 手动替换期间更新器基类的 Squirrel 代理服务仍会随下载创建（基类行为，现状下用户推迟安装时它同样存在），不额外处理。
