# feed 手动上传操作单（批次 5，2026-11-14）

上游依据：`yootun/docs/1110/04-release.md` 第 3/4/5 节。执行人：维护者（TOS 凭证与远端动作在维护者侧）；本单交付时「待执行」标记的步骤由维护者按序执行，执行结果回填第五节记录表。

**关键结构约束（2026-11-14 与维护者确认）**：feed URL = `origin/keyPrefix/feeds/<target>/`——清单与安装包必须放进 **平台子目录**（`win-x64/`、`mac-arm64/`），不是单层 `feeds/` 目录；electron-updater 按打包进 app-update.yml 的 `url`（含子目录）拼清单路径，放错层级一律 404。

```
dofe-public/yootun-agent/releases/feeds/
├── win-x64/
│   ├── stable.yml                          # Windows·stable 通道清单（由 latest.yml 或 stable.yml 产物提供，见第三节）
│   ├── Yootun-Agent-<版本>-win-x64.exe      # Windows 安装包（原名上传）
│   └── Yootun-Agent-<版本>-win-x64.exe.blockmap   # 差分文件（可选；缺省回退全量下载）
└── mac-arm64/
    ├── stable-mac.yml                       # macOS·stable 通道清单
    ├── Yootun-Agent-<版本>-mac-arm64.zip    # macOS 更新包（原名上传；dmg 仅首装分发不进 feed）
    └── Yootun-Agent-<版本>-mac-arm64.zip.blockmap
```

feed 基线（`yootun/brand/brand.json` 定稿值，改动需同步回填）：origin `https://dofe-public.tos-cn-beijing.volces.com`，keyPrefix `yootun-agent/releases`（bucket 公开读 policy 仅放行 `tools-dofe/*` 与 `yootun-agent/releases/*`），通道 `stable`。打包链在品牌环境下为 unsigned 包生成 app-update.yml（`provider: generic, url: <origin>/<keyPrefix>/feeds/<target>/, channel: stable`）与成对清单——清单内容零手工编辑，只做「放对子目录 + 文件名对齐通道」。

## 一、出包（维护者执行）

| 步骤 | 操作 | 说明 |
|---|---|---|
| 1.1 基线出包 | `git tag yootun-v0.2.2-rc.2 && git push origin yootun-v0.2.2-rc.2` | tag 触发 `Yootun Desktop Package` workflow（双平台并行，参考时长 24m54s）；包版本 = workspace 版本 |
| 1.2 验证抬号出包（仅更新链验证） | Actions 页手动 dispatch 同一 workflow，`build_version` 填 **`0.2.2-rc.2.20261114.1`**（合法形态 = `<workspace 版本>.<日期>.<序列>`，官方 `validateDesktopBuildVersion` 校验，经 CLI `--build-version` 转发） | feed 包版本必须大于已装版本更新才会触发（`0.2.2-rc.2.20261114.1` semver gt `0.2.2-rc.2` ✓）；抬号包仅用于验证，验证完按第五节恢复基线，正式发版一律 tag 触发（分册 04 第 5 节版本恒等原则） |

## 二、产物核对（下载 artifact 后、上传前）

从 run 页 artifacts 下载 `yootun-desktop-windows-unsigned` 与 `yootun-desktop-macos-unsigned`，逐项核对：

- [ ] **清单文件名**：确认清单产物实际名（`stable.yml` / `stable-mac.yml`，builder 按 channel 命名；若历史产物为 `latest.yml` / `latest-mac.yml` 则按下表重命名）；**首跑检查项**——若产物清单名与本表不符，回填第四节后调整操作单；
- [ ] **清单 ↔ 安装包成对**：清单内 `version`、`files[].url`（文件名）与同产物安装包文件名一致；sha512 由 builder 写入，不手工改；
- [ ] **app-update.yml 抽查**（首跑必做一次）：安装 exe 后在安装目录 `resources/app-update.yml` 确认 `provider: generic`、`url: https://dofe-public.tos-cn-beijing.volces.com/yootun-agent/releases/feeds/win-x64/`、`channel: stable`——这是 electron-updater 实际请求的地址，与第一节目录结构逐字符比对。

## 三、上传映射表（对照第一节目录结构）

| 产物文件 | 上传路径（TOS key） | 改名规则 |
|---|---|---|
| `stable.yml`（或 `latest.yml`） | `yootun-agent/releases/feeds/win-x64/stable.yml` | 产物为 `latest.yml` 时改名 `stable.yml`，否则原名 |
| `Yootun-Agent-<版本>-win-x64.exe` | `yootun-agent/releases/feeds/win-x64/<原名>` | **不改名** |
| `*.exe.blockmap` | `yootun-agent/releases/feeds/win-x64/<原名>` | 不改名（可选） |
| `stable-mac.yml`（或 `latest-mac.yml`） | `yootun-agent/releases/feeds/mac-arm64/stable-mac.yml` | 产物为 `latest-mac.yml` 时改名 `stable-mac.yml` |
| `Yootun-Agent-<版本>-mac-arm64.zip` | `yootun-agent/releases/feeds/mac-arm64/<原名>` | **不改名** |
| `*.zip.blockmap` | `yootun-agent/releases/feeds/mac-arm64/<原名>` | 不改名（可选） |
| `Yootun-Agent-<版本>-mac-arm64.dmg` | 不进 feed（首装分发另存） | — |

规则（分册 04 第 4 节定案沿用）：清单与安装包**成对上传、版本一致**；灰度通道 = 同一安装包配 `nightly.yml`/`nightly-mac.yml` 清单再传一份；覆盖已发布版本时新旧两版安装包可并存（清单只指向新版，旧包保留供已装旧版差分回退）。

## 四、上传后验证（curl，任一机器）

```sh
base=https://dofe-public.tos-cn-beijing.volces.com/yootun-agent/releases/feeds
curl -fSs "$base/win-x64/stable.yml" | head -8       # 200 且 version/files.url 正确
curl -fSs "$base/mac-arm64/stable-mac.yml" | head -8
curl -fSI "$base/win-x64/Yootun-Agent-<版本>-win-x64.exe" | head -4   # 200 + content-length 一致
```

任一 404/403：先对照第一节目录结构（层级、文件名大小写）与 bucket 公开读 policy 前缀。

## 五、真机更新链验证（Windows，维护者执行，喂单后由工程师继续跟进）

前置：真机已装 `yootun-v0.2.2-rc.2` 基线包（含批次 4 激活门禁；企业 key 激活不影响更新链）。

1. 设置页 → 更新通道确认 `stable`（品牌包出厂 channel 即 stable；如页面显示其他值切回 stable）；
2. 「检查更新」→ 应检测到 `0.2.2-rc.2.20261114.1`（抬号包）：客户端 GET `<feed>/stable.yml` 比对版本；
3. 下载（progress 可见）→ 安装 → 自动重启 → 关于页版本号显示 `0.2.2-rc.2.20261114.1`（版本号前进 ✓）；
4. **篡改防护说明**：清单内 `files[].sha512` 由 builder 生成，electron-updater 下载后逐字节校验——篡改安装包任意一位（或上传时截断）都会导致 hash 不匹配而**拒绝安装**（更新失败并保留已装版本），这是 feed 被篡改时的最后防线；上传后不要手工编辑清单（改一处 sha512 即全链失效）；
5. 验证完成后恢复基线：把 rc.2 的 `stable.yml` + 安装包重新上传覆盖（回第 4 步 curl 复核），使 stable 通道回到正式版本。

## 六、macOS 包归档（不进真机验证）

`yootun-desktop-macos-unsigned` artifact（dmg/zip/清单）下载归档即可。已知限制（决策点 6）：unsigned 包 Gatekeeper 拦截，安装右键打开或 `xattr -cr <app>`；更新链 mac 侧真机验证挂起（维护者无 mac 设备），清单已按同结构就位（`stable-mac.yml`），有 mac 条件时按第五节同流程补验。

## 七、执行记录（维护者回填）

| 步骤 | 日期 | 结果（版本号/异常/耗时） |
|---|---|---|
| 1.1 基线 tag 出包 | 待执行 | |
| 1.2 抬号 dispatch 出包 | 待执行 | |
| 二、产物核对 | 待执行 | |
| 三、上传 | 待执行 | |
| 四、curl 验证 | 待执行 | |
| 五、真机更新链 | 待执行 | |
| 五、基线恢复 | 待执行 | |
