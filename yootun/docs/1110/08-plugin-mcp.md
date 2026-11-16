# 分册 08：yootun 插件与 MCP 接入实施方案（2026-11-16）

## 0. 定位与依赖

本册是第三步「三个内置工作台迁移」的开发依据，覆盖普通会话 MCP、三个工作台 Host 的私有 MCP 通道、媒体上传能力和桌面插件接入边界。UI 实施以 [../plugin-ui-ux-standard.md](../plugin-ui-ux-standard.md) 为准；本册只定义产品能力、Host 架构、凭证、权限、迁移批次和验收。

Tools 服务端的详细契约、工具清单、代码健壮性约束和测试矩阵见 `tools.dofe.ai` dev 分支的 `docs/1116/yootun-mcp.md`。该文档是服务端单一事实源；本文不复制完整 90 项 Workbench 映射，只维护桌面消费边界。

新公共入口固定为：

```text
Agent 面：
https://ixicai.cn/mcp/tools/yootun/v1/agent

Workbench 面：
https://ixicai.cn/mcp/tools/yootun/v1/workbench

Catalog 面：
https://ixicai.cn/mcp/tools/yootun/v1/catalog
```

`tools/list` 是 MCP 协议的标准方法名，不能改为 `yootun_tools/list`。yootun 专属业务发现工具在 Catalog 面统一命名为 `yootun_business_*`，与旧 platform 的 `business_*` 发现契约平行但完全隔离。

命名契约统一为：

| 层 | 桌面侧约定 |
|---|---|
| 协议方法 | 只使用 MCP 标准 `initialize` / `tools/list` / `tools/call`，不改名、不加品牌前缀 |
| 公共 URL | 统一 `https://ixicai.cn/mcp/tools/yootun/v1/<face>`，`face` 只能为 `agent` / `workbench` / `catalog` |
| `serverName` | 与服务端 domain 同名：`yootun-agent` / `yootun-workbench` / `yootun-catalog`，无版本号 |
| Agent 工具 | 只接受 `yootun_*` 前缀 |
| Workbench 工具 | 只接受 `workbench_*` 前缀，白名单按工具名精确匹配 |
| 能力发现工具 | 只接受 `yootun_business_*` 前缀，且仅存在于 Catalog 面 |
| 客户端常量与测试名 | 与服务端 domain / face / 工具名一一对应，不得自造第二套别名 |

既有 `xhs-operation`、`douyin-operation`、`wx-channels-operation`、`viral-video`、`tos-upload` 五个 public route 全部保留，行为不变。新桌面不直接引用这些旧 route。

## 1. 目标产品面

第一批只迁移三个用户可见工作台：

| 工作台 | 远端数据依赖 | 设备端能力 |
|---|---|---|
| 小红书工作台 | Agent/Workbench 面的小红书能力 + Workbench 上传授权 | 系统 Chrome 扫码、本地账号、素材上传、笔记采集、草稿发布 |
| 抖音工作台 | Workbench 面的抖音数据能力 + 22 个爆款拆解/素材/知识能力 | 系统 Chrome 扫码、创作者中心采集、本地账号状态 |
| 视频号工作台 | Workbench 面的视频号能力 | 系统 Chrome 扫码、视频号助手采集、本地账号状态 |

不迁移其他业务插件，不接入其他 MCP route。`viral-video` 与 `tos-upload` 不是额外用户可见插件：前者作为抖音工作台的数据依赖被收进 Workbench 面，后者作为小红书素材上传的支撑能力由 Host 上传插件消费。

## 2. 桌面总体架构

```text
yootun desktop profile
├─ 普通会话
│   └─ @yootun/dsh-managed-mcp
│       └─ Agent 面 MCP client（注册进 ctx.tools）
│
├─ 小红书工作台 Host
│   ├─ 本地 Chrome / storage_state / 采集 / 发布
│   ├─ @yootun/dsh-media-upload
│   └─ @yootun/dsh-workbench-mcp（私有，不注册 ctx.tools）
│
├─ 抖音工作台 Host
│   ├─ 本地 Chrome / storage_state / 采集
│   ├─ @yootun/dsh-workbench-mcp
│   └─ 抖音数据 + 爆款拆解/素材/知识工具
│
├─ 视频号工作台 Host
│   ├─ 本地 Chrome / storage_state / 采集
│   └─ @yootun/dsh-workbench-mcp
│
├─ yootun-catalog（默认不挂进普通会话）
│   └─ yootun_business_* 能力发现 / 契约查询，供管理台与诊断面后续使用
│
└─ yootun-access
    ├─ setupComplete / validationVersion 门禁
    └─ MODELS_API_KEY credential store
```

核心原则：

1. 普通会话只看到 Agent 面的产品级工具；
2. 工作台页面通过本地同源 Host API 调 Workbench 面；
3. Workbench MCP client 不注册进 `ctx.tools`，普通会话不可见；
4. 浏览器页面不读取 `MODELS_API_KEY`，不直连 `ixicai.cn`;
5. Cookie、storage_state、本地文件路径只留在设备端；
6. 旧五个 MCP route 保持独立可访问，新桌面不依赖它们；
7. Catalog 面默认不挂进普通会话，也不加入 Workbench Host 白名单；
8. 旧 `/mcp/tools/platform` 能力发现面保持 dev 基线，不出现任何 yootun 工具或 schema 扩展。

## 3. 插件目录与包命名

新增 workspace 目录：

```text
yootun/plugins/
├─ dsh-managed-mcp/
├─ dsh-workbench-mcp/
├─ dsh-media-upload/
├─ dsh-xhs-workbench/
├─ dsh-douyin-workbench/
└─ dsh-wx-channels-workbench/
```

包名：

```text
@yootun/dsh-managed-mcp
@yootun/dsh-workbench-mcp
@yootun/dsh-media-upload
@yootun/dsh-xhs-workbench
@yootun/dsh-douyin-workbench
@yootun/dsh-wx-channels-workbench
```

`pnpm-workspace.yaml` 需要在现有 `yootun/packages/*` 之外登记 `yootun/plugins/*`。这是官方目录内联改动，必须先扩展 `yootun/docs/inline-changes.md` #1 的文件面，再动代码。

打包闭包继续使用 `--filter=@yootun/*`，并需专项验证能把新增插件与运行时依赖带入桌面安装包。

## 4. Agent 面：`@yootun/dsh-managed-mcp`

### 4.1 职责

`@yootun/dsh-managed-mcp` 是普通会话唯一的 yootun 远端 MCP 管理插件，动态挂载 Agent 面：

```text
serverName = yootun-agent
url = https://ixicai.cn/mcp/tools/yootun/v1/agent
```

它使用官方 `@deepseek-ai/dsh-mcp-client`，并把工具注册进当前 Host 的 `ctx.tools`。

### 4.2 激活与凭证生命周期

创建 MCP client 必须同时满足：

```text
yootun-access.setupComplete === true
yootun-access.validationVersion === brand.validationVersion
credentials.resolve(MODELS_API_KEY) 返回非空值
```

生命周期：

| 场景 | 要求 |
|---|---|
| 未激活 / 契约版本不匹配 / 无 key | 不创建 client，不发起网络请求，`ctx.tools` 中没有 yootun Agent 工具 |
| 激活完成 | 创建一个 Agent 面 client |
| key 更新 | dispose 旧 client 后重建 |
| key 移除 | dispose client，工作台与普通会话均不可用 |
| 网络初始连接失败 | 不阻塞桌面启动，保留重连策略，不伪造工具可用 |
| 插件卸载 | dispose client 并释放所有 effect |

transport headers：

```text
Authorization: ${credential:MODELS_API_KEY}
X-Company-Code: yootun
```

使用 `expandTemplates: true`，确保诊断脱敏。插件内部仍需解析一次 credential ref 用于门禁判断，但不得把解析值写入状态、日志或响应。

### 4.3 会话写操作保护

Agent 面服务端已按产品任务收敛，桌面侧仍需注册 `tools/pre-execute` guard：

- 读工具允许；
- 明确任务型写工具在会话中 ask;
- 高风险批量采集、模型生成、报表重建类工具 ask 或 deny;
- Workbench Host 的私有调用不走 Agent 面，因此不受该 guard 影响。

guard 只按公开工具名和执行上下文判断，不读取参数中的身份字段，不修改业务 schema。

## 5. Workbench 面：`@yootun/dsh-workbench-mcp`

### 5.1 职责

`@yootun/dsh-workbench-mcp` 是三个工作台 Host 共享的私有 MCP client。它直接使用 MCP SDK Streamable HTTP client 调：

```text
https://ixicai.cn/mcp/tools/yootun/v1/workbench
```

不得使用 `@deepseek-ai/dsh-mcp-client` 承载 Workbench 面，因为该包会把工具注册进 `ctx.tools`，破坏“普通会话不可见”的边界。

### 5.2 服务接口

插件向三个工作台 Host 提供受限服务，例如：

```ts
callTool(domain: 'xhs' | 'douyin' | 'wx' | 'viral' | 'tos', name: string, args: unknown, signal?: AbortSignal): Promise<unknown>
```

内部必须执行：

1. 工作台 ID 与工具白名单校验；
2. 激活门禁校验；
3. credential 解析；
4. MCP initialize 与 tools/list 缓存；
5. tools/call;
6. 超时、取消与重连；
7. 错误 envelope 安全投影；
8. 新 domain/tool 审计辅助信息。

白名单以 Tools 文档的 90 项 Workbench 契约为准。任何白名单外工具必须直接拒绝，不得尝试调用。

### 5.3 请求约束

- 所有请求由 Host 发起；
- 浏览器只调用本地 `ctx.webServer` 同源 endpoint;
- 请求体大小沿用现有工作台 Host 上限；
- Host endpoint 校验 method、origin、`sec-fetch-site` 和 action;
- 每个工作台只能访问自己的工具分组；
- `viral` 分组只允许抖音工作台 Host 使用；
- `tos_upload_authorize` 只允许媒体上传插件使用。

### 5.4 连接策略

- 每次关键操作显式超时，默认 60 秒；
- `initialize` / `tools/list` 可缓存，但凭证轮换后必须失效；
- 网络失败不自动重试写操作；
- 幂等冲突和结果未知必须原样投影为稳定错误，不允许换新键自动重发；
- 取消信号必须中断请求并释放传输；
- 插件卸载必须关闭全部 client 与 in-flight 请求。

## 6. `@yootun/dsh-media-upload`

旧 `dsh-yootun-tos-upload` 迁移为 `@yootun/dsh-media-upload`，仍是纯 Host 插件。

保留本地同源路由：

```text
/_dsh/uploader/pick-file
/_dsh/uploader/uploadStart
/_dsh/uploader/uploadStatus
/_dsh/uploader/media
```

保留会话工具：

```text
media_upload
```

授权调用改为 Workbench 面：

```text
workbench_tos_upload_authorize
```

安全不变：

- 用户通过原生文件选择器亲自选文件；
- 工具不接受调用方传入本地路径；
- 只上传 filename、contentType、size;
- 不持有 TOS AK/SK、bucket、region、endpoint;
- 预签名 URL 不进入响应、日志或会话；
- 本地路径与 object key 不回传；
- 上传前后执行 MIME、大小、普通文件、TOCTOU 和授权响应校验；
- 返回给上层的是公网 URL 和非敏感元信息。

## 7. 三个工作台迁移

### 7.1 共同结构

每个工作台分成 Host 半和 client 半：

```text
Host
├─ ctx.webServer.register('/api/desktop/yootun/<workbench>')
├─ 本地 Chrome 扫码与采集状态机
├─ 本地 storage_state 管理
├─ @yootun/dsh-workbench-mcp 调用
└─ 审计与稳定错误投影

Client
├─ root main 面板 + sidebar.panellist 入口
├─ PluginPageShell / FilterBar / DataCard / ChartFrame / DataState
├─ 工作台专属任务视图
└─ AssistantDock
```

三个工作台内置自动启用，不恢复激活页插件勾选。`yootun-access.enabledPlugins` 保留字段但不参与加载，避免激活契约版本升级和已激活用户重新输入 key。

### 7.2 视频号工作台

迁移能力：

- 扫码登录与会话状态；
- 账号列表与账号删除；
- 单账号 / 全账号采集；
- 作品列表、详情、趋势；
- 账号总览；
- 粉丝画像；
- 采集 run 查询、取消、心跳与批次上报；
- 本地状态清理与远端删除顺序。

首验收选择视频号，因为链路无模型费用、无异步 Models 任务、工具数最少，适合验证新私有 MCP 通道和 Host 状态机。

### 7.3 小红书工作台

迁移能力：

- 本地素材选择与上传；
- 小红书账号扫码与管理；
- 笔记采集；
- 仿写任务创建、查询、取消、结果读取；
- 爆款看板 overview、详情、关键词、设置、运行和审核；
- 标签管理；
- 草稿发布；
- 工作台助手与操作回执。

上传流程：

```text
选择本地文件
→ @yootun/dsh-media-upload 校验并直传 TOS
→ 得到公网 URL
→ Workbench xhs task create
→ 任务轮询 / 结果展示 / 重新生成
```

### 7.4 抖音工作台

迁移能力：

- 扫码登录与账号管理；
- 创作者中心采集；
- 作品、总览、趋势、热门作品；
- 单账号分析；
- AI 分析与报表；
- 负责人与投流登记；
- 爆款拆解归档与下载；
- 仿写工作流与故事板；
- 爆款素材看板、seed 池与 run 历史；
- 爆款基因知识库查询、更新和重建；
- 导出与报表渲染。

抖音 Host 允许同时使用 `douyin` 与 `viral` 两组 Workbench 白名单，但不得把 `viral` 工具暴露给其他工作台。

## 8. 本地登录态与状态目录

继续沿用旧目录，避免升级后要求用户重新扫码：

```text
~/.dofe/dsh-yootun-xhs-operation
~/.dofe/dsh-yootun-douyin-operation
~/.dofe/dsh-yootun-wx-channels-operation
```

环境覆盖：

```text
XHS_OPERATION_STATE_DIR
DOUYIN_OPERATION_STATE_DIR
WX_CHANNELS_OPERATION_STATE_DIR
```

不变式：

- 每账号独立 Chrome profile;
- storage_state 备份权限 0600;
- Cookie 与 storage_state 不进入浏览器响应、日志、Tools 参数或审计；
- 删除账号时先确认本地凭证和 profile 已清理，再执行远端删除；
- 采集 profile 锁避免同一账号并发扫码或采集。

## 9. UI 与信息架构

三个工作台都是 root `main` 中央面板，通过 `sidebar.panellist` 注册一个入口，不做 sidebar footer 弹层。

页面结构遵循插件 UI/UX 标准的：

```text
PluginPageShell
├─ PluginHeader
├─ FilterBar
├─ KpiRow
├─ ChartFrame / DataCard
├─ RankingAndDetailGrid
└─ AssistantDock
```

图表重点：

- 视频号：账号总览、作品趋势、粉丝画像；
- 小红书：爆款看板、关键词效果、任务成功率、生成版本对比；
- 抖音：账号总览、作品趋势、热门作品、AI 分析结论、爆款素材看板与知识库命中。

所有操作必须有 loading、empty、error、partial、disabled、focus、hover、pressed、selected 状态。写操作要有操作回执、失败保留原数据、最近一次有效修改可撤销或可明确重试。

## 10. 安全与错误边界

### 10.1 凭证

- `MODELS_API_KEY` 只存 credentials store;
- 浏览器不可见；
- Host 私有 client 只在调用期间解析；
- Authorization 诊断必须脱敏；
- key 移除后 dispose 所有远端连接。

### 10.2 设备端凭证

- Chrome Cookie 留在浏览器 profile;
- storage_state 只存本地备份；
- 不上传 Tools;
- 不写入 MCP 参数；
- 不进入审计；
- 本地预览 URL 只服务同源页面且校验路径。

### 10.3 同源 Host API

每个 endpoint 必须：

- 只接受 POST;
- 校验 expected origin;
- 校验 `sec-fetch-site: same-origin`;
- 限制请求体大小；
- 显式 action allowlist;
- 拒绝未知字段;
- 不透传内部异常;
- 返回稳定错误码。

### 10.4 错误模型

工作台 client 只显示稳定错误码和本地化说明。以下内容不得进入 UI 或日志：

```text
MODELS_API_KEY
Authorization
Cookie
storage_state
TOS AK/SK
预签名 URL
object key
内网地址
数据库 SQL
上游原文
本地文件路径
```

## 11. 开发批次

### 批次 P0：服务端契约就绪（已完成）

交付状态：

```text
tools.dofe.ai dev
└─ docs/1116/yootun-mcp.md 已评审、实现并部署
```

后续按该文档实现 Legacy / Yootun 双 registry、Agent 36 项、Workbench 90 项、Catalog 5 个 `yootun_business_*` 元工具和测试。桌面侧不先伪造 endpoint。

### 批次 P1：桌面基础设施

交付：

1. `yootun/plugins/*` workspace 登记；
2. `@yootun/dsh-managed-mcp`;
3. `@yootun/dsh-workbench-mcp`;
4. `@yootun/dsh-media-upload`;
5. Catalog 面连接策略与工具名契约测试（默认不挂载）；
6. 连接器单测与假 MCP server 测试；
7. 打包闭包测试。

### 批期 P2：视频号工作台

交付视频号完整工作台，并完成私有 Workbench MCP 端到端验证。

### 批次 P3：小红书工作台

交付小红书任务、上传、采集、爆款看板和发布链路。

### 批次 P4：抖音工作台

交付抖音数据、AI 分析、报表、爆款拆解、素材看板和知识库。

### 批次 P5：集成验收与出包

交付完整安装包、真机验证、打包闭包和升级验证。

每批完成后本地 commit，不 push；涉及编码的批次必须经独立 review 子代理验证。

## 12. 测试计划

### 12.1 managed MCP

- 未激活时无网络请求、无 MCP client、无 Agent 工具；
- 激活后仅出现 `yootun-agent`，不出现 `yootun-workbench` 或 `yootun-catalog`;
- key 更新 / 移除生命周期正确；
- Authorization 脱敏；
- 会话 guard 覆盖读、写、高风险和取消；
- 官方 `dsh-mcp-client` 卸载后 `ctx.tools` 无残留。

### 12.2 Workbench MCP

- initialize / tools/list / tools/call;
- 90 项白名单精确匹配；
- 白名单外工具拒绝；
- 三个工作台互不可访问对方分组；
- Workbench client 不能调用 `yootun_business_*` Catalog 工具；
- 超时、取消、网络错误、协议错误、业务错误分开投影；
- credential 更新后缓存失效；
- 插件卸载无 client / timer / request 泄漏。

### 12.3 media upload

- 文件选择、取消、替换、截断、超限、非法 MIME;
- 授权响应 HTTPS、公网 host、过期时间、maxBytes、Content-Type 校验；
- 上传成功只返回公网 URL;
- 失败不泄露授权 URL 或本地路径；
- `media_upload` 会话工具不接受路径。

### 12.4 工作台 Host

- 同源与 CSRF 校验；
- action allowlist;
- 请求体上限；
- 扫码、心跳、采集、批次、完成、取消状态机；
- 本地凭证删除顺序；
- 崩溃或重启后 run 恢复；
- MCP 错误稳定投影；
- 长任务取消无脏状态。

### 12.5 Catalog 面

- `/mcp/yootun-catalog` 的 `tools/list` 精确返回 5 个工具；
- 工具名精确为 `yootun_business_*`；
- Catalog 只描述 Agent 36 项与 Workbench 90 项，合计 126 项；
- Catalog 结果不包含 legacy domain 或 legacy 工具；
- 旧 `/mcp/tools/platform` 的 tools/list schema 与 discovery 输出保持 dev 基线；
- 旧 platform 无过滤 search total 保持 267，category 保持 8 / 267；
- Catalog 面默认不被 `@yootun/dsh-managed-mcp` 挂载，也不进入 Workbench 白名单。

### 12.6 UI

- 明暗主题；
- 640 / 880 / 1120 px;
- 键盘路径；
- reduced-motion;
- loading / empty / error / partial;
- 图表联动与导出；
- 长文案、长数字、极端时间范围；
- 工作台助手模型失败、请求中、停止和草稿保留。

### 12.7 打包与真机

- `pnpm --filter '@yootun/*' run build`;
- `pnpm run build`;
- 安装包包含全部插件与依赖；
- 未激活时三个工作台不可用；
- 激活后三个工作台可用；
- 重启保留登录态；
- 升级后页面可点击、无 inert 残留；
- 旧安装目录与用户数据不冲突。

## 13. 验收清单

- [ ] 普通会话仅挂 Agent 面，不挂 Workbench 面或 Catalog 面；
- [ ] Agent 工具数与 Tools 契约一致；
- [ ] Workbench 私有 client 不注册 `ctx.tools`;
- [ ] Catalog 面仅包含 5 个 `yootun_business_*` 工具，并只描述 126 个 yootun 业务工具；
- [ ] 旧 platform 能力发现 schema 与输出保持 dev 基线；
- [ ] 三个工作台只使用自己的白名单；
- [ ] 抖音 Host 独占 viral 分组；
- [ ] 小红书上传只经 media-upload 与 Workbench 授权；
- [ ] 未激活无远端 MCP 连接；
- [ ] key 更新 / 移除生命周期正确；
- [ ] Cookie 和 storage_state 不出设备；
- [ ] Host API 同源与 action 校验完整；
- [ ] 稳定错误码与敏感信息脱敏完整；
- [ ] UI 符合插件 UI/UX 标准；
- [ ] 旧五个 public route 不被新桌面引用且保持可访问；
- [ ] 打包闭包与真机升级验证通过。
