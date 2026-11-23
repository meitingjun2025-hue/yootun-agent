/**
 * collector 假页面注入测试（node --test）：fixture 键名与 docker-helm docs/0909|1015
 * 真机脱敏样例逐字段一致。覆盖：批量分析读 items[] 且 status_code=8 抛会话失效、
 * 列表阶段失效保留已采集页范围内作品、资料阶段失效保留全部范围内作品且
 * listComplete 取真实值、javascript: 危险协议头像被拒。
 * 运行：`node --test tests/collector.test.ts`。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  collectAccountProfile, collectAccountWorksOn, collectItemAnalysis,
  type CollectorFetchArg, type CollectorFetchOutcome, type DouyinCollectPage,
} from '../src/collector.ts'
import { SessionInvalidError } from '../src/parse.ts'

const FIXTURES = join(new URL('..', import.meta.url).pathname, 'tests', 'fixtures')
const fx = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

/** 按 URL 路由到 fixture 的假采集页面（结构化满足 DouyinCollectPage，无断言）。 */
function makePage(route: (url: string) => CollectorFetchOutcome | undefined): DouyinCollectPage {
  return {
    goto: async () => null,
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    click: async () => undefined,
    $: async () => null,
    $$: async () => [],
    on: () => undefined,
    off: () => undefined,
    evaluate: async (_script, arg: CollectorFetchArg) => route(arg.url) ?? { status: 404, text: '' },
    evaluateDom: async () => false,
  }
}

const send = (body: unknown): CollectorFetchOutcome => ({ status: 200, text: JSON.stringify(body) })
const WORK_LIST_URL = '/janus/douyin/creator/pc/work_list'

test('collectItemAnalysis：读 items[]（真实结构）且 status_code=8 抛会话失效', async () => {
  const page = makePage(url => {
    if (url.includes('/item_analysis/involved_vertical')) return send({ status_code: 0, primary_verticals: ['汽车'] })
    if (url.includes('/item_analysis/item_performance')) return send(fx('item_analysis.sample.json'))
    if (url.includes('/item_analysis/overview')) return send({ status_code: 0, overview: { play_cnt: 1 } })
    return undefined
  })
  const bundle = await collectItemAnalysis(page)
  const row = bundle.performance.get('7412345678901234001')
  assert.ok(row, '真实键 items[].item_id 命中')
  assert.equal(row?.play_count, 10000)
  assert.equal(row?.avg_watch_duration_s, 13.46)
  assert.equal(row?.completion_rate_5s_pct, 40.17)
  assert.equal(row?.bounce_rate_2s_pct, 31.73)
  assert.deepEqual(bundle.primaryVerticals, ['汽车'])

  const expired = makePage(url => {
    if (url.includes('/item_analysis/involved_vertical')) return send({ status_code: 0, primary_verticals: [] })
    if (url.includes('/item_analysis/item_performance')) return send({ status_code: 8 })
    if (url.includes('/item_analysis/overview')) return send({ status_code: 0, overview: {} })
    return undefined
  })
  await assert.rejects(() => collectItemAnalysis(expired), SessionInvalidError)
})

test('collectAccountWorksOn 列表阶段失效：已采集页范围内作品以列表字段入库保留', async () => {
  const status8 = fx('work_list.status_code_8.sample.json')
  const page1 = fx('work_list.page1.sample.json') as { aweme_list: unknown[] }
  // 第三件作品发布于 2023-11（范围外）：部分成果必须把它过滤掉。
  const outOfScope = { ...(page1.aweme_list[0] as Record<string, unknown>), aweme_id: '7412345678901234003', create_time: 1699000000 }
  const page = makePage(url => {
    if (url.includes(WORK_LIST_URL)) {
      return url.includes('max_cursor=0') ? send({ ...page1, aweme_list: [...page1.aweme_list, outOfScope] }) : send(status8)
    }
    return undefined
  })
  const err = await collectAccountWorksOn(page, { workListOptions: { intervalMs: 0 } }).then(
    () => null,
    (error: unknown) => error,
  )
  assert.ok(err instanceof SessionInvalidError, '列表阶段 status_code=8 必须抛 SessionInvalidError')
  const partial = err.partialCollected
  assert.ok(partial, '部分成果必须挂在错误上')
  assert.equal(partial.listComplete, false)
  assert.equal(partial.publishSince, '2026-05-31T16:00:00Z')
  assert.equal(partial.expectedWorkCount, 2, 'expectedWorkCount = 范围过滤后数量（范围外不计）')
  assert.equal(partial.works.length, 2, '前几页范围内作品保留（2023 年作品被过滤）')
  const first = partial.works[0] as Record<string, unknown>
  assert.equal(first['work_id'], '7412345678901234001')
  assert.equal(first['title'], '占位标题甲 #占位话题')
  assert.equal(first['play_count'], 12000, '列表统计入库')
  assert.equal(first['completion_rate_pct'], null, '详情字段全 null')
  assert.ok(first['data_gap'] !== null && first['data_gap'] !== undefined, '详情缺口逐字段记录')
})

test('collectAccountWorksOn 资料阶段失效：全部范围内作品入库且 listComplete 取真实值', async () => {
  const status8 = fx('work_list.status_code_8.sample.json')
  const lastPage = fx('work_list.lastpage.sample.json')
  const page1 = fx('work_list.page1.sample.json')
  const page = makePage(url => {
    if (url.includes(WORK_LIST_URL)) return url.includes('max_cursor=0') ? send(page1) : send(lastPage)
    if (url.includes('/web/api/media/user/info')) return send({ status_code: 8 })
    return undefined
  })
  const err = await collectAccountWorksOn(page, { workListOptions: { intervalMs: 0 } }).then(
    () => null,
    (error: unknown) => error,
  )
  assert.ok(err instanceof SessionInvalidError)
  const partial = err.partialCollected
  assert.ok(partial, '资料阶段失效必须保留全部范围内作品')
  assert.equal(partial.works.length, 3, '两页共 3 件范围内作品全部入库')
  assert.equal(partial.expectedWorkCount, 3)
  assert.equal(partial.listComplete, true, '列表本会健康完成：listComplete 取当前真实值，不写死 false')
})

test('collectAccountProfile：javascript: 危险协议头像必须被拒绝为 null', async () => {
  const safe = makePage(() => send({
    status_code: 0,
    user: {
      sec_uid: 'MS4wLjABAAAA-test-account',
      nickname: '占位昵称',
      avatar_uri: 'javascript:alert(1)',
      follower_count: 1234,
    },
  }))
  const profile = await collectAccountProfile(safe)
  assert.equal(profile?.accountId, 'MS4wLjABAAAA-test-account')
  assert.equal(profile?.avatar, null, 'javascript: 协议头像 → null')
  assert.equal(profile?.nickname, '占位昵称')
  assert.equal(profile?.fanCount, 1234)
  const gallery = makePage(() => send({
    status_code: 0,
    user: { sec_uid: 'u1', avatar_uri: { uri: 'tos-cn-i-avt-001/example', url_list: ['https://example.invalid/avatar.jpeg'] } },
  }))
  const galleryProfile = await collectAccountProfile(gallery)
  assert.equal(galleryProfile?.avatar, 'https://example.invalid/avatar.jpeg', '图集对象取第一个合法 URL')
})
