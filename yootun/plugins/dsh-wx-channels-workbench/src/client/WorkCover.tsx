/**
 * 作品封面：img 铺满 + 右下角时长角标；加载失败 / 缺失 / 非 http(s) 源 →
 * 占位块（居中「封面」小字），不隐藏所在行。表格缩略与详情大图复用同一结构。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { formatSeconds, type Translate } from './format.ts'
import css from './workbench.module.css'

export interface WorkCoverProps {
  t: Translate
  coverUrl: string | null
  durationS: number | null
  size?: 'small' | 'large'
}

/** 作品封面组件（key 绑定 URL 由调用方保证：URL 变化时强制重挂载重试）。 */
export function WorkCover(props: WorkCoverProps): ReactNode {
  const t = props.t
  const [failed, setFailed] = useState(false)
  const safeSrc = props.coverUrl
  const showImg = safeSrc !== null && !failed
  return (
    <span className={props.size === 'large' ? `${css.cover} ${css.coverLarge}` : css.cover}>
      {showImg
        ? (
            <img
              className={css.coverImg}
              src={safeSrc}
              alt=''
              loading='lazy'
              referrerPolicy='no-referrer'
              onError={() => { setFailed(true) }}
            />
          )
        : <span aria-hidden='true'>{t('cover.fallback')}</span>}
      {props.durationS !== null && showImg && (
        <span className={css.coverDuration}>{formatSeconds(props.durationS, t)}</span>
      )}
    </span>
  )
}
