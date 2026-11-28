/**
 * yootun 测试类型门禁：按官方聚合程序的方式，对 yootun 的测试与辅助文件做一次
 * `tsc -b`，并做基于语法分析的文本检查。官方的两个聚合程序（tsconfig.host.json、
 * tsconfig.client.json）不含 yootun，各包的 tsconfig 又只含 src，yootun 的测试
 * 此前没有任何类型检查。规则全文见 docs/test-type-safety-standard.md。
 *
 * 聚合配置与模块增强载体文件每次运行时生成、不落库：references 取官方两个聚合的
 * 并集再加 yootun 各包项目，被引用项目的源码一律重定向到已生成的声明文件；paths
 * 取 tsconfig.base.json 的全部映射，再加 `@yootun/<包名>` 指向该包的 src。tsc 生成
 * 声明文件时会丢弃 `import type {}` 副作用导入，模块增强（官方包经声明合并加到
 * cordis Context 上的 locale、slots 等成员）在门禁程序里缺席：因此同时生成一个
 * 载体文件，内容是所选各包 src/** 里全部空类型导入的说明符（去重、排序），加入
 * include。程序是单一面（tsconfig.base.client.json 加 node 类型），与 yootun 含
 * 客户端代码的插件检查自身源码的口径相同。
 *
 * 文本检查按每个文件的语法树判定，不做词法近似：`any` 类型按 AnyKeyword 节点计数
 * （值位置的标识符与属性名不算），`as never`（含尖括号 `<never>x`）与两段式断言按
 * 断言节点（AsExpression 与 TypeAssertionExpression）计数，两段式断言指被断言表达
 * 式本身又是断言、且内层断言目标是 unknown、空 {}、object 或含这些类型任一成员
 * 的联合；注释指令在屏蔽全部
 * 叶子记号后的文本上扫描注释判定，行注释与块注释（含 JSDoc 形态）开头的指令字样
 * 都算，块注释多行时按 tsc 口径查最后一行行首，指令写在文件任何位置（首个记号
 * 之前、语句之间、函数体、实参列表、字面量、JSX 属性之间等）都会被判定；字符串、
 * 模板字符串、正则字面量与 JSX 文本是记号，其中的指令字样不算，写在注释中间的
 * 字样也不算。
 * `@ts-ignore`、`@ts-nocheck` 与任何形式的 `any` 类型禁止；`@ts-expect-error`
 * 只在 `tests/types/` 的类型层断言文件里可用且 `--` 位于指令之后写明原因；
 * `as never` 与两段式断言按包、按文件对照基线（typecheck-tests.baseline/<包目录名>.json），
 * 只能下降。基线没有放宽入口：超出基线一律不合规；下降与基线文件消失在不带
 * `--tighten-baseline` 时报不合规，带了就在本次运行把收紧后的基线写回（写回的值
 * 只会是旧基线与实际值中较小的那个，也不新增条目）；删掉基线文件等于按零计。
 *
 * 覆盖范围：tests/ 下的 .ts、.tsx、.mts、.cts 进聚合程序与文本检查；文件名像
 * 测试（*.test.*、*.spec.*）的文件若不在 tests/ 目录、或扩展名不做类型检查
 * （.js、.jsx、.mjs、.cjs），门禁直接失败并列出路径。tests/ 下的 .mjs 辅助脚本
 * 不做类型检查。
 *
 * 本模块可被导入：reviewFileText 是文本检查的纯函数，自检（self-test.mjs）用它
 * 做表驱动用例；只有作为入口直接运行才执行主流程。
 *
 * 前置条件：官方产物与 yootun 包均已构建（流程里排在构建之后）。
 * 运行：`node yootun/scripts/typecheck-tests.mjs [--package <包目录名>]... [--verbose] [--tighten-baseline]`
 * 退出码：全部通过为 0，否则为 1。
 * @module
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const yootunRoot = join(repositoryRoot, 'yootun')
const cacheDir = join(repositoryRoot, 'node_modules', '.cache', 'yootun-typecheck-tests')
const baselineDir = join(yootunRoot, 'scripts', 'typecheck-tests.baseline')
const OFFICIAL_AGGREGATES = ['tsconfig.host.json', 'tsconfig.client.json']
const FACE_CONFIG = 'tsconfig.base.client.json'
const FACE_TYPES = ['node', 'client-build-environment', 'client-assets']
const PREFIX = 'yootun 测试类型检查：'
const USAGE = '用法：node yootun/scripts/typecheck-tests.mjs [--package <包目录名>]... [--verbose] [--tighten-baseline]'
/** tests/ 下进聚合程序与文本检查的扩展名。 */
const TYPECHECKABLE = /\.(ts|tsx|mts|cts)$/u
/** 文件名像测试的形态，含不做类型检查的扩展名（.js、.jsx、.mjs、.cjs）。 */
const TEST_FILE_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/u
/** 类型层断言文件的目录：@ts-expect-error 只在这里可用。 */
const TYPE_ASSERTION_DIR = 'tests/types/'
/** 禁止的指令。 */
const FORBIDDEN_DIRECTIVES = ['@ts-ignore', '@ts-nocheck']
/** 限用的指令：`@ts-expect-error` 只在类型层断言文件可用。 */
const CONDITIONAL_DIRECTIVE = '@ts-expect-error'
/**
 * 注释开头的指令字样：行注释与块注释（含 JSDoc 形态）都算。行注释按 `//`、`///`
 * 等定界符之后匹配，块注释按最后一行行首匹配（tsc 对多行块注释只认最后一行，
 * 单行块注释即注释开头）；定界符可由斜杠、星号与空白混合，指令名前缀匹配，
 * 区分大小写，写在注释中间的字样不算。
 */
const DIRECTIVE = /^[\s/*]*@(ts-ignore|ts-nocheck|ts-expect-error)/u
/** 基线对照的写法，按断言节点计数：`never` 断言与经 unknown、空 {}、object 或含这些类型任一成员的联合的两段式断言。 */
const BASELINED = ['as never', '两段式断言']

/** 偏移所在的 1 基行号。 */
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length

/** .tsx 按 TSX 解析，其余按 TS。 */
const scriptKindOf = fileName => fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS

/**
 * 把全部叶子记号的区间替换成空格（保留换行与宽度），剩下的只有空白与注释：
 * 注释是 trivia，不在任何记号区间内，语句之间、函数体等位置的注释因此保留。
 * 此时文本里没有字符串、模板、正则与 JSX，注释识别无歧义。
 */
function maskCode(text, ranges) {
  ranges.sort((a, b) => a[0] - b[0])
  let masked = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    masked += text.slice(cursor, start) + text.slice(start, end).replace(/[^\n]/gu, ' ')
    cursor = end
  }
  return masked + text.slice(cursor)
}

/** 屏蔽代码后的文本上扫描注释，返回注释文本与所在行（注释区间未被屏蔽，坐标一致）。 */
function commentRanges(masked) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, masked)
  const comments = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind !== ts.SyntaxKind.SingleLineCommentTrivia && kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    const start = scanner.getTokenPos()
    comments.push({ comment: masked.slice(start, scanner.getTokenEnd()), line: lineOf(masked, start) })
  }
  return comments
}

/**
 * 文本检查的纯函数：解析一个文件（.tsx 按 TSX），在语法树上计数 `any` 类型与
 * 基线对照写法，在屏蔽叶子记号后的文本上判定注释指令。字符串、注释、测试标题
 * 里的字样与值位置的 `any` 标识符不算。
 * @param fileName - 相对包根的路径，用于 `tests/types/` 判定与违规行前缀。
 * @param source - 文件的源码文本。
 * @returns `violations` 是已带路径与行号的违规行；`counts` 键为 BASELINED 的写法。
 */
export function reviewFileText(fileName, source) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName))
  const counts = { 'as never': 0, '两段式断言': 0 }
  const codeRanges = []
  let anyCount = 0
  /** AsExpression 与 TypeAssertionExpression（`<T>x`）统称断言，二者结构同为 type + expression。 */
  const isAssertion = node => ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
  /** 括号不改变表达式语义，判定被断言表达式是否又是断言前先穿透括号。 */
  const unwrapped = node => ts.isParenthesizedExpression(node) ? unwrapped(node.expression) : node
  /** 括号不改变类型语义，判定类型节点是否桥类型前先穿透括号。 */
  const unparenthesizedType = type => ts.isParenthesizedTypeNode(type) ? unparenthesizedType(type.type) : type
  /**
   * 两段式断言的内层桥类型：unknown、空 {}（空 TypeLiteral）、object，或含这些
   * 类型任一成员的联合（`{} | null` 等）；any 由「any 禁止」单独拦截。
   */
  const isBridgeType = rawType => {
    const type = unparenthesizedType(rawType)
    return type.kind === ts.SyntaxKind.UnknownKeyword
      || type.kind === ts.SyntaxKind.ObjectKeyword
      || (type.kind === ts.SyntaxKind.TypeLiteral && type.members.length === 0)
      || (ts.isUnionTypeNode(type) && type.types.some(member => isBridgeType(member)))
  }
  const visit = node => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) anyCount += 1
    if (isAssertion(node)) {
      if (node.type.kind === ts.SyntaxKind.NeverKeyword) counts['as never'] += 1
      else {
        const inner = unwrapped(node.expression)
        if (isAssertion(inner) && isBridgeType(inner.type)) counts['两段式断言'] += 1
      }
    }
    // 只屏蔽叶子记号：容器节点不屏蔽，否则其区间会连内部注释（trivia）一起抹掉，
    // 语句之间、函数体、实参列表等嵌套位置的注释指令就漏判了。
    if (ts.isToken(node)) {
      codeRanges.push([node.getStart(sourceFile), node.getEnd()])
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const violations = []
  const directiveHits = new Map()
  for (const { comment, line } of commentRanges(maskCode(source, codeRanges))) {
    // tsc 只认注释开头（块注释多行时为最后一行行首）的指令字样，写在注释中间的不算。
    const tail = comment.slice(comment.lastIndexOf('\n') + 1)
    const match = DIRECTIVE.exec(tail)
    if (match === null) continue
    const word = `@${match[1]}`
    if (word !== CONDITIONAL_DIRECTIVE) {
      directiveHits.set(word, (directiveHits.get(word) ?? 0) + 1)
      continue
    }
    const allowed = fileName.replaceAll('\\', '/').startsWith(TYPE_ASSERTION_DIR)
    if (!allowed) violations.push(`${fileName}:${String(line)}: ${CONDITIONAL_DIRECTIVE} 只在 ${TYPE_ASSERTION_DIR} 的类型层断言文件里可用`)
    else {
      // -- 原因必须写在指令同一行、指令之后；块注释末行的结尾定界符不算内容。
      const body = tail.endsWith('*/') ? tail.slice(0, -2) : tail
      const dash = body.indexOf('--', match.index + match[0].length)
      if (dash < 0 || body.slice(dash + 2).trim() === '') violations.push(`${fileName}:${String(line)}: ${CONDITIONAL_DIRECTIVE} 的 -- 之后必须写明原因`)
    }
  }
  for (const word of FORBIDDEN_DIRECTIVES) {
    if (directiveHits.has(word)) violations.push(`${fileName}: ${word} 禁止使用（${String(directiveHits.get(word))} 处）；修类型，不要压制`)
  }
  if (anyCount > 0) violations.push(`${fileName}: any 类型禁止使用（${String(anyCount)} 处）；修类型，不要压制`)
  return { violations, counts }
}

/** 解析命令行。参数错误返回错误文本（前缀 + 原因 + 用法）而不抛出：一行即可。 */
function parseArguments(argv) {
  const options = { help: false, verbose: false, tightenBaseline: false, packageNames: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--verbose') options.verbose = true
    else if (argument === '--tighten-baseline') options.tightenBaseline = true
    else if (argument === '--package' && argv[index + 1] !== undefined) {
      options.packageNames.push(argv[index + 1])
      index += 1
    } else if (argument === '--package') return `${PREFIX}--package 后面需要一个包目录名；${USAGE}`
    else return `${PREFIX}无法识别的参数 ${JSON.stringify(argument)}；${USAGE}`
  }
  return options
}

/** 读取带注释的 tsconfig（官方配置是 JSONC），返回原始对象。 */
function readConfig(path) {
  const read = ts.readConfigFile(path, ts.sys.readFile)
  if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  return read.config
}

/** 递归列出目录下的文件，跳过 node_modules 与 lib。 */
function listFiles(dir, filter) {
  const files = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (filter(path)) files.push(path)
    }
  }
  if (existsSync(dir)) walk(dir)
  return files
}

const toPosix = path => path.replaceAll('\\', '/')

/** yootun 下带 tsconfig.json 与 package.json 的包项目，按目录名索引。 */
function yootunProjects() {
  const projects = new Map()
  for (const group of ['plugins', 'packages']) {
    const groupDir = join(yootunRoot, group)
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(groupDir, entry.name)
      if (!existsSync(join(dir, 'tsconfig.json')) || !existsSync(join(dir, 'package.json'))) continue
      projects.set(entry.name, { dir, dirName: entry.name, name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name })
    }
  }
  return projects
}

/** 包的测试与辅助文件：tests/ 下的 .ts / .tsx / .mts / .cts。 */
const testSourcesOf = project => listFiles(join(project.dir, 'tests'), path => TYPECHECKABLE.test(path))

/** yootun 全部包的 CSS Modules 声明。 */
function cssDeclarations(projects) {
  return [...projects.values()].flatMap(project => listFiles(join(project.dir, 'src'), path => /[/\\]css-modules\.d\.ts$/u.test(path)))
}

/** 文件名像测试而不在 tests/ 目录的文件。 */
function strayTestFiles() {
  return listFiles(yootunRoot, path => TEST_FILE_NAME.test(path) && !toPosix(path).split('/').includes('tests'))
}

/** tests/ 目录下文件名像测试而扩展名不做类型检查的文件。 */
function untypedTestFiles() {
  return listFiles(yootunRoot, path => TEST_FILE_NAME.test(path) && !TYPECHECKABLE.test(path) && toPosix(path).split('/').includes('tests'))
}

/** 一个包 src/** 里全部 `import type {}` 空类型导入的说明符（模块增强载体），去重排序。 */
function augmentationSpecifiers(project) {
  const specifiers = new Set()
  for (const file of listFiles(join(project.dir, 'src'), path => TYPECHECKABLE.test(path))) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('import type')) continue
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file))
    const visit = node => {
      if (ts.isImportDeclaration(node) && node.importClause !== undefined && node.importClause.isTypeOnly) {
        const bindings = node.importClause.namedBindings
        if (node.importClause.name === undefined && (bindings === undefined || (ts.isNamedImports(bindings) && bindings.elements.length === 0))) {
          specifiers.add(node.moduleSpecifier.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return [...specifiers].sort()
}

/** 生成模块增强载体文件：每行一条空类型导入，把所选包的模块增强重新引入程序。 */
function writeAugmentationFile(fileName, specifiers) {
  const body = [
    '// 自动生成，不落库：所选各包 src/** 里全部 `import type {}` 空类型导入的说明符（去重、排序）。',
    '// tsc 生成声明文件时会丢弃空类型导入，模块增强会从门禁程序缺席，此文件把它们重新引入。',
    ...specifiers.map(specifier => `import type {} from ${JSON.stringify(specifier)}`),
  ]
  mkdirSync(cacheDir, { recursive: true })
  const path = join(cacheDir, fileName)
  writeFileSync(path, `${body.join('\n')}\n`)
  return path
}

/** 生成聚合 tsconfig 并返回其路径。 */
function writeAggregateConfig(fileName, projects, include) {
  const base = readConfig(join(repositoryRoot, 'tsconfig.base.json'))
  const faceBase = readConfig(join(repositoryRoot, FACE_CONFIG))
  const baseUrl = faceBase.compilerOptions?.baseUrl ?? base.compilerOptions?.baseUrl ?? '.'
  const paths = {}
  for (const [pattern, targets] of Object.entries(faceBase.compilerOptions?.paths ?? base.compilerOptions.paths)) {
    paths[pattern] = targets.map(target => resolve(repositoryRoot, baseUrl, target))
  }
  for (const project of projects.values()) paths[project.name] = [join(project.dir, 'src')]
  const references = new Set()
  for (const aggregate of OFFICIAL_AGGREGATES) {
    for (const reference of readConfig(join(repositoryRoot, aggregate)).references ?? []) {
      references.add(resolve(repositoryRoot, reference.path))
    }
  }
  for (const project of projects.values()) references.add(project.dir)
  const config = {
    extends: join(repositoryRoot, FACE_CONFIG),
    compilerOptions: { noEmit: true, rewriteRelativeImportExtensions: false, types: FACE_TYPES, paths },
    include,
    references: [...references].sort().map(path => ({ path })),
  }
  mkdirSync(cacheDir, { recursive: true })
  const configPath = join(cacheDir, fileName)
  writeFileSync(configPath, `${JSON.stringify(config, null, 1)}\n`)
  return configPath
}

/** 运行 tsc；verbose 时原样输出，否则返回标准输出供汇总。 */
function runTsc(configPath, verbose) {
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', configPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.stderr !== '') process.stderr.write(result.stderr)
  if (result.error !== undefined) throw result.error
  if (verbose && result.stdout !== '') process.stdout.write(result.stdout)
  return { passed: result.status === 0, stdout: result.stdout ?? '' }
}

/** 类型错误：按包汇总，并保留每条的首行。 */
function collectTypeErrors(stdout) {
  const packages = new Map()
  const lines = []
  let outside = 0
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/u.exec(line)
    if (match === null) continue
    lines.push(line)
    const path = toPosix(relative(repositoryRoot, resolve(repositoryRoot, match[1])))
    const pkg = /^yootun\/(?:plugins|packages)\/([^/]+)\/tests\//u.exec(path)
    if (pkg === null) outside += 1
    else packages.set(pkg[1], (packages.get(pkg[1]) ?? 0) + 1)
  }
  return { total: lines.length, outside, packages, lines }
}

/** 读一个包的压制写法基线；没有文件按零计。 */
function readBaseline(dirName) {
  const path = join(baselineDir, `${dirName}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

/** 写回一个包的基线；全部条目清零时删除文件。 */
function writeBaseline(dirName, next) {
  const path = join(baselineDir, `${dirName}.json`)
  if (Object.values(next).every(entries => Object.keys(entries).length === 0)) {
    if (existsSync(path)) rmSync(path)
    return
  }
  mkdirSync(baselineDir, { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 1)}\n`)
}

/**
 * 一个包的压制写法检查。返回违规清单与是否收紧了基线；tighten 为真且确有下降
 * 时，把基线写回到旧基线与实际值中较小的那个（不新增条目），下降与基线文件
 * 消失的条目算已处理，不再进违规清单；超出基线的条目任何情况下都违规。
 */
function reviewSuppressions(project, tighten) {
  const violations = []
  /** 下降与文件消失的提示；不带 --tighten-baseline 时并入违规清单。 */
  const tightening = []
  const next = {}
  let decreased = false
  const counts = new Map()
  for (const file of testSourcesOf(project)) {
    const key = toPosix(relative(project.dir, file))
    const result = reviewFileText(key, readFileSync(file, 'utf8'))
    violations.push(...result.violations)
    counts.set(key, result.counts)
  }
  const baseline = readBaseline(project.dirName)
  for (const label of BASELINED) {
    const recorded = baseline[label] ?? {}
    next[label] = {}
    for (const [key, entry] of [...counts].sort()) {
      const actual = entry[label]
      const allowed = recorded[key] ?? 0
      if (actual > allowed) violations.push(`${key}: ${label} ${String(actual)} 处，基线只允许 ${String(allowed)} 处；修类型，不要压制`)
      if (actual < allowed) {
        decreased = true
        tightening.push(`${key}: ${label} 降到 ${String(actual)} 处，低于基线 ${String(allowed)}；用 --tighten-baseline 下调`)
      }
      const kept = Math.min(actual, allowed)
      if (kept > 0) next[label][key] = kept
    }
    for (const key of Object.keys(recorded)) {
      if (counts.has(key)) continue
      decreased = true
      tightening.push(`${key}: 基线记录的 ${label} 文件已不存在；用 --tighten-baseline 下调`)
    }
  }
  if (tighten && decreased) writeBaseline(project.dirName, next)
  return { violations: tighten ? violations : [...violations, ...tightening], tightened: tighten && decreased }
}

/** 只有作为入口直接运行才执行主流程：导入本模块（自检）不得触发 tsc。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const parsed = parseArguments(process.argv.slice(2))
  if (typeof parsed === 'string') {
    process.stdout.write(`${parsed}\n`)
    process.exitCode = 1
  } else if (parsed.help) process.stdout.write(`${USAGE}\n`)
  else run(parsed)
}

/** 门禁主体；包名不存在时输出一行错误并按失败退出。 */
function run(options) {
  const projects = yootunProjects()
  for (const name of options.packageNames) {
    if (!projects.has(name)) {
      process.stdout.write(`${PREFIX}yootun 下没有包 ${JSON.stringify(name)}\n`)
      process.exitCode = 1
      return
    }
  }
  const selected = options.packageNames.length === 0 ? [...projects.values()] : options.packageNames.map(name => projects.get(name))
  const sources = selected.flatMap(testSourcesOf)
  const declarations = cssDeclarations(projects)
  const configFileName = options.packageNames.length === 0 ? 'tsconfig.json' : `tsconfig.${options.packageNames.join('+')}.json`
  const specifiers = [...new Set(selected.flatMap(augmentationSpecifiers))].sort()
  const augmentationFile = writeAugmentationFile(configFileName.replace(/^tsconfig\./u, 'augmentations.').replace(/\.json$/u, '.ts'), specifiers)
  const include = [...sources, ...declarations, augmentationFile].sort()

  // 覆盖检查：游离的测试文件与不做类型检查的测试文件。
  const misplaced = [
    ...strayTestFiles().map(path => ({ path: toPosix(relative(repositoryRoot, path)), reason: '测试文件不在 tests/ 目录' })),
    ...untypedTestFiles().map(path => ({ path: toPosix(relative(repositoryRoot, path)), reason: '测试文件的扩展名不做类型检查' })),
  ]
  // 压制类型的写法。
  const reviews = selected.map(project => ({ project, review: reviewSuppressions(project, options.tightenBaseline) }))
  const suppressions = reviews.flatMap(({ review }) => review.violations)
  for (const { project, review } of reviews) {
    if (review.tightened) process.stdout.write(`${PREFIX}${project.dirName} 的压制写法基线已收紧\n`)
  }
  // 聚合类型检查。
  const { passed, stdout } = runTsc(writeAggregateConfig(configFileName, projects, include), options.verbose)
  const errors = collectTypeErrors(stdout)

  process.stdout.write(`${PREFIX}${String(include.length)} 个文件（测试与辅助 ${String(sources.length)}，CSS Modules 声明 ${String(declarations.length)}）\n`)
  process.stdout.write(`类型错误：合计 ${String(errors.total)} 条\n`)
  for (const [name, count] of [...errors.packages].sort((a, b) => b[1] - a[1])) process.stdout.write(`  ${name}: ${String(count)} 条\n`)
  if (errors.outside > 0) process.stdout.write(`  yootun 测试目录之外: ${String(errors.outside)} 条（程序组成有误的信号）\n`)
  if (!options.verbose && errors.lines.length > 0) process.stdout.write(`${errors.lines.join('\n')}\n`)
  process.stdout.write(`压制类型的写法：${suppressions.length === 0 ? '合规' : `${String(suppressions.length)} 处不合规`}\n`)
  if (suppressions.length > 0) process.stdout.write(`${suppressions.map(line => `  ${line}`).join('\n')}\n`)
  process.stdout.write(`游离的测试文件：${misplaced.length === 0 ? '无' : `${String(misplaced.length)} 个`}\n`)
  if (misplaced.length > 0) process.stdout.write(`${misplaced.map(entry => `  ${entry.path}：${entry.reason}`).join('\n')}\n`)
  const ok = passed && suppressions.length === 0 && misplaced.length === 0
  process.stdout.write(`${PREFIX}${ok ? '通过' : '未通过'}\n`)
  // 不用 process.exit()：输出走管道时写入是异步的，立即退出会截断未写完的内容。
  process.exitCode = ok ? 0 : 1
}
