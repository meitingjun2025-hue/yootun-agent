# P3 小红书 X7 本地真实链路验证方案

状态：**起草待执行**（2026-11-20 起草；完整执行前置条件：有效 yootun key 与操作者在场扫码）。

本方案细化 [09-workbench-migration-plan.md](09-workbench-migration-plan.md) §5.5 的 X7 中可在 WSL 本地完成的部分：生产 Workbench endpoint 冒烟、真实 Desktop UI + 系统 Chrome 扫码与发布链路、三页全走查的视觉与可达性矩阵。它不替代 Windows 真机验收；该项仍按 §5.6 在打包产物安装后另行执行。方案结构参照 [10-wx-workbench-w5-local-e2e-plan.md](10-wx-workbench-w5-local-e2e-plan.md)（P2 同型方案），差异由小红书工作台的实际范围决定。

## 1. 验证目标与边界

本地验证要证明：

1. 生产 Workbench endpoint（`https://ixicai.cn/mcp/tools/yootun/v1/workbench`，不设本地覆盖）完成 initialize 与 tools/list，契约精确 94 项（2026-11-21 抖音发布排期同步后的当前基线），其中 19 项 `workbench_xhs_*` 与白名单一致；`workbench_xhs_hotboard_settings_get` 读通；
2. Desktop 小红书工作台能用系统 Chrome 打开真实小红书扫码页，操作者扫码后完成登录、本地状态落盘与账号列表呈现；
3. 爆款仿写链路用真实素材走通：media-upload 上传得到公网 URL、task.create 幂等创建、轮询至终态、结果单版可编辑可复制、发布面板打开创作者中心并轮询回执；
4. 车衣爆款看板四子区读取真实数据，写操作（候选审核/关键词/标签）回执就近呈现且失败不改原数据；
5. UI 在明暗主题、1120 / 880 / 640 px、键盘路径和 reduced-motion 下通过真实浏览器目检，抽屉与灯箱遮挡行为正确。

不在本方案内：

- 不连接本地 FastMCP 服务（X7 冒烟直接使用生产 endpoint，与 P2 W5 的本地拓扑不同）；
- 不做 Windows 安装、升级、扫码和采集（§5.6 真机项，打包后由操作者执行）；
- 不用 mock Host、mock Workbench server 或伪造业务数据替代真实扫码与真实任务；
- 不把激活 key、扫码二维码、Cookie、storage_state、本地路径或完整账号身份写入证据文件。

## 2. 前置条件

| 条件 | 要求 |
|---|---|
| 代码 | `yootun-agent` 位于 `feat/plugin-xhs-workbench`，工作区干净，P0–X6 检查全绿 |
| 激活 key | 操作者持有效 yootun 企业 key；key 只在 UI 或冒烟脚本环境变量中使用，不进入命令行历史、脚本文件或截图 |
| 系统 Chrome | WSL 内 `google-chrome` 可执行，且 GUI 可展示扫码窗口 |
| 测试素材 | 一组可公开的图片（≤9 张）与一个短视频；使用可公开测试内容，不用含隐私素材 |
| 测试账号 | 一个已登录的小红书测试账号（扫码由操作者完成）；发布验证产生可见草稿属预期 |
| 操作者 | 用户在场扫码，并确认接受发布验证在测试账号产生草稿 |

证据目录固定为仓库根目录下的 `.ui-review/xhs-workbench-x7-local/`。该目录被 Git 忽略，只保存截图、脱敏 manifest 和临时脚本（生产冒烟脚本见 §3）；其中的 `dsh-home/`、`electron-user-data/`、`xhs-state/` 是敏感运行状态，验收结束后删除。

## 3. 阶段 A：生产 endpoint 冒烟（脚本化，先于 UI）

冒烟脚本已就位：`.ui-review/xhs-x7-smoke/prod-smoke.mjs`（不入仓库）。执行：

```bash
MODELS_API_KEY=<有效 key> node .ui-review/xhs-x7-smoke/prod-smoke.mjs
```

| 检查 | 通过标准 |
|---|---|
| endpoint 可达 | connect 不抛传输错误（2026-11-20 无 key 探测已确认：endpoint 可达、MCP 协议响应、服务端要求 Models API key） |
| serverName | `getServerVersion().name === 'yootun-workbench'` |
| tools/list 总量 | 服务端广播 94 项（连接器按子集契约只要求白名单 90 项全部出现，不校验总量相等；发布排期同步前的 90 项记录只保留历史证据） |
| xhs 子集 | 精确包含 19 项 `workbench_xhs_*`，无多无少（脚本内置清单比对） |
| settings 读通 | `workbench_xhs_hotboard_settings_get` 非 isError，返回结构化 settings |
| 白名单边界 | 无任何 `workbench_xhs_` 前缀外工具混入（脚本对前缀集合做差集） |

manifest 记录工具名集合与 settings 顶层键名；不记录 Authorization 头、key 或任何 Cookie。

## 4. 阶段 B：隔离 Desktop 运行态

在 `yootun-agent` 根目录启动已构建 Desktop；若构建产物缺失，先执行 `pnpm run build`。端口 `9334` 仅作示例，冲突时替换为未占用端口：

```bash
mkdir -p .ui-review/xhs-workbench-x7-local
XHS_OPERATION_STATE_DIR="$PWD/.ui-review/xhs-workbench-x7-local/xhs-state" \
DSH_HOME="$PWD/.ui-review/xhs-workbench-x7-local/dsh-home" \
DSH_DESKTOP_USER_DATA_DIR="$PWD/.ui-review/xhs-workbench-x7-local/electron-user-data" \
DSH_DESKTOP_RENDERER_DEBUG_PORT=9334 \
DSH_DESKTOP_OPEN_DEVTOOLS=0 \
pnpm run start:desktop
```

启动日志必须显示：

1. `DSH_HOME` 与 `userData` 均位于 `.ui-review/xhs-workbench-x7-local/`；
2. Workbench MCP endpoint 保持生产 URL（本方案不设置 `YOOTUN_WORKBENCH_MCP_URL` 覆盖）；
3. renderer inspector 使用指定端口。

Playwright 通过 `chromium.connectOverCDP('http://127.0.0.1:9334')` 连接 renderer。自动化脚本保存在证据目录，不进入仓库。

## 5. 阶段 C：激活与扫码登录

1. 截取未激活门禁；操作者在 UI 中输入有效 yootun key；等待解锁后截取主界面；
2. 检查截图和日志中没有 key、Authorization、Cookie 或 storage_state；
3. 打开侧栏「小红书工作台」入口，确认三顶级 tab（爆款仿写 / 账号管理 / 车衣爆款看板）与默认选中爆款仿写；
4. 切到账号管理，确认 `browser.status` 可用（Chrome 缺失时出现顶部阻断提示并停止）；
5. 点击「添加账号」；Host 必须用 headed 系统 Chrome 打开真实小红书登录页；
6. **操作者扫码时停下通知**：出现二维码后暂停自动化，通知操作者扫码；不扫描截图或缓存图片；
7. 登录成功后账号列表刷新，记录测试账号 accountId（仅本地 manifest）。

通过标准：

- Cookie 命中不视为成功，必须读到 user/info 身份；
- 本地 `xhs-state/profiles/<accountId>/` 与 0600 `storage-state/<accountId>.json` 存在；
- `account.probe` 结果 ok，状态徽标呈「正常」；
- UI 不显示本地路径、Cookie 或 storage_state。

## 6. 阶段 D：爆款仿写全链路（§5.6 验收标准 1–3）

按 12 册 §3 区域顺序走查，每步截图：

| 步骤 | 操作 | 通过标准 |
|---|---|---|
| D1 素材上传 | 添加 ≤9 张图片（另跑一例视频） | 进度呈现；完成后得公网 URL（仅缩略态，不显示完整 URL 文本）；失败用例（临时断网或超限文件）错误行出现且**表单保留** |
| D2 提交创建 | 填主题/方向/对标笔记，提交 | task.create 幂等键随任务生成；右栏五态推进 |
| D3 重试不重复计费 | 取消进行中任务后立即同参数重新提交 | 新任务新幂等键；服务端确认无重复扣费口径（对照 tools.dofe.ai 任务记录） |
| D4 结果呈现 | 轮询至终态 | 单版本展示；可复制全文；「重新生成」走确认弹层 |
| D5 发布 | 选择已登录账号，点击打开 | publish.start 幂等受理；2s 轮询至 done；失败时稳定码文案（不吞错） |

验收对账：`workbench_xhs_task_create` / `workbench_xhs_task_get` / `workbench_xhs_result_get` 的 structuredContent 脱敏摘要与 UI 可见值一致。

## 7. 阶段 E：车衣爆款看板（§5.6 验收标准 4）

四子区依序走查并截图：

| 子区 | 操作 | 通过标准 |
|---|---|---|
| 总览 | 读 KPI、筛选 chips、列表 | 与 `workbench_xhs_hotboard_overview` 返回一致；缺口不补 0 |
| 关键词 | 双面板读 + 保存关键词 | 写操作有确认；回执就近出现在通知条；失败不改原列表 |
| 标签 | 提案审核 + 标签库编辑 | label_save/label_review 回执；幂等重放不产生重复 |
| 规则 | 只读 | 无写入口 |
| 笔记抽屉 / 运行抽屉 / 图片灯箱 | 打开、关闭、遮挡检查 | 抽屉与灯箱在最上层；Esc 关闭；灯箱图片可放大查看（右键下载行为记录现状，不在本方案内强求） |

## 8. 真实浏览器视觉与可达性矩阵

对爆款仿写、账号管理、看板总览三个页面执行：

| 条件 | 截图 |
|---|---|
| light/dark × 1120/880/640 px | 三页各一张，共 18 张 |

三档宽度以 `yootun-kit-page` 容器查询实际命中为准；manifest 记录容器宽度和主题状态。另补：

1. 结果编辑卡与发布面板：light/dark 1120px；
2. 看板列表表格转卡：640px light，确认横向滚动区域可获得键盘焦点；
3. 长昵称与长标题截断：640px light，确认完整 aria-label；
4. 键盘路径：tab 导航、ArrowRight/End 切顶级 tab、素材子 tab 键盘可达、确认弹层焦点陷阱、抽屉/灯箱 Esc 关闭；
5. reduced-motion：Playwright `reducedMotion: 'reduce'` 下检查进度条、状态点、页面切换计算样式中的 transition 为 `0s`。

任何布局溢出、焦点丢失、不可读对比度、假数据或错误状态伪装都算失败；不在截图上手工修图。

## 9. 阶段 F：未激活边界与清理

1. 退出激活（或用隔离 DSH_HOME 未激活态启动第二实例）：确认小红书工作台不发起任何 `workbench_xhs_*` 远端请求（网络面板为空）；§5.6 验收标准 6；
2. 全部读验证完成后清理：本地测试账号执行「移除本地账号」（确认弹层含账号名）；删除证据目录中的 `dsh-home/`、`electron-user-data/`、`xhs-state/`；
3. 保留截图、脱敏 manifest 和通过 / 失败汇总。

## 10. 证据 manifest

`.ui-review/xhs-workbench-x7-local/manifest.json` 记录：

| 字段 | 内容 |
|---|---|
| startedAt / finishedAt | Asia/Shanghai 时间 |
| yootunAgentCommit | `git rev-parse HEAD` |
| endpoint | 生产 Workbench URL（不含凭据） |
| serverName | `yootun-workbench` |
| toolCounts | 90 总量与 19 项 xhs 子集校验结果 |
| settingsKeys | settings 顶层键名 |
| accountId | 测试账号 ID，仅本地保存 |
| taskId / publishId | UI 与远端一致的标识 |
| themeWidthCases | 主题、容器宽度、tab、截图文件 |
| keyboardChecks | 每个路径的通过 / 失败 |
| reducedMotionChecks | 计算样式结果 |
| failures | 稳定错误码、复现步骤和关联截图 |

截图文件名使用 `NN-theme-width-page.png`。不把带 token 的 Desktop URL、激活 key、Authorization、Cookie、storage_state、二维码或未脱敏身份写入 manifest。

## 11. 通过标准

本地 X7 判定通过要求全部成立：

1. 生产 endpoint 冒烟五项检查全部通过；
2. 操作者完成真实扫码，登录、探活和本地状态迁移通过；
3. 上传得公网 URL；失败不丢表单；
4. 任务幂等创建、轮询终态、单版结果可复制、重新生成走确认；
5. 发布面板打开创作者中心并轮询到终态回执；
6. 看板写操作都有回执，失败不改变原数据；
7. 明暗 × 三档宽度 × 三页截图齐全；
8. 键盘路径与 reduced-motion 检查通过；
9. 未激活无远端请求成立；
10. 敏感运行状态与测试账号本地凭证清理完成；
11. manifest 记录所有失败、阻塞和未覆盖项。

出现以下任一情况立即停止：扫码身份不稳定或串号；发布面板打开非创作者中心域名；UI 显示假成功、假数据或吞掉稳定错误；系统 Chrome 打不开、驱动缺失或 Host API 非同源拒绝。

## 12. 仍需后续验证

本地链路通过后，X7 仍需：

1. Windows 真机扫码、采集、发布、重启保留状态和升级验收（打包产物安装后由操作者执行）；
2. macOS 打包产物启动检查（如需分发）；
3. 灯箱右键下载等旧交互细节按真机复核结果决定是否补齐。
