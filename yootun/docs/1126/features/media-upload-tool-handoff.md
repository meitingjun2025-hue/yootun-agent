# media-upload-会话工具承接卡片 实施单

状态：已合入 `main`（2026-11-26，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现象

`@yootun/dsh-media-upload` 把会话工具 `media_upload` 注册进 `ctx.tools`，普通会话的模型可以调用。工具创建一个上传会话后等待用户「在插件页面选择文件」，预算 30 分钟。但没有任何页面或路由列出工具创建的待处理会话：`UploadSessionRegistry.ids()` 只在测试中使用，小红书页面的上传机只轮询自己经 `pick-file` 创建的会话。模型一旦调用，用户无从响应，工具必然以 `upload_timeout` 结束。

### 0.2 目标

模型调用 `media_upload` 后，页面在 3 秒内弹出「上传请求」卡片；用户在卡片内用原生文件选择器选文件，字节经既有 `uploadStart` 路由回流宿主并直传，卡片显示进度，完成后工具返回公网 URL。卡片标注本次请求的短编号：工具执行上下文只有工具调用标识、没有会话标识，无法标注来源会话。用户可以取消，工具在 2 秒内返回 `user_cancelled`。页面自己发起的上传（小红书爆款仿写页）不触发卡片。

## 1. 范围

做：

- 上传会话标记来源：`pick-file` 创建的是 `page`，会话工具创建的是 `tool`；
- 新增只读路由 `POST /_dsh/uploader/pending`：返回工具创建且仍在等待或上传中的会话；
- 新增路由 `POST /_dsh/uploader/cancel`：取消一个进行中的会话，工具侧得到 `user_cancelled`；
- media-upload 新增 client 半：在 `shell.overlay` 注册「上传请求」卡片，轮询 `pending`、选文件、看进度、取消；
- 会话工具的描述与取消语义同步；
- 构建面切换：`tsdown.config.ts` 改用官方 `clientBundle`，`package.json` 增加 `./client` 导出与 `dsh.client` 声明。

不做：

- 不改 tools、docker-helm；
- 不改小红书页面现有的上传流程与 `upload-machine.ts`（它继续用 `pick-file` 创建 `page` 会话）；
- 不改四个既有路由的入参与出参；
- 不做卡片与具体会话的深度链接（卡片只标注来源会话标识，不跳转）；
- 不做多个待处理会话的排队策略（逐张卡片，最多同时显示 3 张，其余折叠计数）。

## 2. 契约增量

MCP 工具：无。均为本地同源路由与插件内部契约。

### 2.1 会话来源

| 字段 | 取值 | 写入方 |
|---|---|---|
| `origin` | `'page'` ｜ `'tool'` | `pick-file` 写 `page`；会话工具写 `tool` |
| `context` | 可选 `{ sessionId?: string; toolCallId?: string }` | 会话工具在 `exec` 提供标识时写入；`pick-file` 会话不写。dsh-tools 的执行上下文目前只有 `callId`（写入 `toolCallId`），`sessionId` 恒缺省 |

`context` 只保存标识，不保存任何输入内容；投影给页面时原样返回，缺失时省略键。

### 2.2 `POST /_dsh/uploader/pending`

| 项 | 内容 |
|---|---|
| 请求 | `content-type: application/json` 可省略（省略时不读体）；带 content-type 时必须是 JSON（否则 415），有体时必须是对象且不含任何字段，否则 400 `invalid_request` |
| 响应 200 | `{ sessions: Array<{ uploadId, kind, state: 'waiting' \| 'uploading', progress, createdAt, context? }> }` |
| 过滤 | 只含 `origin === 'tool'` 且 `state ∈ { awaiting, uploading }` 的会话，按创建时间升序 |
| 字段 | `state` 沿用 `uploadStatus` 的口径（awaiting → waiting）；`progress` 取整 0..100；不含 name / size / contentType / url / 本地路径 |
| 信任判定 | 与既有四路由同一 `permitted()` |
| 幂等 | 只读 |

### 2.3 `POST /_dsh/uploader/cancel`

| 项 | 内容 |
|---|---|
| 请求 | `{ uploadId: string }`，拒绝未知字段 |
| 效果 | 会话在 awaiting / uploading：abort 其 controller，终态 `failed`，错误码 `user_cancelled`；进行中的 PUT 被中止，暂存文件按既有失败路径清理 |
| 响应 200 | `{ cancelled: true }` 或 `{ cancelled: false, reason: 'not_running' }` |
| 响应 403 | `{ error: 'session_not_found' }`（uploadId 不存在或已过期） |
| 适用会话 | 不限来源；页面会话也可用该路由取消（本单不接入小红书页面） |

### 2.4 会话工具

| 项 | 现状 | 变更 |
|---|---|---|
| 会话创建 | `registry.create(kind)` | `registry.create(kind, 'tool')`，`exec` 含 `sessionId` / `toolCallId` 时写入 `context` |
| 取消来源 | 只有工具自身的超时与 `exec.signal` | 新增路由取消：会话先落 `user_cancelled`，工具读快照返回 `{ ok: false, error: 'user_cancelled' }` |
| 描述 | 「请求用户在插件页面通过文件选择器亲手选择文件」 | 改为：调用后应用会弹出「上传请求」卡片，请提示用户在卡片中选择文件；用户可取消，取消时返回 `user_cancelled`；工具不接受任何本地路径 |
| 输出 schema | 不变 | 不变 |

### 2.5 稳定码

无新增。`user_cancelled`、`upload_cancelled` 为既有取值；`not_running` 只出现在路由响应的 `reason`，不进入会话错误码。

### 2.6 词典新增（`src/client/locales.ts`，zh 为键集事实源，en 成对）

| 键 | zh | en |
|---|---|---|
| `handoff.title` | 上传请求 | Upload request |
| `handoff.requestRef` | 请求编号 {id} | Request {id} |
| `handoff.hint` | 智能体需要一份文件：请在下方选择，选好后自动上传 | The assistant needs a file: pick one below and it uploads automatically |
| `handoff.pick` | 选择文件 | Choose file |
| `handoff.picking` | 正在上传 {progress}% | Uploading {progress}% |
| `handoff.done` | 已上传 | Uploaded |
| `handoff.cancel` | 取消 | Cancel |
| `handoff.failed` | 上传失败：{reason} | Upload failed: {reason} |
| `handoff.retry` | 重新选择 | Choose again |
| `handoff.dismiss` | 关闭 | Dismiss |
| `handoff.more` | 另有 {count} 个上传请求 | {count} more upload requests |
| `handoff.reason.file_too_large` | 文件超过大小上限 | File exceeds the size limit |
| `handoff.reason.extension_not_allowed` | 文件类型不支持 | File type not supported |
| `handoff.reason.upload_timeout` | 上传超时，请重试 | Upload timed out, try again |
| `handoff.reason.default` | 请重新选择文件 | Choose the file again |

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无工具变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无新路由 / 队列 / env |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/sessions.ts` | `origin` / `context` 字段；`create(kind, origin)`；`pendingToolSessions()` 投影；`cancel(id)` | 是 | 会话注册表是状态唯一所有者 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/constants.ts` | `PENDING_PATH`、`CANCEL_PATH` | 是 | 路由常量单一来源 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/routes.ts` | 两条新路由 | 是 | 路由信任判定与体上限复用 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/tool.ts` | 会话来源、`context`、描述 | 是 | 会话工具入口 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/index.ts` | 导出新常量与类型 | 是 | 包导出面 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/client/{index.ts,handoff-card.tsx,upload-api.ts,locales.ts,handoff.module.css}`、`src/css-modules.d.ts` | 新增 client 半 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-media-upload/package.json` | `exports["./client"]`、`dsh.client`、build / test 脚本、`files` | 是 | client 半的打包与发现 |
| yootun-agent | `yootun/plugins/dsh-media-upload/tsdown.config.ts` | 改用 `clientBundle` | 是 | 双面构建 |
| yootun-agent | `yootun/plugins/dsh-media-upload/vitest.config.ts`、`tests/client/*.test.tsx` | client 测试 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/plugins/dsh-media-upload/tests/media-upload.test.ts` | Host 新用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/08-plugin-mcp.md` §6 | 补承接卡片与两条路由 | 是 | 分册是桌面接入契约记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

打包闭包：`pack-local-packages.ts` 已按 `--filter=@yootun/*` 收录本包；client 产物与样式走官方 `clientBundle` 机制，与三个工作台相同，不改闭包脚本。实现后用 `verify-plugin-runtime-bundle.mjs` 与 `verify-bundle-stylesheets.mjs` 核对。

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 08 册 §6 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查；审查通过后提交 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-26 | `feat/media-upload-tool-handoff`（基于 `feat/xhs-collect-cancel-and-publish-state`） | 包内 `test`（node --test 35 用例、vitest 12 用例）、`build`（含两个 bundle 校验）、小红书包 `test` / `build` 回归、`pnpm --filter '@yootun/*' run build`、仓库根 `pnpm run build`（10 门）、`pnpm run lint`、`typecheck`、三个 verify 脚本与 `test:docs` 通过，验收独立复跑结果一致；真机验收见 5.2 |
| yootun-agent 合入 `main` | 2026-11-26 | `main` | 随 P0 八张批次一并合入（顶点分支 `feat/activation-gate-and-model-catalog`，合并无冲突），真机验收见 5.2 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-media-upload test` 通过（node --test：附录 B.1；vitest：附录 B.2）；
- [ ] `pnpm --filter @yootun/dsh-media-upload build` 通过，含 `verify-plugin-runtime-bundle.mjs` 与 `verify-bundle-stylesheets.mjs`；
- [ ] `pnpm --filter @yootun/dsh-xhs-workbench test`、`build` 通过（上传机未改，回归确认）；
- [ ] `pnpm --filter '@yootun/*' run build` 与 `pnpm run build` 通过，安装包内本包带 client 产物；
- [ ] `pnpm run lint`、`pnpm run verify-client-ui-i18n`、`pnpm run verify-export-jsdoc`、`pnpm run verify-empty-catch` 对改动文件无新告警；
- [ ] 附录 B 的用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| H1 | 普通会话里让模型「上传一张本地图片并把链接给我」 | 模型调用 `media_upload` 后 ≤3 秒出现「上传请求」卡片，标注本次请求的短编号（执行上下文没有会话标识，不标注来源会话） |
| H2 | 卡片内点「选择文件」，选一张 jpg | 卡片显示上传百分比；完成后显示「已上传」并在 2 秒后收起；模型收到公网 URL 并回复 |
| H3 | 重复 H1，卡片出现后点「取消」 | 卡片收起；模型在 2 秒内收到取消结果并告知用户 |
| H4 | 重复 H1，选一个超出上限的文件或不在白名单的类型 | 卡片显示失败原因与「重新选择」；重新选择合法文件后成功 |
| H5 | 小红书爆款仿写页正常选图、上传 | 不出现「上传请求」卡片；既有流程不变 |
| H6 | 让模型同时发起两个上传请求 | 两张卡片并列；超过 3 个时折叠计数 |
| H7 | 卡片出现后切到其他应用 30 秒再切回 | 隐藏期间不轮询；切回后状态与实际一致 |
| H8 | 明暗主题、三档宽度（≥1120 / 880 / 640 px） | 卡片完整可读，不遮挡 composer 与侧栏关键操作 |
| H9 | 按 `record-browser-gif` 流程录制「模型请求上传 → 卡片选文件 → 得到链接」片段 | GIF 附在 PR |

### 5.3 本地联调记录

- 联调环境：本仓工作区（Linux/WSL2），分支 `feat/media-upload-tool-handoff`，Host 半以真实 Cordis 组合 + 假授权/假 TOS 驱动（`tests/media-upload.test.ts`），client 半以 jsdom + 假同源路由（全局 fetch 桩）驱动（`tests/client/handoff-card.test.tsx`）。浏览器/桌面实机联调未做，全部留在 5.2。
- 覆盖项：附录 B.1 H1–H8、B.2 C1–C9 每条均有对应用例并通过；5.1 自动验收命令全部本地执行通过（media-upload test 35+11、build 含双校验、xhs test 15+33 与 build、`@yootun/*` build、仓库根 build、lint/typecheck/i18n/jsdoc/empty-catch/test:docs）。
- `exec` 上下文字段核对结果：`@deepseek-ai/dsh-tools` 执行上下文（`ToolRunContext`）携带 `callId: ToolCallId`（模型调用标识），不携带 sessionId；`contextOf` 经 `typeof exec.callId === 'string'` 判定后映射为 `context.toolCallId`，`sessionId` 恒缺省（2.1 的 context 键集不变）。
- 按实现修订的预期：
  - `UploadSessionRegistry.settleFailed` 增加终态守卫（终态会话保留先落错误码），这是 A1「后到 abort 回调不改写终态」的落地；既有调用点行为不变（dispose/过期路径先于管线 settle）。
  - client 半 `sendUploadBytes` 返回 `{ ok, error? }`（小红书副本为 boolean），`pollUploadStatus` 增加 `error` 透出：承接卡片需要 uploadStart 的稳定码映射失败原因（H4）；小红书副本按单不改。
  - `verify-bundle-stylesheets.mjs` 按本包适配：本包不依赖 dsh-client-ui-kit，仅校验自身 `handoff.module.css` 的安装元数据与冻结类名（wx 版的 kit 页壳断言不适用）。
  - A6 的「按 `--dsh-frame-*` 安全区变量留白」：frame 变量只有顶部（`--dsh-frame-top-clearance`/`--dsh-frame-overlay-top`）与前导带（`--dsh-frame-leading-clearance`），右下角无对应变量；卡片以 16px 视口边距对齐 `--dsh-frame-overlay-top` 的 20px 边距量级，宽度按单执行。
  - `tsconfig.json` 由 Host face 切到 client base（`tsconfig.base.client.json` + node/client types），Host 半与 client 半同一程序编译——xhs/wx 双半插件同款；references 增补 locale/ui-primitives/ui-slots/ui-layout/ui-renderer。
- 留在 5.2 的未覆盖项：H1–H9 全部真机步骤（含 GIF 录制）待用户执行。

## 附录 A：逐文件规格

### A1 `src/sessions.ts`

- `UploadSession` 增 `origin: 'page' | 'tool'` 与 `context?: { sessionId?: string; toolCallId?: string }`；
- `create(kind: string, origin: 'page' | 'tool' = 'page', context?: UploadSession['context'])`；`snapshot()` 不变；
- 新增 `pendingToolSessions(): Array<{ uploadId: string; kind: string; state: 'waiting' | 'uploading'; progress: number; createdAt: string; context?: UploadSession['context'] }>`：遍历 `sessions`，先对每个会话调用一次 `snapshot()` 触发惰性过期，再过滤 `origin === 'tool'` 且 `state ∈ { awaiting, uploading }`，按 `startedAt` 升序；`progress` 与 `uploadStatus` 同一算式；
- 新增 `cancel(id: string): 'cancelled' | 'not_running' | 'not_found'`：不存在 → `not_found`；终态 → `not_running`；否则 `controller.abort()` 并 `settleFailed(session, 'user_cancelled')` → `cancelled`；`settleFailed` 对已终态会话保留先落的错误码（后到的管线 / 超时回调不改写）。上传管线在 catch 里读到 `user_cancelled`，按既有路径清理暂存；abort 监听里 `exec?.signal?.aborted === true ? 'user_cancelled' : 'upload_timeout'` 的分支只服务工具超时，路由取消先落终态，后到的 abort 回调被 `settle` 的幂等判定挡住；
- `destroy()` 不变。

### A2 `src/routes.ts`

- `PENDING_PATH` handler：`POST` → `permitted()` → admission → 可选 JSON 体（`readJson`；有体时键集合必须为空）→ `finishJson(200, { sessions: deps.registry.pendingToolSessions() })`；
- `CANCEL_PATH` handler：`POST` → `permitted()` → admission → JSON 体只允许 `uploadId`（≤128）→ 调 `registry.cancel`：`cancelled` → 200 `{ cancelled: true }`；`not_running` → 200 `{ cancelled: false, reason: 'not_running' }`；`not_found` → 403 `{ error: 'session_not_found' }`；
- 两个 handler 的 `finally` 与既有路由相同：`await responseSettled(res)` 后 `admission.release()`；
- 路由表在既有四条之后追加两条，`index.ts` 的注册循环不变。

### A3 `src/tool.ts`

- `execute`：`deps.registry.create(kind, 'tool', contextOf(exec))`；`contextOf` 只在 `exec` 对象上存在字符串类型的 `sessionId` / `toolCallId` 时返回对象，不做类型断言，字段名以 `@deepseek-ai/dsh-tools` 的执行上下文类型为准（实现时核对，结果记入 5.3）；
- 终态判定不变：快照 `state !== 'done'` → `{ ok: false, error: snapshot?.error ?? 'upload_failed' }`，路由取消时 `error` 为 `user_cancelled`；
- 描述按 2.4 改写；输出 schema 与 `render` 不变。

### A4 `src/client/upload-api.ts`

- 从小红书 `src/client/api.ts` 复制上传传输函数（`uploadFetch`、`sendUploadBytes`、`pollUploadStatus`），新增 `pendingUploads()` 与 `cancelUpload(uploadId)`；路径常量从 `../constants.ts` 导入；
- `uploadFetch` 保持「非 2xx 或非 JSON 返回 null」的口径；本单不改小红书的副本（两份合并见 P1 的 [upload-experience-fixes.md](upload-experience-fixes.md)）。

### A5 `src/client/locales.ts`

- `zh` 为键集事实源，`en: Record<HandoffLocaleKey, string>`；命名空间 `yootun.mediaUpload`，经 `declare module '@deepseek-ai/dsh-client-ui-slots'` 的 `LocaleNamespaceMap` 登记。

### A6 `src/client/handoff-card.tsx`

- 状态机（每个会话一份）：`picking`（等待选文件）→ `uploading` → `done`（2 秒后移除）｜`failed`（显示原因，可「重新选择」或「关闭」）；取消后立即移除；
- 轮询：挂载且 `document.visibilityState === 'visible'` 时每 3000ms 调 `pendingUploads()`；`visibilitychange` 时隐藏即停、可见立即拉一次；组件卸载清除定时器与在途请求的代次守卫；
- 服务端返回的会话集合是事实源：不在 `pending` 里的本地面板条目立即移除（避免宿主已取消或过期后卡片残留）；本地已进入 `uploading` 的条目在 `pending` 仍含该 id 时保留本地进度视图；`pending` 请求暂态失败（非 2xx / 载荷不合法）不等于已清空，跳过对账并保留本地条目；本地已终态（done / failed）的条目不被对账移除；
- 选文件：`<input type="file" accept={accept.join(',')}>` 隐藏，`pick` 按钮触发；选中后 `sendUploadBytes({ uploadId, file })`；接受后每 1000ms `pollUploadStatus`；`done` 不展示 URL（URL 由工具返回模型），`failed` 显示 `reason` 经词典映射；
- 取消：`cancelUpload(uploadId)` 成功后立即移除；请求失败保留卡片并重试一次；
- 可访问性：卡片 `role="status"` + `aria-live="polite"`；进度用文本百分比；按钮均有可见文案；不拦截 Escape（必须选择或取消）；新卡片出现不抢焦点；
- 布局：`position: fixed` 右下角，16px 视口边距（frame 安全区变量只有顶部与前导带，右下角无对应变量）；宽度 `min(360px, calc(100vw - 32px))`；层叠低于官方 Modal；
- 视觉：`--dsw-alias-bg-layer-2`、`--dsw-radius-panel`、`--dsw-elevation-prominent`；无字面色值；`prefers-reduced-motion` 下无入场动画。

### A7 `src/client/index.ts`

- 函数插件：`name = 'yootun-media-upload-client'`，`inject = ['slots', 'locale']`；`ctx.effect(() => ctx.locale.register(NS, { zh, en }))`；`ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'yootun-media-upload.handoff', locale: NS }, HandoffCard)))`；
- 导出 `NS` 与 `HandoffCard` 类型。

### A8 `package.json` / `tsdown.config.ts` / 测试配置

- `package.json`：`exports` 增 `"./client"`（产物路径以官方 `clientBundle` 输出为准，与视频号包一致）；`dsh.client = { inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-slots'], platform: 'web' }`；`build` 改为 `tsc -p tsconfig.json && tsdown && node tests/client/verify-bundle-stylesheets.mjs && node ../../scripts/verify-plugin-runtime-bundle.mjs`；`test` 追加 `&& vitest run`；`files` 含 client 产物；devDependencies 对齐视频号包；
- `tsdown.config.ts` 与视频号包相同：`clientBundle(import.meta.dirname, ['lib/types/index.js'])`；
- `src/css-modules.d.ts`、`vitest.config.ts`、`tests/client/verify-bundle-stylesheets.mjs` 从视频号包复制并改包名；
- `description` 更新为含「会话工具承接卡片」。

## 附录 B：测试矩阵

### B.1 Host（`tests/media-upload.test.ts`）

| ID | 断言 |
|---|---|
| H1 | `pick-file` 会话 `origin === 'page'`；会话工具创建的会话 `origin === 'tool'` |
| H2 | `pending` 不含 `page` 会话与终态会话；含 `waiting` 与 `uploading` 的 `tool` 会话，按创建时间升序；响应不含路径、URL、name |
| H3 | `pending` 有体且含字段 → 400 `invalid_request`；非 POST → 405；来源不信任 → 403 |
| H4 | `cancel` 对 awaiting 会话：`cancelled: true`，会话 `failed` + `user_cancelled`；工具 `execute` 返回 `{ ok: false, error: 'user_cancelled' }` |
| H5 | `cancel` 对 uploading 会话：中止 PUT，暂存文件被清理，响应 `cancelled: true` |
| H6 | `cancel` 对终态 → `not_running`；对未知 id → 403 `session_not_found`；体含未知字段 → 400 |
| H7 | `exec` 带 `sessionId` / `toolCallId` 时 `pending` 投影带 `context`；不带时省略键 |
| H8 | dispose 后 `pending` / `cancel` 返回 503 `uploader_not_configured`，不触碰会话 |

### B.2 client（`tests/client/handoff-card.test.tsx`）

| ID | 断言 |
|---|---|
| C1 | `pending` 返回 1 个 waiting 会话 → 渲染 1 张卡片与「选择文件」；返回空 → 不渲染 |
| C2 | 选中文件 → 调 `uploadStart` 且头携带该 `uploadId`、文件名、类型、大小；随后按 1s 轮询状态 |
| C3 | 状态 `done` → 显示「已上传」，2000ms 后移除 |
| C4 | 状态 `failed` → 显示映射后的原因与「重新选择」；重新选择合法文件后成功 |
| C5 | 点「取消」→ 调 `cancel`；成功后卡片移除；请求失败保留卡片并重试一次 |
| C6 | `document.visibilityState` 变为 hidden 时停止轮询；恢复 visible 立即拉取一次 |
| C7 | `pending` 不再包含某本地 waiting 条目 → 该条目移除 |
| C8 | 超过 3 个待处理会话 → 显示折叠计数 |
| C9 | 词典 zh / en 键集一致；无硬编码文案（`verify-client-ui-i18n`） |
| C10 | `pending` 暂态失败（非 2xx / 载荷不合法）不等于服务端已清空：本地条目保留，服务端明确返回空集合才移除 |
