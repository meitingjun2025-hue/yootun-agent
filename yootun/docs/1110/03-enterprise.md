# 分册 03：企业接入层（key 激活 / 凭证 / 门禁 / managed MCP）

批次 4（`feat/migration-step1-enterprise`）实施依据。前置：批次 3 品牌包与 yootun bundle 就位。

## 1. 目标

新桌面具备与旧桌面一致的接入行为：未激活全屏门禁 → 输入 key → 校验/拉取模型 → 激活成功 → 模型经自有网关可用；managed MCP 的凭证绑定与 patch 机制就绪（路由清单为空，待插件勾选清单后补）。

## 2. 旧实现链路（调查事实，迁移蓝本）

```
yootun-ui 表单（浏览器端）
  ├─ POST https://ixicai.cn/api/desktop/dofe/validate   校验 key
  ├─ POST https://ixicai.cn/api/desktop/dofe/models     拉模型列表 → 勾选预装插件（PLUGINS）
  └─ save()（顺序敏感，注释明确「授权最后提交，部分写入不会解锁门禁」）
       ├─ settings llm-deepseek.models = 勾选模型
       ├─ credentials.set('MODELS_API_KEY', key)
       ├─ settings agent-default-model = { provider, model }
       └─ settings dofe-access = { setupComplete, validationVersion, enabledPlugins, modelId }
桌面壳（旧 dsh-plugin-desktop）
  ├─ cordis patch：llm-deepseek config 固定 apiKeyEnv=MODELS_API_KEY、baseURL=https://ixicai.cn/api/v1、默认模型；disable ui-settings-models / ui-brand-official
  ├─ 门禁：dofe-managed 无 key/setupComplete!==true/validationVersion!==5 不挂任何 MCP
  ├─ 环境隔离：启动时剥离 MODELS_API_KEY/DEEPSEEK 等 ambient 凭证，凭证只从 credential store 解析
  └─ managed MCP：ROUTES 表 19 条按 enabledPlugins 动态挂载，headers 带 Authorization + X-Company-Code
服务端（不变，零改动）
  ├─ /api/desktop/dofe/{validate,models}  激活 API（保留）
  └─ mcp-gateway nginx：allowlist + auth_request → /api/internal/mcp/auth-context（保留）
```

**关键事实**：旧实现没有自写 credentials provider——存储用官方 `dsh-credentials-local`（该 provider 已内置于官方 base bundle，`- id: credentials / name: '@deepseek-ai/dsh-credentials-local'`），前端直接调 credentials seam 写入。迁移沿用此形态（决策点 3 推荐）。

## 3. A 部分：key 激活页 `@yootun/dsh-client-ui-access`

独立激活包（决策点 7 拆包定案），从 `docker-helm.dofe.ai`（master 分支）`plugins/dsh-yootun-ui` 只读迁移改造（总纲第 4 节只读红线）。2026-11-10 用户定稿：**激活页只做 key 维护 + 模型加载选择，旧「预装插件勾选」（PLUGINS：geoflow/georank/tools/openmontage/opencli/knowledge）整段删除，不迁移**。UI/UX 按分册 05 规范重头设计（决策点 9），不复刻旧视觉。

- 保留（逻辑层）：`settings.section`（id `yootun-access`，替换旧 `dofe-access` 命名空间——设置命名空间与常量统一换 yootun 前缀，**服务端 API 路径不变**）、激活全屏门禁语义（未激活阻断主界面）、key 表单逻辑、`save()` 的顺序敏感写入序列、`removeAccess`。
- 删除：PLUGINS 勾选步骤整体移除；`enabledPlugins` 字段保留写空数组（managed MCP 挂载的门禁输入，后续插件批次按需复用）。
- 激活流程：输入 key → 校验 → 拉取网关模型列表 → 用户选择默认模型 → 顺序提交写入（模型写入逻辑与旧一致）。
- 重设计（视觉层）：全屏门禁卡片、表单、设置页激活管理的视觉按分册 05 重做——旧实现的 inline-style 硬编码样式全部抛弃，改 CSS Modules + 官方 `--dsw-alias-*` token + ui-primitives 组件。
- 修正：`VALIDATION_VERSION` 不再前端硬编码——从 `yootun/brand/brand.json` 构建期注入（决策点 4 定案重置 `1`，与门禁判定同一来源）。
- 0.2.2 适配：inject/peer 包名对齐现行全名；`settings.section` slot 与 credentials seam API 以 0.2.2 实际契约为准核对（vitest scope 外，包内自带 `node --test` 冒烟）。

## 4. B 部分：凭证链

1. `@yootun/dsh-bundle-yootun/cordis.patch.yml` 追加（对齐旧桌面壳 patch）：
   ```yaml
   - id: llm-deepseek
     config:
       apiKeyEnv: MODELS_API_KEY
       baseURL: https://ixicai.cn/api/v1
       models: [ <旧桌面默认模型清单> ]     # 兜底；激活后前端按网关实际列表覆写 settings
   - id: agent-default-model
     config: { provider: deepseek-official, model: <默认模型 id> }
   - insert:
       - id: yootun-ui-access
         name: '@yootun/dsh-client-ui-access'
   ```
2. **实施时查证点（本册唯一硬风险）**：官方 `llm-deepseek` 的 `apiKeyEnv` 在 0.2.2 是否自动回退 credential store（旧桌面壳有专门的 credential-migration 层做这件事）。查证结论二选一：
   - 官方已支持 → 零额外代码；
   - 只读进程环境 → 补一个薄 host 侧插件（bundle patch 注册一行），启动时从 credential store 解析 `MODELS_API_KEY` 注入运行环境，并剥离 ambient 同名凭证（旧壳 dofe-credential-migration.ts 的精简版）。
3. 模型协议确认：旧桌面 0.1.7 曾 disable llm-deepseek 改用 llm-pi-ai 承载路由（protocol 差异）；0.2.2 的 llm-deepseek 若已支持所需协议则直接用，否则照旧方案换承载插件（实施时按网关 `/api/v1/models?protocol=` 实测）。
4. **官方通道自配（2026-11-13 定案）**：不 disable `ui-settings-models`——官方模型设置页保留开放，用户可选自配 DeepSeek 官方 key/通道；yootun key 激活保持强制（managed MCP 凭证依赖 `MODELS_API_KEY`），两者互不替代、互不解锁。实施查证点：用户自配官方通道的实现形态——settings 覆盖 bundle patch 的 llm config，或 `llm-deepseek` 双实例（网关默认 + 官方可选），批次 4 按官方 settings 与 patch 的优先级机制实测定夺。

## 5. C 部分：门禁收敛

**validationVersion 机制说明**（决策点 4）：它是「激活契约版本号」——随激活结果写入用户设置的一个整数；激活流程的数据契约（字段、写入规则）每次变化就 +1，校验方要求「已存版本 == 代码要求的版本」，不相等即视为未激活、强制重新激活，防止旧格式数据在新逻辑下被误认为有效。旧三仓库模式下它已实际漂移过（docker-helm 前端写 3、旧桌面 host 要求 5，旧激活记录被判无效）——这就是单一来源必要性的实证。

- 单一来源：`yootun/brand/brand.json` → 构建期注入前端包与门禁判定处，代码中不再出现第二份字面量。决策点 4 推荐重置 `1`（新桌面新契约、无存量兼容），待用户确认。
- 门禁语义保持旧三层：前端全屏模态（未激活不可用 UI）+ bundle patch 层 config 收紧 + `yootun-access.setupComplete` 判定。旧桌面「工具执行校验/模型 profile 校验」两层在旧壳代码里，官方 0.2.x 无对应挂点——其等效保障由「未激活全屏阻断 + managed MCP 只按 setupComplete 挂载」达成（激活后用户在官方设置页改动模型配置属有意行为，yootun-access 设置区块提供更换 Key 以重写企业默认）；如后续插件批次发现缺口再补 guard 插件。
- 服务端租户校验（`/api/internal/auth/context`、X-Company-Code）在服务端，零客户端改动，`X-Company-Code: yootun` 头随 MCP headers 携带（D 部分）。

## 6. D 部分：managed MCP 骨架（机制就绪、清单为空）

官方 0.2.2 的 mcp-client 原生支持凭证模板绑定（比旧壳动态构建 headers 更干净）：

```yaml
- insert:
    - id: mcp-yootun-<route>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: <32 字符内>
        url: https://ixicai.cn/mcp/<route>
        expandTemplates: true
        headers:
          Authorization: ${credential:MODELS_API_KEY}
          X-Company-Code: yootun
```

- `${credential:REF}` 运行期解析并在诊断中脱敏（`expandTemplates: true`）——凭证轮换无需重建插件实例，替代旧壳的 `credentials/reference-updated` 监听重建逻辑。
- **本批交付 patch 格式定稿 + 一条注释样例**（不注册真实路由）；真实路由随插件勾选清单在后续批次逐条补入同一文件——清单单一来源收敛为 `yootun` bundle 的 cordis.patch.yml（旧三处重复中的客户端侧收敛；网关 route-registry.yml 属服务端仓库）。
- `serverName` 截断教训带入：路由 id 保持短名（旧桌面 64 字符工具名截断问题的对策）。

## 7. E 部分：MCP 权限双通道边界声明

| 通道 | 第一步做到 | 后续（插件批次）做到 |
|---|---|---|
| 会话 | 机制就绪：未激活不挂任何 MCP（C 部分）；挂载清单 = 权限边界（模型只见已挂载 server 的工具） | 「会话只读」策略落地：查询/展示类路由挂载，写/采集类路由不进会话 patch 或经服务端 mcp-gateway 新增 tools/list 裁剪（服务端改造，另立项） |
| 插件页面 | 不涉及（无业务插件） | 插件 host 侧 `ctx.webServer.register` 同源路由直连全能力端点（标准形态，随各插件迁移） |

## 8. F 部分：官方插件能力保留（2026-11-13 定案）

- 一切皆插件原则：yootun 自有包（ui-brand / ui-access / bundle-yootun）均为标准 Cordis 插件/bundle，经 bundle patch 与 profile bundles 列表组合进 desktop profile，与官方内置插件同机制、同地位、同样可被用户层 patch 禁用。
- 官方能力原样保留（web-app bundle 默认内置，desktop 复用，零定制）：Plugins 页（`ui-plugin-manager` / `ui-settings-plugins`）、`tool-plugin-manager` 模型工具、会话动态创建插件（`tool-cordis` + `cordis-host-runner`/`cordis-client-runner` + `ui-cordis` 审批 UI）。
- Discover 自定义插件索引（`plugin-market-bundle`）保持官方默认关闭（2026-11-13 复议定案 B）：它是实验性的索引源机制而非预置市场，开箱无内容且需用户自行添加第三方索引源；yootun 不预置、不默认启用，用户需要时自行开启。用户自选第三方插件的默认途径 = 官方 Plugins 页 Installed 管理 + CLI（`dsh plugin --profile desktop add`）。

## 9. 验收

- [ ] 真机：首次启动被全屏门禁拦截，无法绕过（无 key 时无模型可用）；
- [ ] 输入有效 key：校验通过 → 模型列表拉取 → 激活成功 → 对话可用且走 ixicai.cn 网关（抓包/服务端日志确认）；
- [ ] 移除 key：回到门禁态；
- [ ] `MODELS_API_KEY` 仅存在于 credential store（ambient 环境变量被剥离）；
- [ ] 官方模型设置页可用：用户可自配 DeepSeek 官方 key/通道（yootun 激活状态与 MCP 门禁不受影响）；
- [ ] Plugins 页 Installed 管理可用，会话可创建动态插件（官方能力原样；Discover 保持默认关闭）；
- [ ] managed MCP patch 样例经 `dsh` CLI 干跑（不挂载真实路由）验证 patch 解析与凭证模板展开路径正确；
- [ ] review 子代理验证通过，本地 commit。

## 10. 风险

| 风险 | 对策 |
|---|---|
| apiKeyEnv 不回退 credential store（第 4 节查证点） | 备选薄 host 插件方案已设计，+0.5~1 天 |
| llm 承载插件协议不匹配（旧 llm-pi-ai 先例） | 按网关 protocol 参数实测后选承载插件，patch 结构不变 |
| settings 命名空间迁移（dofe-access → yootun-access）与残留旧值 | 新桌面全新 profile，无存量数据；服务端 API 不读客户端命名空间，无耦合 |
| credentials seam 0.2.2 契约变化 | 以 packages/credentials 源码为准核对 set/unset/reference 事件；包内冒烟测试 |
| 表单 API 路径/协议漂移 | 服务端零改动承诺已确认；实施时以真实 key 全链路联调 |
| 官方通道自配与网关默认配置的优先级（settings 覆盖 vs 双实例） | 批次 4 按官方 settings 优先级机制实测；两种形态 patch 结构均不变 |
