# 上游 0.2.2-rc.5 同步注意事项与验收清单（2026-11-23）

本文记录 `main` 从官方 0.2.2-rc.3 基线同步到官方 0.2.2-rc.5 的合并落点、适配点、验证结果与后续出包注意事项。`master` 仅作为官方上游镜像，不承载 yootun 定制，也不得反向合入 `main` 的定制内容。

## 一、同步基线与范围

| 项 | 记录 |
|---|---|
| 同步日期 | 2026-11-23 |
| 同步前产品版本 | `0.2.2-rc.3` |
| 同步后产品版本 | `0.2.2-rc.5` |
| 官方上游 | `deepseek-ai/deepseek-harness` 的 `master`。官方 `master` HEAD 已是 `0.2.3-alpha.2`，本次落点取 `master` 上合入 rc.5 的同步合并（PR #8736，2026-11-18），它是 `master` 主干上第一个版本号为 rc.5 的提交，包含 rc.4 与 rc.5 两个 tag；本地 `master` 与 `origin/master` 均停在该提交 |
| 官方变更规模 | 3443 个路径、1045 个提交（主干 94 个）。除 rc.4 的两个修复与 rc.5 的一项改进外，还包含官方在 2026-11-13 之后合入 `master` 的开发提交；与 rc.3 同步口径一致，不是纯 release 分支 |
| 合并方式 | 在 `main` 上执行 `git merge --no-ff master`；Git 无文本冲突，合并后按登记簿做语义对账 |
| yootun 适配 | 10 个 `@yootun` 包版本与 `yootun/brand/brand.json` 的 `baseVersion` 跟到 `0.2.2-rc.5`；`@yootun/dsh-managed-mcp` 改用官方 `McpClientHost`（见第二节） |
| 远端状态 | `master` 与 `main` 均已推送到 `origin`；本次不打 tag |

上游至今没有非预发布的正式版：44 个 tag 全部是 alpha 或 rc，npm 的 `latest` 与官方桌面 stable 通道当前都是 `0.2.2-rc.5`。

## 二、自动合并结果与适配决策

| 上游变化 | 合并结果 | 决策 |
|---|---|---|
| `@deepseek-ai/dsh-mcp-client` 删除 `connectionStatusOf` 等导出，新增 `McpClientHost` | `@yootun/dsh-managed-mcp` 的 `supervisor.ts` 类型检查失败 | supervisor 改为 `new McpClientHost(ctx.isolate('mcpClientHost'))`，经 `validate` 与 `mount` 挂载子实例，以 `ready` 给出的状态句柄替代 `connectionStatusOf`。行为不变：启动失败复位挂载态并在下次门禁事件重试，状态为 `failed` 时销毁重建。`isolate` 不可省略，见下文 |
| 官方删除 4 个包（`ui-settings-plugins`、`ui-settings-plugin-inventory`、`credentials/deepseek-account`、`session/tool-working-directory`） | 合并索引删除仓库文件，本机遗留 `lib/` 与 `node_modules/` | `constraints` 报 4 处 `expected a package here`；确认合并索引零跟踪后运行官方 `pnpm run clean`（清理 414 个路径），复跑通过，随后全量重建 |
| 官方版本、workspace 与 lockfile 更新 | `pnpm-lock.yaml` 自动合并 | `pnpm install --frozen-lockfile` 通过；不手改 lockfile |
| Cordis Loader 1.0.0-rc.9 按 YAML 1.2 解析并校验条目选项 | yootun bundle patch 需要实测 | `dsh --profile web --patch yootun/packages/dsh-bundle-yootun/cordis.patch.yml --dump-config` 退出码 0 且无诊断；官方品牌包关闭、8 个 yootun 插件条目、企业模型路由均生效，23 个模型 id 仍为字符串 |
| 新增 25 篇升级指南（`v0.2.2-rc.3` 22 篇、`v0.2.2-rc.4` 3 篇） | 逐篇评估对第 1 层的影响 | 无需改 yootun 代码。指南点名的已删除导出与旧 slot yootun 均未使用；在用的 6 个 slot（`sidebar.panellist`、`sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.frame`、`conversation.hero.brand.mark`、`settings.section`）与 `main` 仍存在；非 DeepSeek 路由的搜索提供方仍是 `deepseek-search-api`，yootun 网关路由行为不变；`upstream-skills` 只在连接器插件注册时下载 |

**`McpClientHost` 必须隔离。** 桌面 profile 的 web-app bundle 挂载了官方 `mcp-manager`，它在根作用域注册了 `mcpClientHost`。Cordis 对同一隔离作用域内的同名服务重复注册直接抛错（`service "mcpClientHost" has been registered at <…>`），所以直接 `new McpClientHost(ctx)` 会让 yootun 插件在真实桌面里激活失败、Agent 面 39 项工具不可用，而 yootun 的测试环境不挂 `mcp-manager`，测试照样通过。隔离子作用域继承本插件的 fiber，host 与其挂载的子实例仍随本插件结束。回归测试「根作用域已有 mcpClientHost 提供方时仍能挂载 Agent 面，且不覆盖该提供方」覆盖这一条；去掉 `isolate` 时该测试以上述错误失败。

**产品可见的官方变化（真机目检项）。** `settings.section` 条目仍显示在设置里，并可能同时出现在插件页面。会话标题栏的后台任务与子智能体入口移入会话面板。

## 三、内联改动保留清单

合并后以 `master` 为对照，官方目录差异为 35 个文件：登记簿 #1–#8 对应 34 个，另有 `scripts/no-unknown-casts.baseline.json`（P3 X7 登记测试假对象断言时引入，尚未写进登记簿）。33 个文件的补丁合并前后逐字节一致；`packages/client/ui-conversation/src/client/locales.ts`（#6）与上述基线文件因上游改了邻近内容而补丁文本变化，内容核实无误。

对账命令：`git diff --name-status master -- packages vendor apps docs scripts .github native benchmarks website python ':(exclude).github/workflows/yootun-*.yml'`。

| 登记项 | 合并后文件面 | 状态 |
|---|---|---|
| #1 workspace | `pnpm-workspace.yaml` 保留 `yootun/packages/*` 与 `yootun/plugins/*` | ✅ |
| #2 desktop profile | `apps/desktop/src/project-manager.ts` 保留 `@yootun/dsh-bundle-yootun` | ✅ |
| #3 打包闭包 | `prepare-package-set.ts`、`pack-local-packages.ts`、`tests/prepare-package-set.spec.ts` 保留 yootun bundle 选择与单独 staging | ✅ |
| #4 品牌打包 | `electron-builder-config.mjs`、`package-target.ts`、`smoke-packaged-runtime.ts`、Windows installer 脚本与素材、`packages/client/tsdown.client.ts` 等保留品牌收口 | ✅ |
| #5 feed 配置 | `apps/desktop-publisher/src/desktop-auto-update-environment.mjs` 与配套测试保留 feed origin 与 keyPrefix 品牌覆盖 | ✅ |
| #6 client 构建 | client build environment、类型声明、键集测试与 `ui-conversation` 八语言 hero 文案保留 | ✅ |
| #7 桌面与 onboarding 文案 | desktop locale/main、welcome 快照、`ui-settings-account` 文案保留 | ✅ |
| #8 mac 本地打包环境 | `apps/desktop/scripts/desktop-package-environment.mjs` 保留品牌 appId 与品牌 feed 态的更新部署键透传 | ✅ |

## 四、验证结果

以下命令均在合并后的 `main` 工作区执行。

| 命令 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ 新增 9 个包、移除 2 个 |
| `pnpm run clean` | ✅ 清理 414 个已删包残留路径，无被跟踪文件受影响 |
| `pnpm run constraints` | ✅ clean 后通过 |
| `pnpm run lint` | ✅ |
| `pnpm run typecheck` | ✅ 5 gates 全过 |
| `pnpm run build` | ✅ 10 gates 全过；clean 后全量重建，记录 385 个 client artifact |
| `pnpm --filter '@yootun/*' run build` | ✅ 10 个包全部通过 |
| `pnpm --filter '@yootun/*' run test` | ✅ 8 个带测试的包；`node --test` 412 项与 vitest 15 个文件全过 |
| `node yootun/scripts/self-test.mjs` | ✅ 16/16 |
| 聚焦 Vitest（15 个文件：publisher 更新环境、installer locale、package set、pack-local、desktop package environment、package-target 三件、welcome 三件、onboarding 三件、client build environment） | ✅ 349 用例全过 |
| `pnpm run hygiene` | 25/26；失败的 `vendor rescope`（`rescope-vendor:check`）在纯上游 `master` 上同样失败，见下文 |
| `dsh --profile web --patch yootun/packages/dsh-bundle-yootun/cordis.patch.yml --dump-config` | ✅ 退出码 0，无诊断 |
| `pnpm run test:docs`、`pnpm run verify-repository-references`、`pnpm run verify-translation-pairing` | ✅ |

`rescope-vendor:check` 报 `apps/web/tests/client-config-sync.e2e.ts` 残留重命名前的名字。该文件与上游 `master` 逐字节一致，yootun 从未改动；在不含任何 yootun 文件的纯 `master` 检出上运行同一检查得到相同结果。这是上游 master 在该提交上的既有问题，不在本仓修复，随下一次上游同步复查。

## 五、出包与真机复验清单

1. 本次不打 tag。在 Actions 页手动触发 `Yootun Desktop Package`，`build_version` 填 `0.2.2-rc.5`，即 workspace 版本；官方校验接受等于或扩展产品版本的值。
2. 产物核对、TOS 上传映射与 curl 验证按 [../feed-upload-runbook.md](../feed-upload-runbook.md) 第二至四节执行，执行结果回填该单第七节。
3. 三个工作台的真机验收是在 rc.3 基线上通过的，不自动延续到 rc.5。出包后按 [16-three-workbench-real-device-acceptance.md](16-three-workbench-real-device-acceptance.md) 的范围做一次回归，至少覆盖三入口可打开、扫码与采集链路、明暗主题与三档宽度。
4. 目检项：设置中的 yootun 激活分区；会话标题栏的会话面板与工作台中央面板的共存；普通会话里 Agent 39 项工具可用，这是 `@yootun/dsh-managed-mcp` 与官方 `mcp-manager` 共存的直接证据。
5. 升级安装后旧状态目录保留且页面可操作，对应 [09-workbench-migration-plan.md](09-workbench-migration-plan.md) §7.3 的未勾选项，可在这次回归中一并确认。

## 六、后续同步注意事项

- 官方 `master` HEAD 已是 `0.2.3-alpha.2`，并把 Node 要求提高到 24.22.3 及以上的 24.x 线或 26.13.1 及以上；rc.5 落点的 Node 要求仍是 24.9.0。下次同步先决定落点，再执行 [../upstream-sync.md](../upstream-sync.md) 第一节。
- 在 yootun 插件里新建官方同名服务前，先查根作用域是否已有提供方；需要各用各的实例时按官方惯例 `ctx.isolate('<服务名>')`。
- `hygiene` 聚合中的 `verify-no-unknown-casts` 与 `verify-cordis-root` 是全仓清单 gate，覆盖 `yootun/`；基线只减不增。
- `scripts/no-unknown-casts.baseline.json` 仍是官方目录中唯一未进登记簿的改动。
