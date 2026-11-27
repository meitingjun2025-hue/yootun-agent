# media-upload-上传体验与边界修复 实施单

状态：已合入 `main`（2026-11-27，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

前置：P0 的 [media-upload-tool-handoff.md](media-upload-tool-handoff.md) 已合入（media-upload 已有 client 半）。

## 0. 背景与目标

### 0.1 现状

- **上传成功后结果只保留 60 秒。** `UploadSessionRegistry` 的 `DEFAULT_DONE_TTL_MS = 60_000`（`yootun/plugins/dsh-media-upload/src/sessions.ts`），而等待选文件的会话保留 10 分钟。小红书爆款仿写页的上传机在面板关闭时停止轮询、重开时恢复；页面在后台时浏览器会把定时器节流到每分钟一次。上传完成后超过 60 秒才来查询的页面拿到 `not_found`，上传机按「从未收到过 done」记为失败（`src/upload-machine.ts`），而文件其实已经传上去，用户重传一次。
- **`UNAUTHORIZED` 被映射成存储授权失败。** `SERVER_CODE_MAP`（`src/errors.ts`）把服务端的 `UNAUTHORIZED` 映射为 `storage_auth_failed`。在 tools 侧，`UNAUTHORIZED` 的唯一来源是「没有可信的网关身份」（`services/tos_upload/authorize.py`），也就是激活密钥无效或未激活；存储侧凭证失败的稳定码是 `STORAGE_AUTH_FAILED`。用户看到的是「存储授权失败」，会去怀疑对象存储，而真正该做的是重新激活。
- **异常退出后暂存目录永久残留。** 暂存目录在系统临时目录下以 `yootun-media-` 为前缀懒创建（`src/staging.ts`），只在插件正常卸载时删除。进程崩溃或被强杀后目录留在磁盘上，下次启动没有任何清理，每个残留目录最大可占一个文件的上限（缺省 500MB）。
- **内网地址过滤对 IPv4-mapped IPv6 不起作用。** `isForbiddenPublicHost`（`src/authorize.ts`）用字符串前缀判断。WHATWG URL 解析器会把 `[::ffff:10.0.0.1]` 规范化为 `[::ffff:a00:1]`，函数里唯一一条 mapped 规则 `host === '::ffff:127.0.0.1'` 对 URL 解析出的主机名永远不成立；`::ffff:10.0.0.1`、`::ffff:169.254.169.254` 等一律放行。同类缺口还有 `fe80::/10` 只匹配 `fe80:` 前缀（漏掉 `fe90:`–`febf:`）、NAT64 与 6to4 嵌入的 IPv4、以及 `localhost.` 和 `*.localhost`。授权响应来自可信服务端，这个函数是纵深防御，但既然存在就应当成立。
- **上传传输函数有两份。** 小红书 `src/client/api.ts` 与 P0 的 media-upload client 半各有一份 `startUploadSession` / `sendUploadBytes` / `pollUploadStatus`。

### 0.2 目标

上传结果在合理时间内可查；错误码与真实原因对应；临时目录不跨启动累积；内网过滤对所有写法成立；上传传输函数只有一份。

## 1. 范围

做：

- `done` 状态的保留时长改为 10 分钟；
- `UNAUTHORIZED` 映射为 `uploader_not_configured`，并在承接卡片的词典里给出「密钥未激活或无权限」的文案；
- 暂存目录名带进程号；启动时清理已不存在进程遗留的目录与旧命名的过期目录；
- `isForbiddenPublicHost` 改为按地址块判断，覆盖 IPv4、IPv6、mapped、NAT64、6to4 与 localhost 变体；
- 上传传输函数上移到 `@yootun/dsh-client-ui-kit`，小红书与 media-upload 的 client 半消费同一份。

不做：

- 不改会话工具 `media_upload` 的入参与出参；
- 不改四个既有路由的入参；
- 不做断点续传与失败自动重试；
- 不做域名解析后的地址校验（过滤只看主机名字面量；授权响应来自可信服务端）；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 会话保留

| 状态 | 现状 | 变更 |
|---|---|---|
| `done` | 60 秒 | 10 分钟（与 `awaiting` 相同） |
| `failed` | 随 `done` TTL | 不变（同为 10 分钟） |
| `awaiting` | 10 分钟 | 不变 |
| 孤儿（未绑定字节的旧会话） | 30 分钟 | 不变 |

### 2.2 错误码映射

| 服务端码 | 现状 | 变更 |
|---|---|---|
| `UNAUTHORIZED` | `storage_auth_failed` | `uploader_not_configured` |
| `STORAGE_AUTH_FAILED` | `storage_auth_failed` | 不变 |
| `STORAGE_UNAVAILABLE` | `storage_unavailable` | 不变 |
| `UPLOAD_SIZE_EXCEEDED` / `UPLOAD_TYPE_NOT_ALLOWED` / `VALIDATION_ERROR` | 不变 | 不变 |
| 其余 | `upload_authorization_invalid` | 不变 |

对外错误码集合 `ERROR_CODES` 不变。

### 2.3 暂存目录

- 目录名由 `yootun-media-<随机>` 改为 `yootun-media-<pid>-<随机>`；
- 启动清理规则（只针对系统临时目录下本插件命名的目录）：

| 目录名形态 | 条件 | 动作 |
|---|---|---|
| `yootun-media-<pid>-…` | 该 pid 的进程已不存在 | 删除 |
| `yootun-media-<pid>-…` | 该 pid 的进程仍在 | 保留（另一个运行中的实例） |
| `yootun-media-<随机>`（旧命名） | 修改时间早于 24 小时 | 删除 |
| 同上 | 24 小时内 | 保留 |

- 清理是尽力而为：读目录或删除失败只记一条告警，不阻断启动，不影响路由注册；
- 清理任务登记进任务表，卸载时等待其结束。

### 2.4 `isForbiddenPublicHost`

判定输入是 `URL.hostname`。主机名去方括号、转小写、去掉结尾的点之后：

| 类别 | 命中条件 |
|---|---|
| 主机名 | 空串；`localhost`；以 `.localhost` 结尾 |
| IPv4 字面量 | 落在下列地址块：`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`、`127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.168.0.0/16`、`224.0.0.0/4`、`240.0.0.0/4` |
| IPv6 字面量 | 落在下列地址块：`::/128`、`::1/128`、`fc00::/7`、`fe80::/10`、`ff00::/8`、`::ffff:0:0/96`、`64:ff9b::/96`、`64:ff9b:1::/48`、`2002::/16` |
| 其他名称 | 不命中 |

地址块判断用 `node:net` 的 `BlockList`，不用字符串前缀。`::ffff:0:0/96` 整段拒绝：映射到公网 IPv4 的字面量主机名不是对象存储会返回的形态，整段拒绝比逐个换算更简单也更严。

### 2.5 kit 上传传输模块

`@yootun/dsh-client-ui-kit` 新增 `createUploadTransport(paths)`，返回 `{ startSession(kind), sendBytes({ uploadId, file }), pollStatus(uploadId) }`；`paths` 为四个路由路径常量。返回值与小红书现有函数一致（失败返回 `null`，由调用方归一）。

### 2.6 词典

| 位置 | 键 | zh | en |
|---|---|---|---|
| media-upload `src/client/locales.ts`（P0 的词典） | `reason.uploader_not_configured` | 密钥未激活或无权限，请到设置重新激活 | The key is not activated or lacks access; activate it in Settings |
| 同上 | `reason.storage_auth_failed` | 存储授权失败，请稍后重试 | Storage authorization failed; retry later |

若 P0 的词典已用通用文案覆盖这两个码，只改文案，不新增键。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无（`UNAUTHORIZED` 的含义不变） | 否 | 契约不变 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/sessions.ts` | `DEFAULT_DONE_TTL_MS` | 是 | 结果保留 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/errors.ts` | `SERVER_CODE_MAP` | 是 | 错误码对应 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/{staging.ts,index.ts}` | 目录名带 pid；启动清理 | 是 | 临时目录不累积 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/authorize.ts` | `isForbiddenPublicHost` | 是 | 内网过滤 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/client/{locales.ts,handoff-card.tsx}` | 文案 | 是 | 可读错误 |
| yootun-agent | `yootun/packages/dsh-client-ui-kit/src/{upload-transport.ts,index.ts}`、`tests/kit.test.tsx` | `createUploadTransport` | 是 | 第二个消费者 |
| yootun-agent | `yootun/plugins/dsh-xhs-workbench/src/client/api.ts` | 改为消费 kit，删除本地三函数 | 是 | 去重 |
| yootun-agent | `yootun/plugins/dsh-media-upload/tests/media-upload.test.ts` | 用例更新与新增 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/08-plugin-mcp.md` §6 | 上传会话保留时长与暂存目录清理条款 | 是 | 上传是 08 册的契约面 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 08 册 §6 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-27 | `feat/upload-experience-fixes`（基于 `feat/mount-restore-login-alignment`） | media-upload / client-ui-kit / xhs 三包 test 与 build、`lint`、`typecheck`、verify 脚本、`test:docs` 全过；附录 B D1/D2、E1/E2、T1–T5、F1–F5、K1 全部落地 |
| yootun-agent 合入 `main` | 2026-11-27 | `main` | 随 P1 八张批次一并合入（含验收审查修复），真机验收见 5.2 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-media-upload test`、`build` 通过（含 P0 引入的 client bundle 校验）；
- [ ] `pnpm --filter @yootun/dsh-client-ui-kit test`、`build`，`pnpm --filter @yootun/dsh-xhs-workbench test`、`build` 通过；
- [ ] `pnpm run lint`、`pnpm run verify-client-ui-i18n`；
- [ ] 附录 B 用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| E1 | 小红书爆款仿写页上传一张图片，上传中关闭面板，2 分钟后重开 | 该图片显示为已上传，不要求重传 |
| E2 | 小红书爆款仿写页上传一个较大的视频，上传期间把窗口最小化 3 分钟再恢复 | 进度继续更新并完成；不出现失败后重传 |
| E3 | 普通会话让模型调用 `media_upload`，在承接卡片里选文件并完成 | 卡片显示「已上传」 |
| E4 | 在设置里移除激活 Key（回到未激活状态）后，用另一台已激活设备触发上传授权被拒的情形；或在测试环境用一个无权限的 Key | 失败原因为「密钥未激活或无权限」，不是「存储授权失败」 |
| E5 | 在系统临时目录下手工放置：一个 `yootun-media-999999-abc`（不存在的进程）、一个当前进程号的同名目录、一个修改时间在前一天的 `yootun-media-abc123`；重启应用 | 前者与旧命名目录被删除，当前进程号的目录保留；启动耗时无可感知变化 |
| E6 | 上传功能整体回归：小红书图片与视频上传、承接卡片上传 | 行为与之前一致 |

### 5.3 本地联调记录

与实施单的出入及处理（单上文字随实现修订）：

- 2.4 的地址块判定按协议族分表：node BlockList 混入 IPv4 与 IPv6 子网时，IPv4 查询会被归一进 `::ffff:0:0/96`（该段覆盖全部映射 IPv4），公网 IPv4（如 8.8.8.8）会被误拒（F2 用例实证）；实现为 `BLOCKED_V4` / `BLOCKED_V6` 两张表，按主机名是否含 `:` 走对应表（mapped 主机名含 `:`，`::ffff:0:0/96` 整段拒绝语义不变）；
- 2.5 kit `sendBytes` 返回 `{ ok, error? }` 超集而非布尔：media-upload 承接卡片需要从 uploadStart 拒绝响应提取稳定错误码（`reason.uploader_not_configured` 文案的来源）；小红书 `api.ts` 以布尔包装保持调用方签名不变（A5 原文「返回值与小红书现有函数一致」按此修订）；
- T1 用例以 pngBytes + image/png 驱动 stage（'abc' 字面量不满足 MIME 魔数与 text/plain 的校验面）；T2 的 kept 计数不含非 `yootun-media-` 前缀目录（前缀外的条目不进 sweep 循环）。

改动过的既有用例（单上写明的行为变化所致）：mapServerErrorCode 旧映射断言（UNAUTHORIZED → uploader_not_configured，嵌套与顶层两种形态 + 集成用例的 snapshot.error）。

验收轮 1（独立子代理）发现并已处理：D1/D2 去掉显式 `doneTtlMs`（原写法掩盖缺省常量回退——改回 60s 时全套测试仍绿），断言作用于缺省值；T5 按矩阵原文补「逐项删除失败」路径（r-x 目录 chmod 触发 EACCES，每项告警、继续处理、失败项计 kept），替换原 tmpDir 读失败形态（实现行为正确，原用例未覆盖矩阵原文且未按惯例声明，已补记）；media-upload client `upload-api.ts` 三条路由路径改从 `constants.ts` 导入（原字面量与既有常量并存会静默漂移）；sessions.ts JSDoc 出处由 mount-restore 2.1 改正为本单 2.1。记录项：kit `pollStatus` 投影比小红书原实现多 `error` 字段（media-upload 卡片确需；xhs `upload-machine` 不读该字段，惰性兼容）；xhs `sendUploadBytes` 布尔包装行无直测（kit 契约由 K1 护住）。

未核对项：真机验收 E1–E6。

未核对项：真机验收 E1–E6。

## 附录 A：逐文件规格

### A1 `src/sessions.ts`

`DEFAULT_DONE_TTL_MS = 10 * 60_000`。清理逻辑不变（sweep 按各状态的 TTL 判断）。

### A2 `src/errors.ts`

`SERVER_CODE_MAP` 中 `['UNAUTHORIZED', 'storage_auth_failed']` 改为 `['UNAUTHORIZED', 'uploader_not_configured']`。

### A3 `src/staging.ts` 与 `src/index.ts`

- `mkdtemp(join(tmpdir(), `yootun-media-${String(process.pid)}-`))`；
- 新增导出 `sweepStaleStagingDirs(options: { tmpDir?: string; now?: () => number; isAlive?: (pid: number) => boolean; warn?: (message: string) => void }): Promise<{ removed: number; kept: number }>`，规则见 2.3；
- `isAlive` 缺省实现：`process.kill(pid, 0)` 返回或抛 `EPERM` 视为存活，抛 `ESRCH` 视为不存在，其余错误视为存活（宁可保留）；
- `index.ts` `apply`：`registry.track(staging.sweepStale(...))`——不 await，路由注册不被清理阻塞；卸载经任务表等待。

### A4 `src/authorize.ts`

```ts
import { BlockList } from 'node:net'

const blocked = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(net!, bits!, 'ipv4')
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16]]) blocked.addSubnet(net!, bits!, 'ipv6')
```

- `isForbiddenPublicHost(hostname)`：规范化主机名；主机名规则；含 `:` → `blocked.check(host, 'ipv6')`（解析失败返回 `false`）；四个数字段 → `blocked.check(host, 'ipv4')`；其余名称返回 `false`；
- `BlockList` 的构造不抛（地址块是常量），模块加载时执行一次。

### A5 kit `src/upload-transport.ts`

- 以小红书 `src/client/api.ts` 的三个函数为底迁入，路由路径与请求头常量由参数传入；
- 小红书 `api.ts` 改为 `const transport = createUploadTransport({ pick: UPLOAD_PICK_PATH, … })` 并再导出同名函数，调用方不改；
- media-upload client 半（P0）改为消费 kit，删除其副本。

## 附录 B：测试矩阵

| ID | 断言 |
|---|---|
| D1 | 注入时钟：`done` 后 9 分钟查询返回 `done`；11 分钟后返回 `not_found` |
| D2 | 注入时钟：`failed` 的保留时长与 `done` 相同 |
| E1 | `mapServerErrorCode({ error: { code: 'UNAUTHORIZED' } })` → `uploader_not_configured` |
| E2 | `STORAGE_AUTH_FAILED` → `storage_auth_failed`；嵌套与顶层两种形态都成立 |
| T1 | 目录名含当前进程号；同一暂存区两次创建得到同一目录 |
| T2 | 清理：不存在的 pid 目录被删除；存活 pid 目录保留 |
| T3 | 清理：旧命名目录 24 小时外的被删除、24 小时内的保留（注入时钟） |
| T4 | 清理：只处理 `yootun-media-` 前缀的目录，临时目录下其他条目不动 |
| T5 | 清理过程中某一项删除失败：记一条告警，继续处理其余项，返回的计数正确 |
| F1 | 主机名：`localhost`、`localhost.`、`foo.localhost`、空串 → 拒绝；`media.example.com` → 放行 |
| F2 | IPv4：2.2 表中每个地址块各取一个地址（经 `new URL` 解析）→ 拒绝；`8.8.8.8`、`1.1.1.1`、`100.63.255.255`、`172.32.0.1` → 放行 |
| F3 | mapped：`[::ffff:10.0.0.1]`、`[::ffff:a00:1]`、`[::ffff:7f00:1]`、`[::ffff:a9fe:a9fe]` → 拒绝 |
| F4 | IPv6：`fe90::1`、`[fe80::1]`、`fc00::1`、`[64:ff9b::a00:1]`、`[2002:a00:1::]` → 拒绝；`2606:4700::1111` → 放行 |
| F5 | 整体：`validateAuthorizationResponse` 在授权地址或 `publicUrl` 命中 F1–F4 任一形态时抛 `upload_authorization_invalid`；`loopback-test` 覆盖下仍只放行授权地址，不放行 `publicUrl` |
| K1 | kit：`startSession` / `sendBytes` / `pollStatus` 的请求方法、头与返回值形态与小红书原实现一致；非 2xx 与非 JSON 返回 `null` |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| `done` 保留时长 | 10 分钟（与等待选文件一致） | 页面确认后才清除（要新增确认路由） |
| 暂存目录清理的判据 | 目录名带 pid，按进程是否存活 | 只按修改时间（会误删空闲实例的目录） |
| 内网过滤实现 | `node:net` `BlockList` | 引入 `ipaddr.js`；或继续手写前缀判断 |
| mapped 地址 | 整段拒绝 `::ffff:0:0/96` | 换算成 IPv4 后按 IPv4 规则判断 |
| 上传传输函数的位置 | `@yootun/dsh-client-ui-kit`（P0 已把 `createHostAction` 放在这里） | media-upload 导出 client 子路径供小红书引用（插件互相依赖） |

- 生产接线守卫（2026-11-27，P1 阶段 1–4 验收审查）：media-upload 启动暂存清理登记原先无用例守——接线抽为导出工厂 `applyStartupStagingCleanup`（登记即清扫；卸载按序等待 registry → staging → sweep，含「sweep 未 settle 前 dispose 不返回」断言，去 await→红→恢复→绿）。
