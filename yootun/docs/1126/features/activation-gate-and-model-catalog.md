# access-激活门禁三态与模型目录对齐 实施单

状态：开发完成（2026-11-26，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

- `AccessGate` 的 `configured` 初值是 `false`（`yootun/packages/dsh-client-ui-access/src/client/gate.tsx`），`describeKeyConfigured` 回包前按未授权渲染整屏卡片（带淡入动画）。已激活用户每次启动都会看到门禁卡片闪一下。
- 激活路由把传输层失败（断网、网关不可达）一律收敛为 `invalid_key`（`src/route.ts` `handleDofeValidateRequest` 的 catch），页面显示「Key 验证失败，请检查后重试」。
- 激活页从 `/api/v1/models?protocol=anthropic` 拉实时目录供选择，但承载插件是 `llm-pi-ai` 的 `openai-responses` 协议，provider 的模型列表是 `cordis.patch.yml` 里静态的 23 个；激活流程不写目录。用户可能选中一个 provider 未声明的模型；网关后续新增的模型要等发版才出现。
- `src/route.ts` 头注释与 `src/access-constants.ts` 注释仍写「llm-deepseek / Anthropic 是唯一承载」。

### 0.2 目标

已激活用户启动无闪现；失败原因按「网络不可用 / 密钥无效 / 租户不匹配 / 租户服务不可用」区分；激活成功时 provider 的模型目录并入网关实时目录（只增不删），与选择器一致；注释与现行实现一致。

## 1. 范围

做：

- 门禁授权判定改三态：未知（只渲染遮罩层，不渲染卡片）/ 未授权（卡片）/ 已授权（无）；未知持续超过 5 秒回落为卡片；
- 激活路由新增原因 `network_unavailable`，表单映射为独立文案；
- 激活成功时把实时目录并入 `llm-pi-ai` 设置分区的 `providers.yootun.models`（只增不删；写入失败不阻断激活）；
- 目录请求协议与实际承载协议对齐（实现前用真实 key 核对，结果记入 5.3）；
- 修正两处过期注释（`access-constants.ts` 由 `scripts/generate-access-constants.mjs` 生成，改脚本模板）。

不做：

- 不改官方 `llm-pi-ai`、设置服务与模型设置页；
- 不做激活流程的凭证 provider 重组；
- 不改 `VALIDATION_VERSION`；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 同源路由 `/api/desktop/dofe/validate` 与 `/models`

| `reason` | 现状 | 变更 |
|---|---|---|
| `invalid_key` | 传输失败与非 2xx 都用它 | 只用于网关明确拒绝（401 / 403）或目录为空 |
| `tenant_mismatch` | 不变 | 不变 |
| `tenant_unavailable` | 租户服务返回非 2xx 或响应不可解析 | 不变 |
| `network_unavailable` | 无 | 新增：fetch 失败、超时、5xx |

### 2.2 门禁三态

| `configured` | 渲染 |
|---|---|
| `undefined`（首帧到 `describeKeyConfigured` 回包） | 只有遮罩层（无卡片、无动画），`aria-hidden`，不拦截焦点以外的键盘事件 |
| `undefined` 持续超过 5 秒 | 回落为卡片。凭证探测挂起时不能让用户面对一张没有任何入口的遮罩 |
| `false` | 卡片（现状） |
| `true` | 无 |

`settings` 快照未就绪同样按未知处理。

### 2.3 模型目录写入

| 项 | 内容 |
|---|---|
| 时机 | `saveActivation` 中，凭证写入之后、默认模型写入之前 |
| 目标 | `ctx.configForms.get('llm-pi-ai')` 的 `providers.yootun.models` 路径，值为 `[{ id }, ...]`：分区现有模型列表与实时目录按 id 去重后的并集，现有项在前；实时目录已过滤非对话模型。只增不删：网关目录缺少某个内置模型时，用户正在使用的默认模型不会被移出列表 |
| 失败 | `mutate` 返回 false、rejection 或分区不在服 → 跳过，不阻断激活（provider 仍有 patch 的静态目录兜底），表单显示一行「模型目录未能同步，当前使用内置目录」。例外：分区列表可读且所选模型确不在内时，`saveActivation` 在写默认模型与授权之前中止（`ok: false`），表单提示「该模型当前不可用」；列表不可读时不以此阻止 |
| 选择器 | 选项来自并集（现有列表 ∪ 实时目录）；提交时若所选模型不在现有列表且目录写入失败 → 提示并阻止提交（避免选中 provider 未声明的模型） |

### 2.4 词典新增（`src/client/locales.ts`，zh / en 成对）

| 键 | zh | en |
|---|---|---|
| `networkUnavailable` | 暂时无法连接模型服务，请检查网络后重试 | Could not reach the model service; check the network and retry |
| `catalogSyncFailed` | 模型目录未能同步，当前使用内置目录 | The model list could not be synced; using the built-in list |
| `modelNotAvailable` | 该模型当前不可用，请选择其他模型 | That model is not available now; choose another |

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无（目录接口不改） | 否 | 契约不变 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/packages/dsh-client-ui-access/src/route.ts` | `network_unavailable`；目录协议参数；头注释 | 是 | 失败原因分类 |
| yootun-agent | `yootun/packages/dsh-client-ui-access/src/client/logic.ts` | `AccessForms.models`；`saveActivation` 写目录；三态判定 | 是 | 写入序列 |
| yootun-agent | `yootun/packages/dsh-client-ui-access/src/client/gate.tsx` | 三态渲染 | 是 | 去闪现 |
| yootun-agent | `yootun/packages/dsh-client-ui-access/src/client/{form.tsx,index.ts,locales.ts}` | 原因映射、目录写入结果提示、`configForms.get('llm-pi-ai')` | 是 | 表单与注入 |
| yootun-agent | `yootun/packages/dsh-client-ui-access/scripts/generate-access-constants.mjs`、`src/access-constants.ts` | 注释修正 | 是 | 生成文件单一来源 |
| yootun-agent | `yootun/packages/dsh-client-ui-access/tests/access.test.ts` | 新用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/03-enterprise.md` §3 / §4 | 目录写入与三态门禁条款 | 是 | 分册是企业层契约记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 03 册 §3/§4 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-26 | `feat/activation-gate-and-model-catalog`（基于 `feat/agent-face-self-heal`） | `@yootun/dsh-client-ui-access` `test`（node --test 21 用例）、`build`（generate 后生成产物零预期外 diff），`pnpm --filter '@yootun/*' run build`，仓库根 `pnpm run lint`、`typecheck`、三个 verify 脚本与 `test:docs` 通过，验收独立复跑结果一致；目录协议参数未核对（见 5.3）；真机验收见 5.2 |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-client-ui-access test`、`build` 通过（build 含 `generate`）；
- [ ] `pnpm run lint`、`pnpm run verify-client-ui-i18n`、`pnpm run verify-export-jsdoc`；
- [ ] 附录 B 用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| V1 | 已激活状态下冷启动应用多次 | 不出现激活卡片；主界面直接可用 |
| V2 | 未激活状态冷启动 | 遮罩后出现激活卡片，焦点在 Key 输入框 |
| V3 | 断网后输入任意 Key 点「获取可用模型」 | 提示「暂时无法连接模型服务」，不是「Key 验证失败」 |
| V4 | 输入一个格式合法但无效的 Key | 提示「Key 验证失败」 |
| V5 | 有效 Key 激活：目录中出现内置列表之外的模型时选择它并进入 | 激活成功；新会话用该模型可对话；设置 → 模型里 yootun provider 的模型列表包含它 |
| V6 | 重新激活（更换 Key） | 目录刷新；默认模型选择保留或回落到首个 |
| V7 | 明暗主题 | 遮罩层与卡片无异常 |

### 5.3 本地联调记录

- 官方设置表单 API 核对（只读源码 `packages/client/ui-settings/src/client/config-form.ts`、`config-form-types.ts`、`packages/settings/settings/src/types.ts`）：`ctx.configForms.get<T>(entryId): ConfigForm<T>` 为同步注册表查找，按 entryId 惰性建 controller，不校验分区在服状态（分区缺位表现为快照 `unavailable`）；`ConfigForm.mutate(ops: readonly SettingsPathOpView[], expectedRevision?): Promise<boolean>`，`SettingsPathOpView = { op: 'set'; path: string[]; value: JsonValue } | { op: 'unset'; path: string[] }`；Host 拒绝写 → `mutate` 返回 false，分区缺位或传输失败 → promise rejection（目录写入以 try/catch 收敛为跳过）。
- `llm-pi-ai` 设置分区路径核对：cordis.patch.yml entry `llm-pi-ai` 写 `config.providers.yootun`（`apiKeyEnv: MODELS_API_KEY`、`api: openai-responses`、`models` 为 23 项裸 `{ id }`）；llm-pi-ai Config schema（`packages/llm/llm-pi-ai/src/config.ts`）的 `models?: PiAiModelProfile[]` 语义为「显式列表整体替换安装目录、缺省字段按同 id 目录项回填」，写回裸 `{ id }` 并集与 patch 形态一致，网关新增模型走路由缺省（context window 1,000,000 / max tokens 128,000 / input [text]）。
- `?protocol=` 取值核对：未核对——本机无可用真实 key，未对网关发起请求，`MODEL_CATALOG_URL` 保持原值 `protocol=anthropic` 不动，留待真机验收 V5 / V6 验证。

## 附录 A：逐文件规格

### A1 `src/route.ts`

- `AccessFailureReason` 增 `'network_unavailable'`；
- `verifyTenant` 的传输 catch（fetch 抛错、超时）→ `{ ok: false, reason: 'network_unavailable' }`；`response.ok` 为 false 时：401 / 403 → `invalid_key`，其余 → `network_unavailable`；2xx 但响应体不可解析仍是 `tenant_unavailable`；
- `loadModels` 返回 `{ models, reason? }`：非 2xx → 401 / 403 `invalid_key`，其余 `network_unavailable`；2xx 但响应体不可解析 → `network_unavailable`；`handleDofeValidateRequest` / `handleDofeModelsRequest` 的 catch → `network_unavailable`；客户端 `validateAndLoadModels` 把目录路由的 `reason` 透传给表单（原固定 `invalid_key`）；
- `MODEL_CATALOG_URL` 的 `protocol` 参数按 5.3 核对结果设定（候选：`openai-responses`、无参数）；头注释改为现行承载（`llm-pi-ai` + `openai-responses`）。

### A2 `src/client/logic.ts`

- `AccessForms` 增 `models: ConfigForm<{ providers: Record<string, { models: Array<{ id: string }> }> }> | undefined`（分区不在服时为 undefined）；
- `saveActivation(forms, credentials, key, modelId, catalog)`：顺序改为 凭证 → 目录（先读分区现有的 `providers.yootun.models`，与 `catalog` 按 id 去重取并集，`forms.models?.mutate([{ op: 'set', path: ['providers', 'yootun', 'models'], value: merged }])`，返回 boolean）→ 默认模型 → 授权；返回值改为 `{ ok: boolean; catalogSynced: boolean; catalog: merged }`；
- `isAuthorized(settings, credentialConfigured: boolean | undefined)`：`undefined` → 返回 `undefined`（未知），供门禁区分。

### A3 `src/client/gate.tsx`

- `useState<boolean | undefined>(undefined)`；`authorized = isAuthorized(settings, configured)`；另有一个 5 秒定时器（`GATE_UNKNOWN_FALLBACK_MS`）：`configured` 仍为 `undefined` 时把渲染态置为「按未授权处理」，回包或卸载时清除；
- `authorized === undefined` → 渲染 `<div className={css.gateGate} aria-hidden="true" />`（只有遮罩背景，无卡片、无动画、不抢焦点、不装焦点陷阱）；
- 其余两态沿用现有渲染；授权后的 `inert` 清理与滚动锁逻辑不变。

### A4 `src/client/form.tsx` / `index.ts`

- `index.ts` 的 `forms` 增 `models: ctx.configForms.get('llm-pi-ai')`（try/catch 包裹，分区不存在时置 undefined，不改用 `as`）；
- `loadModels` / `save` 的原因映射增 `network_unavailable → t('networkUnavailable')`；
- `save` 调 `saveActivation(..., verdict.models)`：`ok === false` 且目录未同步、列表可读、所选模型不在内 → `t('modelNotAvailable')`（中止发生在默认模型与授权写入之前）；`ok === true` 且 `catalogSynced === false` → 显示 `t('catalogSyncFailed')` 后继续。

### A5 `scripts/generate-access-constants.mjs`

- 生成文件头与 `ACCESS_CREDENTIAL_REF` 注释改为「`llm-pi-ai` provider `yootun` 的 apiKeyEnv 与 credential store 共用此名」。

## 附录 B：测试矩阵

| ID | 断言 |
|---|---|
| R1 | 路由：fetch 抛错 / 超时 / 5xx → `network_unavailable`；401 / 403 → `invalid_key`；租户不符 → `tenant_mismatch` |
| R2 | 门禁：`configured === undefined` 时不渲染 `.card`；`false` 渲染；`true` 不渲染任何层；未知态超过 5 秒（注入时钟）→ 渲染卡片，随后回包为已授权 → 卡片消失。本包测试是无 DOM 的 node --test，三态渲染决策提取为纯函数 `gatePhase` 断言，`gate.tsx` 只做 JSX 映射 |
| R3 | `saveActivation` 写入顺序：凭证 → 目录 → 默认模型 → 授权；目录 mutate 失败时仍完成后续写入且 `catalogSynced === false`；写入值为并集，分区现有模型一个不少、目录新模型追加在后 |
| R4 | 表单：`network_unavailable` → 对应文案；目录未同步且所选模型不在内置目录 → 阻止提交 |
| R5 | 生成常量脚本的输出与 `src/access-constants.ts` 一致（`build` 的 `generate` 步骤零 diff） |
