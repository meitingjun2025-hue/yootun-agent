/**
 * parse/collector 纯逻辑测试（node --test）：19 位 ID 引号预处理、无 -0、
 * 百分比定义域、列表五种不完整判定、publishSince 边界（前一秒不保留/恰为
 * cutoff 保留/缺失不入库）、buildWorkPayload 三路合并与缺口语义、大盘日合并、
 * resolveClientStatus、metrics_trend 最近 7 完成日。
 * 运行：`node --test tests/parse.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildWorkPayload, decidePagination, dedupeWorks, mergeDashboardRows,
  parseDashboardMetrics, parseItemCompare, parseItemMetricsTrend, parseItemMget, parseItemSummarize,
  parseJsonPreservingIds, parseRealtimeTrend, parseSearchKeywords, parseWorkListPage, pct, quoteLongNumbers,
  resolveClientStatus, round2, toInt, toNumber, SessionInvalidError, type WorkItem,
} from '../src/parse.ts'
import { filterWorksByPublishSince, WORK_PUBLISH_SINCE_ISO, WORK_PUBLISH_SINCE_REPORT, WORK_PUBLISH_SINCE_MS } from '../src/collector.ts'

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

test('toNumber/toInt/round2/pct：-0 收敛、定义域守卫不造值', () => {
  assert.equal(Object.is(toNumber(-0), 0), true)
  assert.equal(toNumber(''), null)
  assert.equal(toNumber(true), null)
  assert.equal(Object.is(toInt(-0.2), 0), true)
  assert.equal(round2(-1), null)
  assert.equal(pct(0.5), 50)
  assert.equal(pct(1.2), null, '百分比越界记缺口')
  assert.equal(pct(-0.1), null)
})

test('parseWorkListPage：status_code=8 抛会话失效（防空列表假成功）', () => {
  assert.throws(() => parseWorkListPage({ status_code: 8 }), SessionInvalidError)
  const page = parseWorkListPage({ status_code: 0, aweme_list: [{ aweme_id: '1', statistics: { play_count: 5 } }], has_more: false })
  assert.equal(page.works.length, 1)
  assert.equal(page.works[0]?.playCount, 5)
})

test('decidePagination：健康 has_more=false；四种不完整 reason', () => {
  const page = (hasMore: boolean, works: number, nextCursor: string): ReturnType<typeof parseWorkListPage> => ({ hasMore, works: Array.from({ length: works }, () => ({ workId: 'x' })), nextCursor, rawCount: works })
  assert.equal(decidePagination(page(false, 3, '9'), 1, 10, '0').reason, null)
  assert.equal(decidePagination(page(true, 0, '9'), 1, 10, '0').reason, 'empty_page_with_more')
  assert.equal(decidePagination(page(true, 3, '5'), 2, 10, '5').reason, 'cursor_not_advancing')
  assert.equal(decidePagination(page(true, 3, '9'), 10, 10, '5').reason, 'max_pages_reached')
  assert.equal(decidePagination(page(true, 3, '9'), 2, 10, '5').continue, true)
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

test('buildWorkPayload：compare→mget→performance 三路合并；缺口 reason 不得混成低播放', () => {
  const work: WorkItem = { workId: 'w1', title: 't', url: null, publishTime: null, playCount: 1, likeCount: 2, commentCount: 3, collectCount: 4, shareCount: 5, danmakuCount: 6, durationSeconds: 7, cover: null, isPrivate: false }
  const compare = parseItemCompare({ status_code: 0, data: { view_count: 100, avg_view_second: 3, completion_rate: 0.5 } })
  const mget = parseItemMget({ items: [{ item_id: 'w1', view_count: 90, avg_view_second: 2 }] })
  const summarize = parseItemSummarize({ item_list: [{ item_id: 'w1', play_finish_ratio: 0.6, new_fans_count: -3 }] })
  const payload = buildWorkPayload({
    work, performance: new Map(), compare, compareGap: null, source: null, portrait: null,
    search: null, progress: null, retention: null, retentionGap: null, bounce: null, bounceGap: null,
    mget, summarize, hotword: null, metricsTrend: null, metricsTrendGap: 'request_failed', observedAt: '2026-11-22T00:00:00Z',
  })
  assert.equal(payload.play_count, 100, 'compare 优先')
  assert.equal(payload.completion_rate_pct, 50, 'completion 合并序 compare → summarize → mget')
  assert.equal(payload.fans_gain_count, null, '负吸粉记缺口不造值')
  assert.equal(payload.play_trend_daily, null)
  assert.equal((payload.data_gap as Record<string, { reason: string }>)['play_trend_daily']?.reason, 'request_failed')
  // 低播放：below_min_view 缺口语义（不得混成 not_exposed/request_failed）。
  const lowPlay = parseItemCompare({ status_code: 10001 })
  const gapPayload = buildWorkPayload({
    work, performance: new Map(), compare: lowPlay, compareGap: lowPlay.gapReason, source: null, portrait: null,
    search: null, progress: null, retention: null, retentionGap: null, bounce: null, bounceGap: null,
    mget: new Map(), summarize: new Map(), hotword: null, metricsTrend: null, metricsTrendGap: null, observedAt: '2026-11-22T00:00:00Z',
  })
  // 列表值兜底的 play_count 不记缺口；compare 本应提供的完播率记 below_min_view。
  assert.equal(gapPayload.play_count, 1, 'compare 缺失回退列表值')
  assert.equal((gapPayload.data_gap as Record<string, { reason: string }>)['completion_rate_pct']?.reason, 'below_min_view')
})

test('mergeDashboardRows：同日浅合并主表优先、按日升序；parseDashboardMetrics 同日先现值', () => {
  const rows = parseDashboardMetrics({ metrics: [
    { english_metric_name: 'play_cnt', trends: [{ date: '20261101', value: 10 }, { date: '20261101', value: 99 }] },
    { english_metric_name: 'total_fans_cnt', trends: [{ date: '20261102', value: 5 }] },
    { english_metric_name: 'net_fans_cnt', trends: [{ date: '20261102', value: -2 }] },
  ] })
  assert.equal(rows[0]?.day, '2026-11-01')
  assert.equal(rows[0]?.play_count, 10, '同日同指标保留先出现值')
  assert.equal(rows[1]?.net_fans_count, -2, 'net_fans 允许负值')
  const merged = mergeDashboardRows([{ day: '2026-11-01', play_count: 10 }], [{ day: '2026-11-01', play_count: 999, new_fans_count: 3 }])
  assert.equal(merged[0]?.play_count, 10, '主表指标优先')
  assert.equal(merged[0]?.new_fans_count, 3)
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
})

test('resolveClientStatus：仅完整且成功=预期才 completed', () => {
  assert.equal(resolveClientStatus({ listComplete: true, expected: 10, succeeded: 10, failed: 0 }), 'completed')
  assert.equal(resolveClientStatus({ listComplete: false, expected: 10, succeeded: 10, failed: 0 }), 'partial')
  assert.equal(resolveClientStatus({ listComplete: true, expected: 10, succeeded: 0, failed: 10 }), 'failed')
  assert.equal(resolveClientStatus({ listComplete: true, expected: 10, succeeded: 5, failed: 5 }), 'partial')
})

test('留存/搜索词：越界点剔除、percent 原样夹 0..100 降序', () => {
  const trend = parseRealtimeTrend({ analysis_trend: { current: [{ key: '00:01', value: 0.5 }, { key: '00:02', value: 1.5 }], similar: [], valley_list: [{ start: 2, end: 1 }] } })
  assert.equal(trend?.current.length, 1, '越界（>1）点行级剔除')
  assert.deepEqual(trend?.valleys, [{ start: 1, end: 2 }], 'end<start 交换')
  const keywords = parseSearchKeywords({ show_from: [{ keyword: 'a', percent: 30 }, { keyword: 'b', percent: 90 }] })
  assert.equal(keywords?.[0]?.keyword, 'b')
})

test('留存原始契约（current_item/similar_author + 分组 valley_list）双形态解析（旧插件同口径）', () => {
  // 抖音实测原始响应：曲线键为 current_item / similar_author，值为 0..1；
  // valley_list 是按 1/2/3 分组的对象，start/end 为字符串秒。
  const trend = parseRealtimeTrend({
    analysis_trend: {
      current_item: [{ key: '00:00', value: 1 }, { key: '00:10', value: 0.46 }],
      similar_author: [{ key: '00:00', value: 0.8 }],
    },
    valley_list: { 1: [{ start: '2', end: '4' }], 2: [{ start: '12', end: '15' }] },
  })
  assert.deepEqual(trend?.current, [{ key: '00:00', value: 100 }, { key: '00:10', value: 46 }])
  assert.deepEqual(trend?.similar, [{ key: '00:00', value: 80 }])
  assert.deepEqual(trend?.valleys, [{ start: 2, end: 4 }, { start: 12, end: 15 }])
  assert.equal(trend?.empty, false)
})

test('dedupeWorks：跨页去重保留首现顺序', () => {
  const make = (id: string): WorkItem => ({ workId: id, title: null, url: null, publishTime: null, playCount: null, likeCount: null, commentCount: null, collectCount: null, shareCount: null, danmakuCount: null, durationSeconds: null, cover: null, isPrivate: false })
  const kept = dedupeWorks([make('1'), make('2'), make('1'), make('3'), make('2')])
  assert.deepEqual(kept.map(work => work.workId), ['1', '2', '3'])
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

  /** 全量输入构造器（work + 各子块最小真实形状）。 */
  function fullInputs(): Parameters<typeof buildWorkPayload>[0] {
    const work: WorkItem = {
      workId: '7412345678901234567', title: '标题', url: 'https://www.douyin.com/video/1', publishTime: '2026-11-01T00:00:00.000Z',
      playCount: 10, likeCount: 1, commentCount: 2, collectCount: 3, shareCount: 4, danmakuCount: 5,
      durationSeconds: 12.3, cover: 'https://p.douyinpic.com/x.webp', isPrivate: false,
    }
    const performance = new Map([[work.workId, { play_count: 11, avg_watch_duration_s: 1, completion_rate_5s_pct: 50, bounce_rate_2s_pct: 20 }]])
    const mget = new Map([[work.workId, { play_count: 11, danmaku_count: 5, completion_rate_pct: 33 }]])
    const summarize = new Map([[work.workId, { fansGainCount: 2, completionRate: 33 }]])
    return {
      work,
      performance,
      compare: {
        statusCode: 0, gapReason: null,
        metrics: {
          playCount: 12, avgWatchDuration: 2, completionRate: 34, completionRate5s: 51, bounceRate2s: 21,
          avgViewProportion: 44, coverClickRate: 5, followerPlayRatio: 6,
          likeRate: 1, commentRate: 2, shareRate: 3, favoriteRate: 4,
        },
        statusMessage: null,
      },
      compareGap: null,
      source: [{ source_key: 'feed', source_label: '推荐', share_pct: 60 }, { source_key: 'search', source_label: null, share_pct: 40 }],
      portrait: { gender: [], age: [], province: [], cityLevel: [] },
      search: [{ keyword: '词', percent: 50 }],
      progress: { dragBackward: [{ key: '1', value: 10 }], dragForward: [{ key: '2', value: 20 }], empty: false },
      retention: { current: [{ key: '1', value: 1 }], similar: [], valleys: [], empty: false },
      retentionGap: null,
      bounce: { current: [], similar: [], valleys: [], empty: true },
      bounceGap: null,
      mget,
      summarize,
      hotword: { status: 'ok', statusCode: 0, words: [{ word: '热词', rank: 1, raw_score: null }] },
      metricsTrend: [{ day: '2026-11-20', playCount: 5 }, { day: '2026-11-21', playCount: 6 }],
      metricsTrendGap: null,
      observedAt: '2026-11-22T00:00:00.000Z',
    }
  }
})
