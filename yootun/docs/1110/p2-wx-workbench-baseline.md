# P2 视频号工作台基线复核（W0，2026-11-17）

旧插件只读勘察：`docker-helm.dofe.ai/plugins/dsh-yootun-wx-channels-operation`（master，约 6.5k 行）。本表是迁移对照的唯一基线；实现按新架构重译，不复制视觉/弹层/旧 route 直连逻辑。

## 1. 旧 Host action（19 项）与新路由映射

新路由固定 `/api/desktop/yootun/wx-workbench`（旧为 `/api/desktop/yootun/wx-channels-operation`）。action 集合与旧一致，全部保留；每项新增 schema 校验 + 未知字段拒绝（旧实现只做长度截断，属本次加固）。

| action | 旧行为要点 | 新实现差异 |
|---|---|---|
| browser.status | 系统 Chrome / Playwright 驱动探测 | 同语义，chrome.ts 移植 |
| accounts.list | 本地 accounts.json ∪ 远端 account_list 合并投影；远端失败独立降级（remoteOk=false） | 远端改经 workbench `workbench_wx_account_list` |
| account.beginLogin | loginRuns 状态机（waiting_qr/waiting_confirm/ok/timeout/failed）；终态 TTL 30min；成功后 account_save + session_status_report（先 save 后翻 ok） | 同语义；save/report 改经 workbench |
| account.loginStatus | loginRuns 投影（idle/状态/资料/reason） | 同 |
| account.refreshLoginQr | attemptId 代次守卫；关旧上下文防旧回写（P2-12） | 同 |
| account.probe | refreshSessionState 实测 + session_status_report；白名单投影（不回显 seq/vaultRef） | 同 |
| account.promote | pending- 账号提升（探活后改名迁移 profile/storage_state） | 同 |
| account.removeLocal | 本地凭证与 profile 清理 | 同 |
| account.removeRemote | 本地 storage_state 仍存在 → 拒绝（LOCAL_CLEARED_REQUIRED）；再远端 remove（confirm+localCleared+幂等键） | 同；远端经 workbench |
| collect.start | 互斥（collectBusy/batch running/batchReserved 三态同步守卫）；readiness 检查；会话实测上报；单槽 collectRecord 投影；newAttempt 语义 | 增加 run 记录持久化（runs.json）、取消（AbortSignal）与同步互斥预留（TOCTOU 修复） |
| collect.cancel（新增） | 旧插件无取消入口 | AbortController 中止当前采集；远端补偿 run_cancel 用独立 cleanup signal（不复用已 aborted 的调用 signal）；已完成批次保留，本地投影 cancelled |
| collectAll.cancel（新增） | 旧插件一期无批量取消 | 停止当前账号、后续账号标 skipped(cancelled)；批量 controller stop/dispose 语义 |
| collect.status | busy + collectRecord 投影 | 增加持久化 run 恢复投影 |
| collectAll.start | batchReserved 同步预留防 TOCTOU（P2-6）；非 pending 账号列表串行采集 | 同 |
| collectAll.status | batchController.status 投影；重启后回 ready | 同 |
| run.get | 远端 collect_run_get 透传 | 经 workbench |
| works.list / work.get / work.trend | 远端透传（sort/order 长度截断） | 经 workbench；参数 schema 化 |
| account.overview | window 参数透传 | 经 workbench |
| fans.profile.get | 远端透传 | 经 workbench |

## 2. 旧模块 → 新模块对照

| 旧文件（行数） | 职责 | 新落点 | 迁移口径 |
|---|---|---|---|
| state.js (282) | 状态目录/accounts.json 读写锁/seq 递增/profile 与 storage_state 移动清理（0700/0600） | `src/state.ts` | 全语义移植；目录不变 |
| chrome.js (152) | 系统 Chrome 探测（不下载 Chromium）；LAUNCH_ARGS 仅 --no-sandbox/--disable-dev-shm-usage | `src/chrome.ts` | 全语义移植 |
| session.js (402) | 扫码登录（Cookie 命中≠有效，auth_data 读出 finderUsername 才算登录）、身份稳定 3 次（多视频号串号修复）、pending 提升、probe、过期标记、本地删除 | `src/login.ts` + `src/probe.ts` | 全语义移植 |
| collector.js (453) | 页面上下文同源 fetch；post_list 自 2026-01-01、totalCount+objectId 去重完整性；详情 180 天分块；账号级三接口；切批 20/3000/2300 | `src/collector.ts` | 全语义移植 |
| parse.js (586) | 上海时区日窗、JSON 大整数保真、四类解析、长度校验序列 | `src/parse.ts` | 全语义移植 |
| ingest.js (566) | run_start 幂等键=runId、列表元信息、works 切批（失败对象同号 :retry{n} 重投）、账号级三类（fans_trend 30 行分块、traffic_source 挂末日行）、finish clientCounts、cancel 兜底、确定性错误不重试、RUN_NOT_RUNNING 重建 | `src/ingest.ts` | 全语义移植 |
| runner.js (635) | 单账号编排（readiness/ensureRemoteAccount/身份复核/采集/入库/过期收尾）、进度事件、批量串行控制器 | `src/runner.ts` + `src/collect-all.ts` | 全语义移植 + 取消支持 |
| tools-client.js (311) | ctx.tools.execute 调用封装、稳定码白名单、幂等键模板 | 删除；改经 `ctx.yootunWorkbench.callTool('wx-workbench','wx',…)`；幂等键模板移入 `src/idempotency.ts`；稳定码映射移入 `src/errors.ts` | 重写 |
| index.js (584) | 路由分发 | `src/route.ts` + `src/index.ts` | 重写（schema 化加固） |
| ui-format.js / account-ui.js / work-ui.js / client.js (2.6k) | 旧 UI（sidebar footer 弹层） | **不迁移**；新 client 半按 plugin-ui-ux-standard 重写 | 排除 |

## 3. 稳定错误码基线

旧 tools-client.js ALLOWED_ERROR_CODES 超集（27 项）全部保留；本地新增 `GOOGLE_CHROME_MISSING`、`PLAYWRIGHT_DRIVER_MISSING`、`WX_SESSION_INVALID`、`WX_TOOL_UNAVAILABLE`（workbench 调用不可达投影）、`WX_ROUTE_*`（路由层：unknown_action/invalid_request/payload_too_large/uploader 式 refused）。复审要求的 25 项最低集已全部覆盖于上表。

## 4. 本地状态兼容

- 目录不变：`~/.dofe/dsh-yootun-wx-channels-operation`，env 覆盖 `WX_CHANNELS_OPERATION_STATE_DIR`；
- accounts.json 结构与旧一致（version=1，accounts map，含 sessionSeq/heartbeatSeq/runAttemptId/runId/sessionStatus/sessionCheckedAt/nickname/avatar/feedCount/followerTotalCount）；旧文件直接可读，不迁移不改写；
- profiles/<safeSegment>/ 与 storage-state/<safeSegment>.json（0600）不变——升级后免重扫；
- 新增 runs.json（采集 run 持久化，崩溃恢复用）：只新增文件，不触碰旧文件；无法识别的 runs.json 保留原样并报可恢复错误。

## 5. Workbench 工具映射（19 项，旧名 → 新名）

`wx_channels_*` → `workbench_wx_*` 一一对应（save/remove/session_status_report/collect_run_start/collect_run_set_list_meta/collect_run_heartbeat/collect_ingest_works/collect_ingest_account_metrics/collect_ingest_fans_trend/collect_ingest_fans_profile/collect_run_finish/collect_run_cancel/account_list/collect_run_get/work_list/work_get/work_trend/account_overview/fans_profile_get），调用身份固定 `caller='wx-workbench', domain='wx'`。

## 6. 关键行为红线（从旧审查结论继承）

1. Cookie 命中≠登录；auth_data 读出 finderUsername 才算登录（死 Cookie 教训）；
2. 身份稳定：连续 3 次相同身份才算选完（多视频号串号修复）；
3. 登录成功先 account_save 再翻 ok（否则 save 失败永不可见）；采集前 ensureRemoteAccount 自愈；
4. 批次传输失败不计入客户端 failed 计数（否则 finish RUN_COUNT_MISMATCH 卡死 run）；
5. 带失败对象批次同 batchNo `:retry{n}` 重投（服务端删旧行真实重做）；
6. 账号级失败只记段落缺口，绝不覆盖已有数据为空白；会话失效过期收尾保留已采集数据；
7. 列表元信息失败必须显式 cancel（否则 run 停 running 等 120s 租约）；
8. 批量与单账号互斥：collectBusy/batchReserved 同步预留防 TOCTOU；
9. 远端删除前置条件：本地 storage_state 已不存在。

## 7. Playwright 依赖口径

`playwright-core ^1.49.0` 作为本包 dependencies（**不是** `playwright`——避免完整 playwright 的浏览器下载管理器进入桌面生产闭包）；`chromium.launch({ channel: 'chrome' })` 只用系统 Chrome，不下载浏览器——与旧合规基线一致。
