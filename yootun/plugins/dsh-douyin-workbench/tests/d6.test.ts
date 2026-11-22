/**
 * D6 爆款拆解行为测试（node --test）：10 个 action 成功/稳定错误路径、工具名
 * 与 ACTION_TOOL_MAP 一致、参数投影不自造字段、AbortSignal 透传、detail 三源
 * 组合与辅助源降级、export base64/字节数/文件名/大小校验、异步状态投影、写
 * 失败不自动重试。运行：`node --test tests/d6.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTION_TOOL_MAP, buildRouteHandlers, createDouyinHostDeps } from '../src/index.ts'
import { disposeHostTasks } from '../src/lifecycle.ts'
import { createFakeWorkbench, tempRoot, type FakeWorkbenchCall } from './fakes.ts'

async function d6Deps(script: { outcomes?: Array<{ structuredContent?: unknown; throwCode?: string }> } = {}): Promise<{
  handlers: Record<string, import('../src/route.ts').ActionHandler>
  calls: FakeWorkbenchCall[]
  cleanup: () => Promise<void>
}> {
  const { root, cleanup } = await tempRoot()
  const fake = createFakeWorkbench(script)
  const deps = createDouyinHostDeps({ root, workbenchFace: fake.face, logger: { warn: () => undefined } })
  return { handlers: buildRouteHandlers(deps), calls: fake.calls, cleanup }
}

const uuid = 'a'.repeat(32)
const wfKey = `douyin:vv_workflow:${uuid}`

test('工具名与 ACTION_TOOL_MAP 精确一致（D6 10 action）', () => {
  const d6Actions: [string, string][] = [
    ['breakdown.rewriteRules', 'workbench_viral_rewrite_rules_list'],
    ['breakdown.archiveStart', 'workbench_viral_archive_submit'],
    ['breakdown.archiveStatus', 'workbench_viral_async_submit_get'],
    ['breakdown.downloadStart', 'workbench_viral_douyin_download_url_start'],
    ['breakdown.downloadStatus', 'workbench_viral_douyin_download_url_get'],
    ['breakdown.workflowStart', 'workbench_viral_workflow_start'],
    ['breakdown.workflowStatus', 'workbench_viral_workflow_get'],
    ['breakdown.detail', 'workbench_viral_storyboards_list'],
    ['breakdown.export', 'workbench_viral_storyboard_export'],
    ['breakdown.history', 'workbench_viral_workflow_get'],
  ]
  for (const [action, tool] of d6Actions) {
    const binding = ACTION_TOOL_MAP[action]
    assert.equal(binding?.kind, 'remote', `${action} 是远端绑定`)
    if (binding?.kind === 'remote') {
      assert.equal(binding.domain, 'viral', `${action} 属 viral 分组`)
      assert.ok(binding.tools.includes(tool), `${action} 绑定 ${tool}`)
    }
  }
})

test('rewriteRules：items 投影为 rules + total；prompt 不在投影内', async () => {
  const { handlers, calls, cleanup } = await d6Deps({
    outcomes: [{ structuredContent: { items: [{ rewriteRuleId: 'r1', name: '汽车口播', description: '说明', prompt: 'secret' }] } }],
  })
  try {
    const payload = await handlers['breakdown.rewriteRules']({})
    assert.equal(payload.status, 'ready')
    assert.equal(payload.total, 1)
    assert.deepEqual(payload.rules, [{ rewriteRuleId: 'r1', name: '汽车口播', description: '说明', prompt: 'secret' }])
    assert.equal(calls[0]?.name, 'workbench_viral_rewrite_rules_list')
    assert.deepEqual(calls[0]?.args, {})
  } finally {
    await cleanup()
  }
})

test('archiveStart：shareUrl→douyinVideoUrl + confirm + 幂等键；回执 archive 投影', async () => {
  const { handlers, calls, cleanup } = await d6Deps({
    outcomes: [{ structuredContent: { runId: 'run-1', runStatus: 'waiting', nextAction: 'poll_status' } }],
  })
  try {
    const payload = await handlers['breakdown.archiveStart']({ shareUrl: 'https://v.douyin.com/x/', idempotencyKey: `douyin:vv_archive:${uuid}` })
    assert.equal(payload.status, 'ready')
    assert.deepEqual(payload.archive, { runId: 'run-1', runStatus: 'waiting', nextAction: 'poll_status' })
    assert.deepEqual(calls[0]?.args, {
      douyinVideoUrl: 'https://v.douyin.com/x/',
      confirm: true,
      idempotencyKey: `douyin:vv_archive:${uuid}`,
    })
  } finally {
    await cleanup()
  }
})

test('archiveStart：IDEMPOTENCY_OUTCOME_UNKNOWN 原样投影且不自动重发', async () => {
  const { handlers, calls, cleanup } = await d6Deps({ outcomes: [{ throwCode: 'IDEMPOTENCY_OUTCOME_UNKNOWN' }] })
  try {
    await assert.rejects(() => handlers['breakdown.archiveStart']({ shareUrl: 'https://v.douyin.com/x/', idempotencyKey: `douyin:vv_archive:${uuid}` }), (error: unknown) => {
      const envelope = (error as { payload?: { error?: { code?: string } } }).payload?.error?.code
      return envelope === 'IDEMPOTENCY_OUTCOME_UNKNOWN'
    })
    assert.equal(calls.length, 1, 'Host 不换键不重发；同键重试由用户决定')
  } finally {
    await cleanup()
  }
})

test('archiveStatus：runId 透传；pending/running/succeeded/failed 原样投影', async () => {
  for (const runStatus of ['pending', 'running', 'succeeded', 'failed', 'cancelled', 'partial']) {
    const { handlers, calls, cleanup } = await d6Deps({
      outcomes: [{ structuredContent: { runId: 'run-9', runStatus, nextAction: runStatus === 'succeeded' ? 'done' : 'poll_status' } }],
    })
    try {
      const payload = await handlers['breakdown.archiveStatus']({ runId: 'run-9' })
      assert.equal((payload.archive as { runStatus: string }).runStatus, runStatus)
      assert.deepEqual(calls[0]?.args, { runId: 'run-9' })
    } finally {
      await cleanup()
    }
  }
})

test('archiveStatus：ASYNC_RUN_NOT_FOUND 稳定错误路径', async () => {
  const { handlers, cleanup } = await d6Deps({ outcomes: [{ throwCode: 'ASYNC_RUN_NOT_FOUND' }] })
  try {
    await assert.rejects(() => handlers['breakdown.archiveStatus']({ runId: 'nope' }), (error: unknown) => {
      const envelope = (error as { payload?: { error?: { code?: string } } }).payload?.error?.code
      return envelope === 'ASYNC_RUN_NOT_FOUND'
    })
  } finally {
    await cleanup()
  }
})

test('downloadStart/downloadStatus：参数与回执投影；failed errorCode 原样透传', async () => {
  const { handlers, calls, cleanup } = await d6Deps({
    outcomes: [
      { structuredContent: { jobId: 'job-1', status: 'pending' } },
      { structuredContent: { jobId: 'job-1', status: 'ready', downloadUrl: 'https://tos/x.mp4' } },
    ],
  })
  try {
    const started = await handlers['breakdown.downloadStart']({ shareUrl: 'https://v.douyin.com/y/', idempotencyKey: `douyin:vv_download:${uuid}` })
    assert.deepEqual(started.download, { jobId: 'job-1', status: 'pending' })
    assert.deepEqual(calls[0]?.args, { douyinVideoUrl: 'https://v.douyin.com/y/', idempotencyKey: `douyin:vv_download:${uuid}` })
    const done = await handlers['breakdown.downloadStatus']({ jobId: 'job-1' })
    assert.deepEqual(done.download, { jobId: 'job-1', status: 'ready', downloadUrl: 'https://tos/x.mp4' })
    assert.deepEqual(calls[1]?.args, { jobId: 'job-1' })
  } finally {
    await cleanup()
  }
  const failed = await d6Deps({ outcomes: [{ structuredContent: { jobId: 'job-2', status: 'failed', error: { code: 'DOUYIN_VIDEO_DOWNLOAD_FAILED' } } }] })
  try {
    const payload = await failed.handlers['breakdown.downloadStatus']({ jobId: 'job-2' })
    assert.equal((payload.download as { status: string }).status, 'failed')
  } finally {
    await failed.cleanup()
  }
})

test('workflowStart：candidateId + confirm + 幂等键；rewriteRuleId/force 仅显式携带', async () => {
  const { handlers, calls, cleanup } = await d6Deps({
    outcomes: [{ structuredContent: { workflowId: 'wf-1', candidateId: 'c1', status: 'queued' } }, { structuredContent: { workflowId: 'wf-2', candidateId: 'c1', status: 'queued' } }, { structuredContent: { workflowId: 'wf-3', candidateId: 'c1', status: 'queued' } }],
  })
  try {
    await handlers['breakdown.workflowStart']({ candidateId: 'c1', confirm: true, idempotencyKey: wfKey })
    assert.deepEqual(calls[0]?.args, { candidateId: 'c1', idempotencyKey: wfKey, confirm: true }, '缺省不带 rewriteRuleId/force')
    await handlers['breakdown.workflowStart']({ candidateId: 'c1', confirm: true, idempotencyKey: wfKey, rewriteRuleId: 'r1' })
    assert.deepEqual(calls[1]?.args, { candidateId: 'c1', idempotencyKey: wfKey, confirm: true, rewriteRuleId: 'r1' })
    await handlers['breakdown.workflowStart']({ candidateId: 'c1', confirm: true, idempotencyKey: wfKey, force: true })
    assert.deepEqual(calls[2]?.args, { candidateId: 'c1', idempotencyKey: wfKey, confirm: true, force: true })
  } finally {
    await cleanup()
  }
})

test('workflowStatus：workflowId 优先 / candidateId 回退 / limit 透传；蛇形归一 candidateId', async () => {
  const { handlers, calls, cleanup } = await d6Deps({
    outcomes: [
      { structuredContent: { items: [{ workflowId: 'wf-1', candidate_id: 'c1', status: 'running' }], total: 1 } },
      { structuredContent: { items: [{ candidate_id: 'c2', status: 'succeeded' }], total: 5 } },
    ],
  })
  try {
    const byId = await handlers['breakdown.workflowStatus']({ workflowId: 'wf-1', limit: 5 })
    assert.deepEqual(calls[0]?.args, { workflowId: 'wf-1', limit: 5 })
    assert.deepEqual(byId.workflows, [{ workflowId: 'wf-1', candidateId: 'c1', status: 'running' }])
    assert.equal(byId.total, 1)
    const byCandidate = await handlers['breakdown.workflowStatus']({ candidateId: 'c2' })
    assert.deepEqual(calls[1]?.args, { candidateId: 'c2' })
    assert.equal((byCandidate.workflows[0] as { candidateId: string }).candidateId, 'c2')
    assert.equal(byCandidate.total, 5)
  } finally {
    await cleanup()
  }
})

test('detail：三源组合（storyboards 主体 + analysis/candidate 辅助成功）', async () => {
  const { handlers, calls, cleanup } = await d6Deps({
    outcomes: [
      { structuredContent: { items: [{ input: { rewriteRuleId: 'r1' } }] } },
      { structuredContent: { status: 'succeeded', candidates: [{ products: { asr: { transcript: '全文' } } }] } },
      { structuredContent: { candidates: [{ candidateId: 'c1', playCount: 100 }] } },
    ],
  })
  try {
    const payload = await handlers['breakdown.detail']({ candidateId: 'c1' })
    assert.equal(payload.status, 'ready')
    assert.deepEqual(payload.storyboards, [{ input: { rewriteRuleId: 'r1' } }])
    assert.deepEqual(payload.analysis, { status: 'succeeded', candidates: [{ products: { asr: { transcript: '全文' } } }] })
    assert.deepEqual(payload.candidate, { candidateId: 'c1', playCount: 100 })
    assert.equal(payload.analysisError, null)
    assert.equal(payload.candidateError, null)
    assert.equal(calls[0]?.name, 'workbench_viral_storyboards_list')
    assert.deepEqual(calls[0]?.args, { candidateId: 'c1', limit: 20 })
    assert.deepEqual(calls[1]?.args, { candidateId: 'c1' })
    assert.deepEqual(calls[2]?.args, { candidateId: 'c1', limit: 1 })
  } finally {
    await cleanup()
  }
})

test('detail：storyboards 失败即整单失败；辅助源独立降级透出稳定码', async () => {
  const degraded = await d6Deps({
    outcomes: [
      { structuredContent: { items: [] } },
      { throwCode: 'CANDIDATE_NOT_FOUND' },
      { throwCode: 'PROVIDER_ERROR' },
    ],
  })
  try {
    const payload = await degraded.handlers['breakdown.detail']({ candidateId: 'c1' })
    assert.deepEqual(payload.storyboards, [])
    assert.equal(payload.analysis, null)
    assert.equal(payload.analysisError, 'CANDIDATE_NOT_FOUND')
    assert.equal(payload.candidate, null)
    assert.equal(payload.candidateError, 'PROVIDER_ERROR')
  } finally {
    await degraded.cleanup()
  }
  const fatal = await d6Deps({ outcomes: [{ throwCode: 'CANDIDATE_NOT_FOUND' }] })
  try {
    await assert.rejects(() => fatal.handlers['breakdown.detail']({ candidateId: 'c1' }), (error: unknown) => {
      return (error as { code?: unknown }).code === 'CANDIDATE_NOT_FOUND'
    }, 'storyboards 失败不显示假详情')
    assert.equal(fatal.calls.length, 1, '主体失败即短路，不再拉辅助源')
  } finally {
    await fatal.cleanup()
  }
})

test('export：camelCase 信封投影为下载字段；base64 与字节数自洽', async () => {
  const content = Buffer.from('xlsx-bytes').toString('base64')
  const { handlers, cleanup } = await d6Deps({
    outcomes: [{
      structuredContent: {
        candidateId: 'c1',
        fileName: 'douyin-storyboard-c1-20261122.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        contentBase64: content,
        sizeBytes: Buffer.byteLength('xlsx-bytes'),
      },
    }],
  })
  try {
    const payload = await handlers['breakdown.export']({ candidateId: 'c1' })
    assert.equal(payload.status, 'ready')
    assert.equal(payload.file_name, 'douyin-storyboard-c1-20261122.xlsx')
    assert.equal(payload.mime_type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    assert.equal(payload.content_base64, content)
    assert.equal(payload.content_bytes, 10)
  } finally {
    await cleanup()
  }
})

test('export：base64 与声明字节数不自洽 → export_failed', async () => {
  const { handlers, cleanup } = await d6Deps({
    outcomes: [{ structuredContent: { fileName: 'douyin-storyboard-c1.xlsx', contentBase64: 'AAAA', sizeBytes: 99 } }],
  })
  try {
    await assert.rejects(() => handlers['breakdown.export']({ candidateId: 'c1' }), (error: unknown) => {
      const code = (error as { code?: unknown }).code
      return code === 'export_failed'
    })
  } finally {
    await cleanup()
  }
})

test('export：文件名不合规回退强制前缀；CANDIDATE_NOT_FOUND/STORYBOARD_NOT_READY 原样透出', async () => {
  const fallback = await d6Deps({
    outcomes: [{ structuredContent: { fileName: 'evil/../name.txt', contentBase64: 'QUJD', sizeBytes: 3 } }],
  })
  try {
    const payload = await fallback.handlers['breakdown.export']({ candidateId: 'c1' })
    assert.equal(payload.file_name, 'douyin-storyboard-export.xlsx')
  } finally {
    await fallback.cleanup()
  }
  for (const code of ['CANDIDATE_NOT_FOUND', 'STORYBOARD_NOT_READY']) {
    const rejected = await d6Deps({ outcomes: [{ throwCode: code }] })
    try {
      await assert.rejects(() => rejected.handlers['breakdown.export']({ candidateId: 'c1' }), (error: unknown) => {
        return (error as { code?: unknown }).code === code
      })
    } finally {
      await rejected.cleanup()
    }
  }
})

test('export：内容超上限稳定报错 export_too_large', async () => {
  const bytes = 1_000_001
  const big = 'A'.repeat(Math.ceil(bytes / 3) * 4)
  const { handlers, cleanup } = await d6Deps({
    outcomes: [{ structuredContent: { fileName: 'douyin-storyboard-c1.xlsx', contentBase64: big, sizeBytes: bytes } }],
  })
  try {
    await assert.rejects(() => handlers['breakdown.export']({ candidateId: 'c1' }), (error: unknown) => {
      return (error as { code?: unknown }).code === 'export_too_large'
    })
  } finally {
    await cleanup()
  }
})

test('history：limit 默认 10；hasStoryboard 按 succeeded 保守判定', async () => {
  const { handlers, calls, cleanup } = await d6Deps({
    outcomes: [{ structuredContent: { items: [
      { workflowId: 'wf-1', candidate_id: 'c1', status: 'succeeded' },
      { workflowId: 'wf-2', candidate_id: 'c2', status: 'failed' },
      { workflowId: 'wf-3', candidate_id: 'c3', status: 'running' },
    ], total: 3 } }],
  })
  try {
    const payload = await handlers['breakdown.history']({})
    assert.deepEqual(calls[0]?.args, { limit: 10 })
    assert.deepEqual(payload.history, [
      { workflowId: 'wf-1', candidateId: 'c1', status: 'succeeded', hasStoryboard: true },
      { workflowId: 'wf-2', candidateId: 'c2', status: 'failed', hasStoryboard: false },
      { workflowId: 'wf-3', candidateId: 'c3', status: 'running', hasStoryboard: false },
    ])
    assert.equal(payload.total, 3)
    const withLimit = await handlers['breakdown.history']({ limit: 200 })
    void withLimit
    assert.deepEqual(calls[1]?.args, { limit: 200 })
  } finally {
    await cleanup()
  }
})

test('D6 直接 Workbench 调用携带 action 级 AbortSignal（guard 注入、dispose 可取消）', async () => {
  const seen: Array<AbortSignal | undefined> = []
  const recordingFace = {
    async callTool(_caller: string, _domain: string, _name: string, _args: unknown, signal?: AbortSignal) {
      seen.push(signal)
      return { structuredContent: {}, content: null }
    },
  }
  const { root, cleanup } = await tempRoot()
  const deps = createDouyinHostDeps({ root, workbenchFace: recordingFace, logger: { warn: () => undefined } })
  const handlers = buildRouteHandlers(deps)
  try {
    await handlers['breakdown.archiveStatus']({ runId: 'run-1' })
    await handlers['breakdown.history']({})
    for (const [index, signal] of seen.entries()) {
      assert.ok(signal instanceof AbortSignal, `第 ${index} 次调用携带 action 级 signal`)
      assert.equal(signal.aborted, false, '在途期间 signal 未被误触发')
    }
  } finally {
    await cleanup()
  }
})

test('dispose 取消挂起的直接 action（在途 archiveStatus 被 abort，不伪成功）', async () => {
  const hangingFace = {
    async callTool(_caller: string, _domain: string, _name: string, _args: unknown, signal?: AbortSignal) {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new Error('aborted'))
          return
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  }
  const { root, cleanup } = await tempRoot()
  const deps = createDouyinHostDeps({ root, workbenchFace: hangingFace, logger: { warn: () => undefined } })
  const handlers = buildRouteHandlers(deps)
  const pending = handlers['breakdown.archiveStatus']({ runId: 'run-1' })
  const settled = pending.then(() => 'resolved', () => 'rejected')
  await new Promise(resolve => { setTimeout(resolve, 20) })
  await disposeHostTasks({ deps })
  assert.equal(await settled, 'rejected', 'dispose abort 在途直接 action，不得伪成功')
  await cleanup()
})
