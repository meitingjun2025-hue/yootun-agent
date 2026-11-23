/**
 * parse/collector 纯逻辑测试（node --test）：fixture 键名与 docker-helm 仓库
 * docs/0909|1015 真机脱敏样例逐字段一致（值占位）。覆盖：19 位 ID 引号预处理、
 * 无 -0、数值判缺不造 0（pct(null)≠0）、列表五种不完整判定、publishSince 边界、
 * 三路合并与缺口语义、item_compare 三种门槛形态 + 会话码、画像/搜索词/热词/
 * 进度/大盘 snake 列、粉丝画像六类、metrics_trend 最近 7 完成日。
 * 运行：`node --test tests/parse.test.ts`。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildWorkPayload, decidePagination, dedupeWorks, dashboardDay, mergeDashboardRows,
  parseDashboardMetrics, parseFansSummary, parseItemCompare, parseItemMetricsTrend, parseItemMget,
  parseItemPerformance, parseItemSummarize, parseJsonPreservingIds, parsePlaySource, parsePortrait,
  parseProgressAnalysis, parseRealtimeTrend, parseSearchKeywords, parseWordCloud, parseWorkListPage,
  pct, quoteLongNumbers, resolveClientStatus, round2, toInt, toNumber, SessionInvalidError,
  type MgetRow, type SummarizeRow, type WorkItem,
} from '../src/parse.ts'
import { filterWorksByPublishSince, WORK_PUBLISH_SINCE_ISO, WORK_PUBLISH_SINCE_REPORT, WORK_PUBLISH_SINCE_MS } from '../src/collector.ts'

const FIXTURES = join(new URL('..', import.meta.url).pathname, 'tests', 'fixtures')
const fx = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

/** 最小 WorkItem 构造器（列表字段可覆盖）。 */
function makeWork(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    workId: '7412345678901234001', title: '占位标题', url: 'https://www.douyin.com/video/1',
    publishTime: '2026-11-01T00:00:00.000Z', playCount: 10, likeCount: 1, commentCount: 2,
    collectCount: 3, shareCount: 4, danmakuCount: 5, durationSeconds: 12.3,
    cover: 'https://p.douyinpic.invalid/x.webp', isPrivate: false, ...overrides,
  }
}

/** 最小 buildWorkPayload 输入（compare/mget/summarize 用真实解析产物）。 */
function fullInputs(overrides: Partial<Parameters<typeof buildWorkPayload>[0]> = {}): Parameters<typeof buildWorkPayload>[0] {
  const work = makeWork()
  const mget = parseItemMget(fx('item_mget.sample.json'))
  const summarize = parseItemSummarize(fx('item_summarize.sample.json'))
  return {
    work,
    performance: { play_count: 11, avg_watch_duration_s: 1, completion_rate_5s_pct: 50, bounce_rate_2s_pct: 20, cover_url: null },
    compare: parseItemCompare(fx('item_compare.high.sample.json')),
    source: [{ source_key: 'homepage_hot', source_label: '推荐(首页推荐)', share_pct: 60 }, { source_key: 'search', source_label: null, share_pct: 40 }],
    portrait: parsePortrait(fx('portrait.sample.json')),
    search: [{ keyword: '占位词', percent: 50 }],
    progress: { dragBackward: [{ key: '1', value: 10 }], dragForward: [{ key: '2', value: 20 }], empty: false },
    retention: { current: [{ key: '00:01', value: 1 }], similar: [], valleys: [], empty: false },
    retentionGap: null,
    bounce: { current: [], similar: [], valleys: [], empty: true },
    bounceGap: null,
    mget,
    summarize,
    hotword: { status: 'ok', statusCode: 0, words: [{ word: '占位热词', rank: 1, raw_score: null }] },
    metricsTrend: [{ day: '2026-11-20', playCount: 5 }, { day: '2026-11-21', playCount: 6 }],
    metricsTrendGap: null,
    observedAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  }
}

test('quoteLongNumbers：19 位 aweme_id 裸数字加引号（float64 舍入防线），短数字不动', () => {
  const id = '7412345678901234567'
  const quoted = quoteLongNumbers(`{"aweme_id":${id},"count":12}`)
  const parsed: unknown = JSON.parse(quoted)
  const record = parsed as { aweme_id: string; count: number }
  assert.equal(record.aweme_id, id, '19 位 ID 必须以字符串保真')
  assert.equal(record.count, 12)
  assert.equal(parseJsonPreservingIds('not json'), null)
})

test('quoteLongNumbers 字符串感知（D9B 真机缺陷回归）：字符串内长数字不加引号', () => {
  // 旧插件 parse.js 同款语义：字符串值内部（含转义嵌套 JSON，如 work_list 的
  // luna_song_id）长数字原样保留；朴素加引号会写出嵌套引号破坏 JSON，整页
  // 解析失败被归因 invalid_json（2026-11-22 D9B 真机 run 8140786a 复现）。
  const text = '{"meta":"{\\"luna_song_id\\":\\"7388141571378841638\\",\\"scene\\":0}","aweme_id":7699086779752475881}'
  const parsed = parseJsonPreservingIds(text) as { meta: string; aweme_id: string } | null
  assert.notEqual(parsed, null, '嵌套转义字符串内的长数字不得破坏 JSON')
  assert.equal(parsed?.aweme_id, '7699086779752475881', '字符串外裸数字仍加引号保真')
  assert.ok((parsed?.meta ?? '').includes('7388141571378841638'), '字符串内长数字原样保留')
  // 字符串内 16+ 位数字（正文出现）原样保留。
  const prose = quoteLongNumbers('{"desc":"订单号 1234567890123456 已核销"}')
  assert.equal((JSON.parse(prose) as { desc: string }).desc, '订单号 1234567890123456 已核销')
  // 小数与科学计数不被拆引（prev 字符防御）。
  const numeric = parseJsonPreservingIds('{"ratio":1.2345678901234567,"big":1e21}') as { ratio: number; big: number }
  assert.equal(numeric.ratio > 1.2, true)
  assert.equal(numeric.big, 1e21)
})

test('数值守卫：pct(null)/pct(true)/round2(null)/toInt(null) 必须为 null，绝不伪造成 0', () => {
  assert.equal(toNumber(''), null)
  assert.equal(toNumber(true), null)
  assert.equal(Object.is(toNumber(-0), 0), true)
  assert.equal(pct(null), null, '反例：pct(null) 不得等于 0')
  assert.equal(pct(true), null, '布尔不是比率')
  assert.equal(pct(''), null)
  assert.equal(pct(0.5), 50)
  assert.equal(pct(1.2), null, '百分比越界记缺口')
  assert.equal(pct(-0.1), null)
  assert.equal(round2(null), null, '反例：round2(null) 不得把平均观看时长伪造成 0')
  assert.equal(round2(undefined), null)
  assert.equal(round2(-1), null)
  assert.equal(round2(13.456), 13.46)
  assert.equal(toInt(null), null)
  assert.equal(toInt(undefined), null)
  assert.equal(toInt('8'), 8, '字符串数字（status_code 常见形态）可转')
  assert.equal(Object.is(toInt(-0.2), 0), true)
  assert.equal(dashboardDay('2026-02-30'), null, 'roll-over 非法日期返回 null')
  assert.equal(dashboardDay(20261001), '2026-10-01', '数字 YYYYMMDD 也接受')
})

test('isSessionExpiredPayload：status_code 经 toInt 后判 8（字符串 "8" 同样命中）', () => {
  // 通过 parseWorkListPage 的抛错路径断言（解析层入口即会话判定点）。
  assert.throws(() => parseWorkListPage({ status_code: 8 }), SessionInvalidError)
  assert.throws(() => parseWorkListPage({ status_code: '8' }), SessionInvalidError)
  assert.throws(() => parseWorkListPage(fx('work_list.status_code_8.sample.json')), SessionInvalidError)
})

test('parseWorkListPage：aweme_list 归一、rawCount 按原始列表长度', () => {
  const page = parseWorkListPage({ status_code: 0, aweme_list: [{ aweme_id: '1', statistics: { play_count: 5 } }, null], has_more: false })
  assert.equal(page.works.length, 1)
  assert.equal(page.works[0]?.playCount, 5)
  assert.equal(page.rawCount, 2, 'rawCount 含无效行（旧 parse.js 同口径）')
  const web = parseWorkListPage((fx('work_list.web_cover.sample.json') as { data: unknown }).data)
  assert.equal(web.works.length, 2, 'Web 模式：大写 Cover/顶层 duration/私密作品')
  assert.equal(web.works[0]?.durationSeconds, 39.22, '顶层 duration（毫秒）转秒')
  assert.equal(web.works[0]?.cover, 'https://p-sign.douyinpic.invalid/example~tplv.webp')
  assert.equal(web.works[1]?.isPrivate, true)
})

test('normalizeWork：Statistics/Video/Status 大写兜底、isPrivate 别名、createTime/camelCase 兜底', () => {
  const page = parseWorkListPage({
    status_code: 0,
    aweme_list: [{
      awemeId: '7412345678901234009',
      Description: '占位大写键标题',
      createTime: '1792000000',
      Statistics: { playCount: 66, diggCount: 6 },
      Status: { isPrivate: true },
    }],
    has_more: false,
  })
  const work = page.works[0]
  assert.equal(work?.workId, '7412345678901234009')
  assert.equal(work?.title, '占位大写键标题')
  assert.equal(work?.playCount, 66, 'camelCase 计数兜底')
  assert.equal(work?.likeCount, 6)
  assert.equal(work?.publishTime, new Date(1792000000 * 1000).toISOString(), '字符串 create_time 经 toInt')
  assert.equal(work?.isPrivate, true, 'isPrivate 别名')
})

test('decidePagination：has_more_false 即健康完整；四种不完整 reason', () => {
  const page = (hasMore: boolean, rawCount: number, nextCursor: string): ReturnType<typeof parseWorkListPage> =>
    ({ hasMore, works: [], nextCursor, rawCount })
  const healthy = decidePagination(page(false, 3, '9'), '0', 1, 10)
  assert.deepEqual(healthy, { stop: true, listComplete: true, reason: 'has_more_false' })
  assert.deepEqual(decidePagination(page(true, 0, '9'), '0', 1, 10), { stop: true, listComplete: false, reason: 'empty_page_with_more' })
  assert.deepEqual(decidePagination(page(true, 3, '5'), '5', 2, 10), { stop: true, listComplete: false, reason: 'cursor_not_advancing' })
  assert.deepEqual(decidePagination(page(true, 3, '9'), '5', 10, 10), { stop: true, listComplete: false, reason: 'max_pages_reached' })
  assert.deepEqual(decidePagination(page(true, 3, '9'), '5', 2, 10), { stop: false, listComplete: false, reason: 'continue' })
})

test('publishSince 边界：前一秒不保留、恰为 cutoff 保留、缺失不入库、过滤在详情前', () => {
  assert.equal(Date.parse(WORK_PUBLISH_SINCE_ISO), Date.parse(WORK_PUBLISH_SINCE_REPORT), '双字面量同一时刻')
  const cutoffMs = WORK_PUBLISH_SINCE_MS
  const before = new Date(cutoffMs - 1000).toISOString()
  const at = new Date(cutoffMs).toISOString()
  const after = new Date(cutoffMs + 1000).toISOString()
  const works: WorkItem[] = [before, at, after, null].map((publishTime, index) => ({
    workId: `w${String(index)}`,
    title: null, url: null, publishTime: publishTime as string | null,
    playCount: null, likeCount: null, commentCount: null, collectCount: null, shareCount: null,
    danmakuCount: null, durationSeconds: null, cover: null, isPrivate: false,
  }))
  const filtered = filterWorksByPublishSince(works)
  assert.deepEqual(filtered.works.map(work => work.workId), ['w1', 'w2'], '恰为 cutoff 保留、前一秒剔除')
  assert.equal(filtered.publishTimeMissing, 1)
  assert.equal(filtered.skippedBeforePublishSince, 1)
})

test('parseItemPerformance：真实结构 items[]（反例：旧臆造 item_performance_list 无值）', () => {
  const map = parseItemPerformance(fx('item_analysis.sample.json'))
  const row = map.get('7412345678901234001')
  assert.ok(row, '真实键 item_id 命中')
  assert.equal(row?.play_count, 10000)
  assert.equal(row?.avg_watch_duration_s, 13.46)
  assert.equal(row?.completion_rate_5s_pct, 40.17)
  assert.equal(row?.bounce_rate_2s_pct, 31.73)
  assert.equal(row?.cover_url, 'https://example.invalid/cover-a.jpeg')
  const empty = parseItemPerformance({ item_performance_list: [{ item_id: 'x', play_count: 1 }] })
  assert.equal(empty.size, 0, '旧臆造键 item_performance_list 不产生任何行')
})

test('parseItemCompare：成功（item.metrics）/10001/10005/8 四形态', () => {
  const high = parseItemCompare(fx('item_compare.high.sample.json'))
  assert.equal(high.gapReason, null)
  assert.equal(high.statusCode, 0)
  assert.equal(high.metrics.play_count, 10000, 'view_count → play_count')
  assert.equal(high.metrics.avg_watch_duration_s, 13.46, 'avg_view_second → avg_watch_duration_s')
  assert.equal(high.metrics.completion_rate_pct, 3.09)
  assert.equal(high.metrics.completion_rate_5s_pct, 40.17)
  assert.equal(high.metrics.bounce_rate_2s_pct, 31.73)
  assert.equal(high.metrics.avg_view_proportion_pct, 17.61)
  assert.equal(high.metrics.cover_click_rate_pct, 1.23)
  assert.equal(high.metrics.follower_play_ratio_pct, 0.53, 'fan_view_proportion → follower_play_ratio_pct')
  assert.deepEqual(high.engagement_rates, { like_rate: 0.91, comment_rate: 0.09, share_rate: 0.03, favorite_rate: 0.05 })

  const low = parseItemCompare(fx('item_compare.low.sample.json'))
  assert.equal(low.statusCode, 10001)
  assert.equal(low.lowPlay, true)
  assert.equal(low.gapReason, 'below_min_view')
  assert.equal(low.hasMetrics, false)
  assert.equal(low.statusMessage, 'view count less than min view count')

  const past = parseItemCompare(fx('item_compare.past_count.sample.json'))
  assert.equal(past.statusCode, 10005)
  assert.equal(past.gapReason, 'past_item_below_min_count', '10005 记历史作品数门槛')
  assert.equal(past.metrics.play_count, 100, '10005 仍解析 item.metrics（有则用）')
  assert.equal(past.metrics.completion_rate_pct, 20)

  const expired = parseItemCompare(fx('item_compare.session_expired.sample.json'))
  assert.equal(expired.statusCode, 8, 'status_code=8 不在 compare 解析层抛出（collector 统一判定）')
  assert.equal(expired.gapReason, 'not_exposed')
  assert.equal(expired.hasMetrics, false)
})

test('parseItemCompare 反例：旧臆造结构 {data:{view_count}} 必须 not_exposed', () => {
  const wrong = parseItemCompare({ status_code: 0, data: { view_count: 100, avg_view_second: 3, completion_rate: 0.5 } })
  assert.equal(wrong.gapReason, 'not_exposed', 'data 键是臆造结构，真实键为 item.metrics')
  assert.equal(wrong.hasMetrics, false)
  assert.equal(wrong.metrics.play_count, null)
})

test('parsePlaySource：真实 key 中文标签映射 + 降序', () => {
  const rows = parsePlaySource(fx('play_source.sample.json'))
  assert.ok(rows !== null && rows.length === 5)
  assert.deepEqual(rows?.map(row => row.source_key), ['homepage_hot', 'homepage', 'familiar', 'follow', 'search'])
  assert.deepEqual(rows?.map(row => row.source_label), ['推荐(首页推荐)', '个人主页', '朋友/熟人', '关注', '搜索'], 'SOURCE_LABELS 与真实枚举一致')
  assert.equal(rows?.[0]?.share_pct, 99.36)
  const unknown = parsePlaySource({ status_code: 0, play_source: [{ key: 'future_source', value: 0.5 }] })
  assert.equal(unknown?.[0]?.source_label, null, '未知 key 不编造标签')
  assert.equal(parsePlaySource({ status_code: 0 }), null, '无 play_source 数组 → 缺口 null')
})

test('parsePortrait：ratio_list[].value 四块、降序、province 截前 8', () => {
  const portrait = parsePortrait(fx('portrait.sample.json'))
  assert.ok(portrait, '真实结构 ratio_list 必须产出四块')
  assert.deepEqual(portrait?.gender, [{ key: 'male', pct: 92.66 }, { key: 'female', pct: 7.34 }])
  assert.equal(portrait?.age[0]?.key, '41-50', '按 pct 降序')
  assert.equal(portrait?.city_level.length, 3)
  // 反例：旧臆造结构 gender[].ratio 必须为 null。
  assert.equal(parsePortrait({ gender: [{ key: 'male', ratio: 0.9 }] }), null, '臆造键 ratio 不产出任何块')
  // 10 省乱序 → 排序后取前 8。
  const many = parsePortrait({
    province: { ratio_list: Array.from({ length: 10 }, (_, i) => ({ key: `省${String(i)}`, value: (10 - i) / 100 })) },
  })
  assert.equal(many?.province.length, 8)
  assert.equal(many?.province[0]?.key, '省0')
  assert.equal(many?.gender.length, 0, '单块缺失时其余块为空数组而非 null（旧 parse.js 同口径）')
})

test('parseSearchKeywords：word 别名、percent 缺失/非数值行剔除、降序', () => {
  const rows = parseSearchKeywords(fx('search_keywords.sample.json'))
  assert.deepEqual(rows?.map(row => row.keyword), ['占位词乙', '占位词甲'], 'word 别名命中 + 按 percent 降序')
  assert.deepEqual(rows?.map(row => row.percent), [90, 30], '缺 percent 与 null percent 行剔除')
  assert.deepEqual(parseSearchKeywords({ show_from: [] }), [], 'show_from 空数组是有效数据（该作品确无搜索词）')
  assert.equal(parseSearchKeywords({ status_code: 0 }), null, 'show_from 缺失 → 缺口 null')
})

test('parseItemMget：items[].metrics.*（反例：旧臆造顶层平铺无值）', () => {
  const map = parseItemMget(fx('item_mget.sample.json'))
  const row = map.get('7412345678901234001')
  assert.ok(row, 'id 键命中')
  assert.equal(row?.danmaku_count, 7, '字符串弹幕数转整数（非空）')
  assert.equal(row?.play_count, 7000, 'metrics.view_count → play_count')
  assert.equal(row?.avg_watch_duration_s, 12.78)
  assert.equal(row?.completion_rate_pct, 12.09)
  assert.equal(row?.follower_play_ratio_pct, 1, 'fan_view_proportion → follower_play_ratio_pct')
  // 反例：旧臆造结构（顶层平铺 + item_id）解析不出弹幕数。
  const wrong = parseItemMget({ items: [{ item_id: '7412345678901234001', danmaku_count: 7, view_count: 90 }] })
  const wrongRow = wrong.get('7412345678901234001')
  assert.equal(wrongRow?.danmaku_count, null, '臆造顶层键不产生值（真实键在 metrics 内）')
})

test('parseItemSummarize：summarize_data 两字段独立判缺（反例：旧臆造顶层键无值）', () => {
  const map = parseItemSummarize(fx('item_summarize.sample.json'))
  const row = map.get('7412345678901234001')
  assert.ok(row, 'aweme_id 键命中')
  assert.equal(row?.completion_rate_pct, 12.09, 'play_finish_ratio ×100')
  assert.equal(row?.fans_gain_count, 9, 'new_fans_count 吸粉量（非空）')
  const negative = parseItemSummarize({ item_list: [{ aweme_id: 'w2', summarize_data: { play_finish_ratio: 0.6, new_fans_count: -3 } }] })
  assert.equal(negative.get('w2')?.fans_gain_count, null, '负吸粉记缺口不造值')
  assert.equal(negative.get('w2')?.completion_rate_pct, 60, '两字段独立判缺')
  const wrong = parseItemSummarize({ item_list: [{ item_id: 'w3', play_finish_ratio: 0.6, new_fans_count: 2 }] })
  assert.equal(wrong.size, 0, '反例：旧臆造顶层键（真实键 summarize_data）不建行')
  const bothNull = parseItemSummarize({ item_list: [{ aweme_id: 'w4', summarize_data: {} }] })
  assert.equal(bothNull.size, 0, '双字段皆缺跳过')
})

test('parseWordCloud：ok 三态、负 rank 收敛 0、非零状态码 unavailable', () => {
  const ok = parseWordCloud(fx('wordCloud.sample.json'))
  assert.equal(ok.status, 'ok')
  assert.equal(ok.words.length, 3)
  assert.equal(ok.words[0]?.word, '占位词甲')
  assert.equal(ok.words[2]?.rank, 0, '负 rank 收敛 0（旧 parse.js Math.max 同口径）')
  assert.equal(ok.words[0]?.raw_score, '2')
  assert.deepEqual(parseWordCloud({ status_code: 5 }), { status: 'unavailable', statusCode: 5, words: [] })
  assert.deepEqual(parseWordCloud({}), { status: 'unavailable', statusCode: null, words: [] })
})

test('parseProgressAnalysis：jump_backward/jump_forward 曲线 + empty 标记', () => {
  const progress = parseProgressAnalysis(fx('progress_analysis.sample.json'))
  assert.ok(progress)
  assert.deepEqual(progress?.dragBackward, [{ key: '1', value: 1 }, { key: '2', value: 0.8 }])
  assert.equal(progress?.empty, false)
  const empty = parseProgressAnalysis({ jump_backward: [], jump_forward: [] })
  assert.equal(empty?.empty, true, '空曲线 + 无 video_data → no_data')
  assert.equal(parseProgressAnalysis({ status_code: 0 }), null, '两数组皆缺失 → 缺口 null')
})

test('parseDashboardMetrics：date_time（YYYYMMDD）+ snake 列 + 比率 ×100（真实 fixture ≥1 行）', () => {
  const rows = parseDashboardMetrics(fx('dashboard.sample.json'))
  assert.ok(rows.length >= 1, '反例：旧实现读 date|day 得 0 行')
  assert.equal(rows.length, 3)
  assert.equal(rows[0]?.day, '2026-10-01')
  // snake 列直投服务端 DouyinAccountDailyItem（share_count→share_cnt 唯一不对称）。
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), [
    'avg_view_second', 'bounce_rate_2s_pct', 'cancel_fans_cnt', 'comment_cnt', 'completion_rate_5s_pct',
    'cover_click_ratio_pct', 'day', 'digg_cnt', 'homepage_view_cnt', 'net_fans_cnt', 'play_cnt',
    'publish_cnt', 'share_cnt', 'total_fans_cnt',
  ])
  assert.equal(rows[0]?.play_cnt, 7407)
  assert.equal(rows[0]?.share_cnt, 27, 'share_count → share_cnt')
  assert.equal(rows[0]?.cover_click_ratio_pct, 3, '比率 ×100')
  assert.equal(rows[0]?.completion_rate_5s_pct, 36)
  assert.equal(rows[0]?.bounce_rate_2s_pct, 14.4)
  assert.equal(rows[0]?.avg_view_second, 7.38, '秒数不换算')
  const fans = parseDashboardMetrics(fx('dashboard_fans.sample.json'))
  assert.equal(fans[0]?.home_view_fans_cnt, 4, 'home_view_fans_cnt 列名（服务端同名列）')
  assert.equal(fans[0]?.new_fans_cnt, 9)
  assert.throws(() => parseDashboardMetrics(fx('dashboard.session_code_8.sample.json')), SessionInvalidError)
})

test('mergeDashboardRows：同日浅合并主表优先、按日升序（snake 列）', () => {
  const merged = mergeDashboardRows([{ day: '2026-10-01', play_cnt: 10 }], [{ day: '2026-10-01', play_cnt: 999, new_fans_cnt: 3 }])
  assert.equal(merged[0]?.play_cnt, 10, '主表指标优先')
  assert.equal(merged[0]?.new_fans_cnt, 3)
  assert.deepEqual(mergeDashboardRows([{ day: '2026-10-02', play_cnt: 1 }], [{ day: '2026-10-01', net_fans_cnt: 2 }]).map(row => row.day), ['2026-10-01', '2026-10-02'])
})

test('parseFansSummary：真实六类键（device/interest 投影服务端键名）非空', () => {
  const summary = parseFansSummary(fx('fans_summary.sample.json'))
  assert.ok(summary, '真实结构必须产出六类')
  assert.deepEqual(Object.keys(summary).sort(), [
    'active_levels', 'active_time_range', 'age_distribution', 'city_distribution',
    'device_distribution', 'interest_distribution',
  ])
  assert.deepEqual(summary?.active_levels?.[0], { label: '低活', count: 11 })
  assert.deepEqual(summary?.device_distribution?.[0], { label: '占品牌甲', count: 26 }, 'device_brand_distribution → device_distribution')
  assert.deepEqual(summary?.interest_distribution?.[0], { label: '占兴趣甲', count: 17 }, 'fans_interest_distribution → interest_distribution')
  // 反例：旧臆造结构 data.*.list[].{name,value} 必须为 null。
  assert.equal(parseFansSummary({ data: { age_distribution: { list: [{ name: '24-30', value: 30 }] } } }), null)
  assert.equal(parseFansSummary({ active_levels: [{ label: '低活', count: -1 }] }), null, '唯一类 count<0 剔除后整体 null')
  const mixed = parseFansSummary({ active_levels: [{ label: '低活', count: 3 }], age_distribution: [{ label: '24-30', count: -1 }] })
  assert.equal(mixed?.active_levels?.length, 1)
  assert.equal(mixed?.age_distribution, null, 'count<0 行剔除，其余类不受影响')
})

test('buildWorkPayload：compare→mget→performance/summarize 三路合并；缺口 reason 不得混用', () => {
  const work = makeWork({ playCount: 1, title: 't', url: null, publishTime: null, cover: null })
  const compare = parseItemCompare({ status_code: 0, item: { metrics: { view_count: 100, avg_view_second: 3, completion_rate: 0.5 } } })
  const mget = parseItemMget({ items: [{ id: '7412345678901234001', metrics: { view_count: 90, avg_view_second: 2 } }] })
  const summarize = parseItemSummarize({ item_list: [{ aweme_id: '7412345678901234001', summarize_data: { play_finish_ratio: 0.6, new_fans_count: -3 } }] })
  const payload = buildWorkPayload(fullInputs({
    work,
    compare,
    mget,
    summarize,
    performance: null,
    source: null,
    portrait: null,
    search: null,
    progress: null,
    retention: null,
    bounce: null,
    hotword: null,
    metricsTrend: null,
    metricsTrendGap: 'request_failed',
  }))
  const gaps = payload.data_gap as Record<string, { reason: string }>
  assert.equal(payload.play_count, 100, 'compare 优先')
  assert.equal(gaps['play_count'], undefined, 'play_count 有值不记缺口')
  assert.equal(payload.completion_rate_pct, 50, 'completion 合并序 compare → summarize → mget')
  assert.equal(payload.fans_gain_count, null, '负吸粉记缺口不造值')
  assert.equal(payload.play_trend_daily, null)
  assert.equal(gaps['play_trend_daily']?.reason, 'request_failed')
  assert.equal(payload.title, 't')
  assert.equal(payload.url, null)
  assert.equal(gaps['title']?.reason, undefined, '非 null 字段不记缺口')
  assert.equal(gaps['url']?.reason, 'not_exposed')
  assert.equal(gaps['publish_time']?.reason, 'not_exposed')
  assert.equal(gaps['cover_url']?.reason, 'not_exposed')
  assert.equal(gaps['traffic_source']?.reason, 'not_exposed')
  assert.equal(gaps['search_keywords']?.reason, 'not_exposed')
  assert.equal(gaps['progress_analysis']?.reason, 'not_exposed')
  assert.equal(gaps['retention_trend']?.reason, 'not_exposed')
  assert.equal(gaps['audience']?.reason, 'not_exposed')
  // compare 非 null 时 engagement_rates 必为对象（字段可各自为 null）。
  assert.equal(gaps['engagement_rates'], undefined)
  assert.deepEqual(payload.engagement_rates, { like_rate: null, comment_rate: null, share_rate: null, favorite_rate: null })
  assert.deepEqual(payload.hotword, { source: 'tab', status: 'unavailable', words: [] })

  // 低播放：below_min_view 缺口语义（不得混成 not_exposed/request_failed）。
  const lowPlay = parseItemCompare({ status_code: 10001 })
  const gapPayload = buildWorkPayload(fullInputs({
    work, compare: lowPlay, performance: null, mget: new Map<string, MgetRow>(), summarize: new Map<string, SummarizeRow>(),
    metricsTrend: null, metricsTrendGap: null,
  }))
  const lowGaps = gapPayload.data_gap as Record<string, { reason: string }>
  assert.equal(gapPayload.play_count, 1, 'compare 缺失回退列表值')
  assert.equal(lowGaps['completion_rate_pct']?.reason, 'below_min_view')
  // play_count 缺口 reason 固定 not_exposed，即使 compare 是低播放（旧 parse.js 同口径）。
  const noListPlay = buildWorkPayload(fullInputs({
    work: makeWork({ playCount: null }), compare: lowPlay, performance: null,
    mget: new Map<string, MgetRow>(), summarize: new Map<string, SummarizeRow>(),
  }))
  assert.equal((noListPlay.data_gap as Record<string, { reason: string }>)['play_count']?.reason, 'not_exposed')

  // request_failed：拦截与兜底都未取到 compare（collector 标注）。
  const failedCompare = parseItemCompare(null)
  failedCompare.gapReason = 'request_failed'
  const failedPayload = buildWorkPayload(fullInputs({
    work, compare: failedCompare, performance: null,
    mget: new Map<string, MgetRow>(), summarize: new Map<string, SummarizeRow>(),
  }))
  const failedGaps = failedPayload.data_gap as Record<string, { reason: string }>
  assert.equal(failedGaps['avg_view_proportion_pct']?.reason, 'request_failed', 'compare 独有字段记 request_failed')
})

test('buildWorkPayload：progress/retention 三值语义（有值/no_data/not_exposed）', () => {
  const emptyProgress = buildWorkPayload(fullInputs({ progress: { dragBackward: [], dragForward: [], empty: true } }))
  assert.equal((emptyProgress.data_gap as Record<string, { reason: string }>)['progress_analysis']?.reason, 'no_data')
  assert.deepEqual(emptyProgress.progress_analysis, null)
  const emptyBounce = buildWorkPayload(fullInputs({ bounce: { current: [], similar: [], valleys: [], empty: true }, bounceGap: null }))
  assert.equal((emptyBounce.data_gap as Record<string, { reason: string }>)['retention_bounce']?.reason, 'no_data')
  const gapBounce = buildWorkPayload(fullInputs({ bounce: null, bounceGap: 'request_failed' }))
  assert.equal((gapBounce.data_gap as Record<string, { reason: string }>)['retention_bounce']?.reason, 'request_failed')
})

test('buildWorkPayload 契约键集（ingest_batch works[] 冻结 DTO，D9B 真机第二缺陷回归）', () => {
  // 服务端 DouyinWorkIngestItem 为 extra=forbid：多一个键整批拒绝（2026-11-22
  // 真机 run 774a2ae3：latest_collected_at/duration_s/flat 互动率/play_source/
  // 原始 progress 键致 21 条作品零入库）。此处锁定 payload 顶层与子块键集。
  const payload = buildWorkPayload(fullInputs())
  assert.deepEqual([...Object.keys(payload)].sort(), [
    'audience', 'avg_view_proportion_pct', 'avg_watch_duration_s', 'bounce_rate_2s_pct',
    'collect_count', 'comment_count', 'completion_rate_5s_pct', 'completion_rate_pct',
    'cover_click_rate_pct', 'cover_url', 'danmaku_count', 'data_gap', 'engagement_rates',
    'fans_gain_count', 'follower_play_ratio_pct', 'hotword', 'is_private', 'like_count',
    'play_count', 'play_trend_daily', 'progress_analysis', 'publish_time', 'retention_bounce',
    'retention_trend', 'search_keywords', 'share_count', 'title', 'traffic_source', 'url', 'work_id',
  ])
  assert.deepEqual(Object.keys(payload.engagement_rates ?? {}), ['like_rate', 'comment_rate', 'share_rate', 'favorite_rate'])
  assert.deepEqual(Object.keys(payload.progress_analysis ?? {}), ['drag_back_curve', 'drag_forward_curve'])
  for (const row of payload.traffic_source ?? []) {
    assert.deepEqual(Object.keys(row).sort(), ['share_pct', 'source_key', 'source_label'])
    assert.ok(row.share_pct >= 0 && row.share_pct <= 100, 'share_pct 服务端 0..100 非空')
  }
  for (const point of payload.play_trend_daily ?? []) {
    assert.deepEqual(Object.keys(point), ['day', 'play_count'])
  }
  for (const word of (payload.hotword as { words: { word: string; rank: number | null; raw_score: string | null }[] }).words) {
    assert.deepEqual(Object.keys(word).sort(), ['rank', 'raw_score', 'word'])
  }
  for (const curve of [payload.progress_analysis?.drag_back_curve, payload.progress_analysis?.drag_forward_curve]) {
    for (const point of curve ?? []) {
      assert.deepEqual(Object.keys(point), ['key', 'value'])
      assert.ok(point.value >= 0 && point.value <= 100, '曲线 value 服务端 0..100 非空')
    }
  }
  const audience = payload.audience as Record<string, unknown>
  assert.deepEqual(Object.keys(audience).sort(), ['age', 'city_level', 'gender', 'province'])
  assert.ok(Array.isArray(audience['gender']) && audience['gender'].length > 0, '真实 fixture 画像四块非空')
})

test('buildWorkPayload：全真实 fixture 合并产物（完播/5s/2s/时长/弹幕/吸粉非空）', () => {
  const payload = buildWorkPayload(fullInputs({
    performance: null,
    bounce: { current: [{ key: '00:01', value: 50 }], similar: [], valleys: [], empty: false },
  }))
  assert.equal(payload.completion_rate_pct, 3.09, 'compare 完播率')
  assert.equal(payload.completion_rate_5s_pct, 40.17)
  assert.equal(payload.bounce_rate_2s_pct, 31.73)
  assert.equal(payload.avg_watch_duration_s, 13.46)
  assert.equal(payload.danmaku_count, 7, 'mget 弹幕数')
  assert.equal(payload.fans_gain_count, 9, 'summarize 吸粉量')
  assert.equal(payload.data_gap, null, '全链路有值时无缺口')
})

test('留存/搜索词：越界点剔除、percent 原样夹 0..100 降序', () => {
  const trend = parseRealtimeTrend({ analysis_trend: { current: [{ key: '00:01', value: 0.5 }, { key: '00:02', value: 1.5 }], similar: [], valley_list: [{ start: 2, end: 1 }] } })
  assert.equal(trend?.current.length, 1, '越界（>1）点行级剔除')
  assert.deepEqual(trend?.valleys, [{ start: 1, end: 2 }], 'end<start 交换')
  const keywords = parseSearchKeywords({ show_from: [{ keyword: 'a', percent: 30 }, { keyword: 'b', percent: 90 }] })
  assert.equal(keywords?.[0]?.keyword, 'b')
})

test('留存原始契约（current_item/similar_author + 分组 valley_list）双形态解析（旧插件同口径）', () => {
  const trend = parseRealtimeTrend(fx('retention_play.sample.json'))
  assert.deepEqual(trend?.current, [{ key: '00:00', value: 100 }, { key: '00:01', value: 84.75 }, { key: '00:02', value: 73.53 }])
  assert.deepEqual(trend?.valleys, [{ start: 3, end: 8 }, { start: 20, end: 25 }])
  assert.equal(trend?.empty, false)
})

test('dedupeWorks：跨页去重保留首现顺序', () => {
  const make = (id: string): WorkItem => ({ workId: id, title: null, url: null, publishTime: null, playCount: null, likeCount: null, commentCount: null, collectCount: null, shareCount: null, danmakuCount: null, durationSeconds: null, cover: null, isPrivate: false })
  const kept = dedupeWorks([make('1'), make('2'), make('1'), make('3'), make('2')])
  assert.deepEqual(kept.map(work => work.workId), ['1', '2', '3'])
})

test('metrics_trend：升序取最近 7 个完成日（上海今天及以后丢弃）', () => {
  const points: unknown[] = []
  for (let i = 0; i < 10; i += 1) {
    points.push({ date_time: `2026-11-${String(10 + i).padStart(2, '0')} 00:00:00`, value: String(i * 100) })
  }
  const json = { status_code: 0, trend_map: { view_count: { '0': points } } }
  const trend = parseItemMetricsTrend(json, '2026-11-25')
  assert.equal(trend?.length, 7)
  assert.equal(trend?.[0]?.day, '2026-11-13')
  const fixture = parseItemMetricsTrend(fx('metrics_trend.sample.json'), '2026-11-23')
  assert.deepEqual(fixture?.map(point => point.day), ['2026-11-10', '2026-11-11', '2026-11-12'])
  assert.equal(fixture?.[0]?.playCount, 3000, '6 位小数字符串值取整')
})

test('resolveClientStatus：仅完整且成功=预期才 completed', () => {
  assert.equal(resolveClientStatus({ listComplete: true, expected: 10, succeeded: 10, failed: 0 }), 'completed')
  assert.equal(resolveClientStatus({ listComplete: false, expected: 10, succeeded: 10, failed: 0 }), 'partial')
  assert.equal(resolveClientStatus({ listComplete: true, expected: 10, succeeded: 0, failed: 10 }), 'failed')
  assert.equal(resolveClientStatus({ listComplete: true, expected: 10, succeeded: 5, failed: 5 }), 'partial')
})
