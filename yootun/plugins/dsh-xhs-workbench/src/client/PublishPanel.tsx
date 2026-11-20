/**
 * 发布面板（12 册 §3.3；旧 client.js PublishPanel 重译，发布降级版）：结果区
 * 下方按所选账号打开创作者中心发布页（有头 Chrome、浏览器保持打开；内容由
 * 用户手动粘贴/上传/发布）。进度/结果 2s 轮询 publish.status，失败一律映射
 * 受控文案（不暴露内部错误码）。
 * @module
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { hostAction } from './api.ts'
import { reasonText, type Translate } from './format.ts'
import css from './workbench.module.css'

const PUBLISH_POLL_INTERVAL_MS = 2000

/** publish.start/status 的 publish 投影。 */
interface PublishRunState {
  publishId: string
  accountId: string
  publishStatus: string
  step: string
  error: string | null
}

/** publish.status 的 step → 文案键（旧 PUBLISH_STEP_KEYS 同表）。 */
const PUBLISH_STEP_KEYS: Readonly<Record<string, Parameters<Translate>[0]>> = {
  prepare: 'publish.stepPrepare',
  open: 'publish.stepOpen',
  done: 'publish.stepDone',
}

export interface PublishPanelProps {
  /** 会话有效（sessionStatus === 'ok'）的账号行。 */
  accounts: Array<{ accountId: string; nickname: string | null }>
  /** 当前素材 tab（决定直达图文/视频发布页）。 */
  target: 'image' | 'video'
  t: Translate
}

/**
 * Render the publish panel below the generated copy.
 * @param props - eligible accounts + current target tab + translator.
 * @returns the panel node.
 */
export function PublishPanel(props: PublishPanelProps): ReactNode {
  const { t } = props
  const [publish, setPublish] = useState<PublishRunState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [publishAccount, setPublishAccount] = useState<string | null>(null)
  const effectiveAccount = publishAccount ?? props.accounts[0]?.accountId ?? null
  const running = publish?.publishStatus === 'running'
  const stepKey = publish?.step !== undefined ? PUBLISH_STEP_KEYS[publish.step] : undefined

  // 发布进度轮询：running 时 2s 一次 publish.status；终态由依赖变化自动停止。
  useEffect(() => {
    if (publish === undefined || publish === null || publish.publishStatus !== 'running') return undefined
    const timer = window.setInterval(async () => {
      try {
        const result = await hostAction('publish.status', { publishId: publish.publishId })
        const next = result?.publish
        if (next !== null && typeof next === 'object') setPublish(next as PublishRunState)
      } catch {
        // 单次轮询失败不打断：发布 run 在宿主后台继续，下个周期继续查询。
      }
    }, PUBLISH_POLL_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [publish?.publishId, publish?.publishStatus])

  const onStart = async (): Promise<void> => {
    if (running || effectiveAccount === null) return
    setNotice(null)
    try {
      const result = await hostAction('publish.start', {
        accountId: effectiveAccount,
        target: props.target,
        idempotencyKey: globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `xhs-pub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      })
      const next = result?.publish
      if (next !== null && typeof next === 'object') setPublish(next as PublishRunState)
    } catch (error) {
      // 失败映射受控文案：终态失败优先按稳定错误码映射具体原因。
      setNotice(error instanceof Error ? reasonText(error.message, t) : t('publish.failed'))
    }
  }

  const available = props.accounts
  return (
    <section className={css.publishPanel} aria-label={t('publish.panel')}>
      <h3 className={css.hbPanelTitle}>{t('publish.panel')}</h3>
      {available.length === 0
        ? <p className={css.hint}>{t('publish.noAccount')}</p>
        : (
            <label className={css.publishRow}>
              <span>{t('publish.accountLabel')}</span>
              <select
                value={effectiveAccount ?? ''}
                disabled={running}
                aria-label={t('publish.accountLabel')}
                onChange={event => { setPublishAccount(event.target.value) }}
              >
                {available.map(account => (
                  <option key={account.accountId} value={account.accountId}>{account.nickname ?? account.accountId}</option>
                ))}
              </select>
            </label>
          )}
      <p className={css.hint}>{t('publish.hint')}</p>
      {running && (
        <p className={css.publishProgress} role='status'>
          <StateDot state='ongoing' />
          {t('publish.publishing')}{stepKey !== undefined ? ` · ${t(stepKey)}` : ''}
        </p>
      )}
      {publish?.publishStatus === 'completed' && (
        <p className={css.hint} role='status'>{t('publish.done')}</p>
      )}
      {(publish?.publishStatus === 'failed' || notice !== null) && (
        <p className={css.errorText} role='alert'>
          {notice ?? reasonText(publish?.error ?? '', t)}
        </p>
      )}
      {available.length > 0 && (
        <Button variant='primary' disabled={running} onClick={() => { void onStart() }}>
          {running ? t('publish.publishing') : t('publish.start')}
        </Button>
      )}
    </section>
  )
}
