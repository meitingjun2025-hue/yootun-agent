# yootun 测试类型安全规范

状态：现行 ｜ 创建：2026-11-28 ｜ 依据：[1128/features/yootun-test-type-gate.md](1128/features/yootun-test-type-gate.md)

本规范约束 yootun 分区全部测试与辅助文件的类型安全；门禁脚本是 `yootun/scripts/typecheck-tests.mjs`，本文写规则与处置流程。

## 门禁是测试的唯一类型检查

官方 `pnpm run typecheck` 的两个聚合程序（`tsconfig.host.json`、`tsconfig.client.json`）不含 `yootun` 的测试文件，各包的 tsconfig 又只含 `src`：测试的类型检查只有这道门禁，漏跑即无检查。防的是「测试类型错误静默累积，运行时才炸」。

提交前对改动的包各跑一次 `node yootun/scripts/typecheck-tests.mjs --package <包目录名>`；CI 在 `.github/workflows/yootun-desktop-package.yml` 的「Build yootun packages」之后全量运行。门禁必须排在构建之后：被引用项目要读已生成的声明文件。

## 自动纳入

新增测试文件、辅助文件、新增包都自动进入门禁，不需要登记。防的是「新代码绕过检查」。

测试文件必须放在包的 `tests/` 目录（文件名 `*.test.*` 或 `*.spec.*`）；`tests/` 之外的测试文件不在聚合程序的覆盖范围内，门禁直接失败并列出路径。防的是「文件放错位置导致它从未被检查」。

`tests/` 下的文件只检查 `.ts`、`.tsx`、`.mts`、`.cts` 四种扩展名；文件名像测试而扩展名不做类型检查（`.js`、`.jsx`、`.mjs`、`.cjs`）时门禁直接失败，`tests/` 下的 `.mjs` 辅助脚本不做类型检查。防的是「测试写在不做类型检查的扩展名里，看起来有检查其实没有」。

模块增强载体由门禁自动带入：每次运行把所选包 `src/**` 里全部 `import type {}` 空类型导入的说明符生成一个载体文件加入聚合程序，测试不需要也不应该手工补 `import type {} from '…'`。防的是「tsc 生成声明文件丢弃空类型导入后 `Context` 上的增强成员在门禁程序缺席，测试用手工导入补偿并随载体清单漂移」。

## 测试底盘按真实类型写

假对象用 `satisfies` 对齐真实类型（`const fake = { ... } satisfies Face`），多余或缺失的字段在编译期暴露。防的是「假对象与真实接口漂移后测试仍一路绿灯」。

按键取处理函数用有类型的取值辅助函数，取不到即抛错；源码导出键联合时，键的类型就用键联合；源码的清单带 `Readonly<Record<string, …>>` 这类宽注解、取不到键联合时，取值辅助函数必须取不到即抛错并带键名，写错键名在运行测试时暴露；不要 `handlers['works.list']({...})` 裸下标直调。防的是「`Record` 按键取值可能为 `undefined`」——建单时存量最大的一类（209 条）。

辅助函数的参数注解与实际用法一致：注解写错（如注解成 `Promise` 而调用处按函数使用）就改注解，不要用断言硬转。防的是「注解撒谎掩盖接线错误」。

## 压制类型的写法

判定按方向：断言目标是原类型的父类型（向上转型）不降低类型安全，不算压制；`as never`（含尖括号 `<never>x`）、`as any`、经 `unknown`、`{}`、`object` 的两段式断言（`x as unknown as T`、`x as {} as T`、`x as object as T` 及尖括号拼法 `(<unknown>x) as T`、`<{}>x as T`）让编译器接受一个不成立的类型，算压制。防的是「用不成立类型骗过编译器，却声称只是普通断言」。

禁止：`@ts-ignore`、`@ts-nocheck`，以及任何形式的 `any` 类型——`as any`、`: any`、`<any>x`、`Array<any>`、`Record<string, any>`、`any[]`、`<T = any>` 等全部形态（值位置的标识符与属性名、字符串与注释里的字样不算）。指令不看注释形态：行注释与块注释（含 JSDoc 形态）开头紧跟的指令字样都算指令（块注释多行时按 tsc 口径查最后一行行首），写在注释中间的字样不算。防的是「无条件关掉检查，门禁绿灯沦为装饰」。

限用：`@ts-expect-error` 只在 `tests/types/` 的类型层断言文件里可用，同一行用 `--` 写明原因，`--` 位于指令所在行、指令之后（`--` 之后到行尾去掉空白必须有内容；块注释形态同样受限，`--` 之后到行尾去掉结尾定界符与空白必须有内容）。防的是「压制悄悄失效」——错误不再出现时 `@ts-expect-error` 会反过来报错，这是它比 `@ts-ignore` 安全的原因。

只降不升：`as never` 与两段式断言按包、按文件记基线（`yootun/scripts/typecheck-tests.baseline/<包目录名>.json`），修掉后在同一改动里用 `--tighten-baseline` 下调基线；基线数值只减不增，手工调大视为新增压制，超出即失败，基线没有放宽入口。防的是「压制数量随时间单向增长」。

检查范围：文本检查拦的是上面列出的直接写法，包括含桥类型的联合（`x as ({} | null) as T`，联合任一成员是 `unknown`、`{}`、`object` 即算）；等价的其他拼法（`NonNullable<unknown>`、`Record<never, never>` 这类别名或工具类型）与经函数封装的转换（参数或返回值声明成 `unknown`、`any` 的函数，含 `JSON.parse`）不在检查范围，靠 review 对照判定原则把关；一段式 `as unknown`、`<unknown>` 由官方 `verify-no-unknown-casts` 的文件基线兜底。防的是「换等价拼法或经函数封装绕过文本检查后无人对照判定原则」。

处置原则：类型错误的处置是修类型，不是压住；压住只是把运行时炸点推迟到生产。

## 源码与测试同步

源码改名或改签名时同步改测试，改完源码后跑相关包的门禁核对。防的是「测试接线与真实签名脱节」——本单清出的 451 条存量错误多数源于此。

新增 `yootun` 包：无额外登记，包内有 `tests/` 目录即被纳入；尚无测试的包按零文件通过。

新增或修改流程：`Run yootun test type gate` 步骤不可删除，且必须位于 `Build yootun packages` 之后、`Package unsigned installer` 之前；`yootun/scripts/self-test.mjs` 守护该步骤的位置与护栏文档清单里的本规范链接，删除会自检失败；门禁的文本检查由 self-test 的表驱动用例覆盖，判定规则变化时同步样例。

## 出错时的处置流程

1. 读门禁输出的按包汇总，确认本包条数与逐条错误首行（`--verbose` 看 tsc 原文）。
2. 用 `--package <包目录名>` 收窄到单包复现。
3. 修类型（假对象对齐真实签名、补取值辅助函数、删未用导入），不加压制写法。
4. 跑包测试 `pnpm --filter <pkg> test`，再跑一次单包门禁确认通过。
5. 提交。CI 全量门禁失败时同样按包定位，谁的包谁修。
