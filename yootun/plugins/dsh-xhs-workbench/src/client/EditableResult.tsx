/**
 * 单版可编辑结果卡（12 册 §3.3；旧 EditableResult 重译）：标题（≤20 计数）/
 * 正文（编辑-预览切换，MarkdownText 预览）/ 标签（chips 增删 ≤10）可编辑，
 * 封面文案/评论引导/图文分页只读；issues 渲染软性风险提示条。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { Input, MarkdownText, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { issueKeys, type Translate } from './format.ts'
import css from './workbench.module.css'
import type { TaskVersion } from './task-machine.ts'

const MAX_TITLE_CHARS = 20
const MAX_TAGS = 10

/** 单版编辑态（编辑即生效；保存编辑做确认反馈）。 */
export interface EditedCopy {
  taskId: string
  title: string
  body: string
  tags: string[]
  saved: boolean
}

export interface EditableResultProps {
  version: TaskVersion
  edited: EditedCopy
  onEditedChange: (next: EditedCopy) => void
  t: Translate
}

/**
 * Render the single editable result card.
 * @param props - result version + edited copy + translator.
 * @returns the card node.
 */
export function EditableResult(props: EditableResultProps): ReactNode {
  const { version, edited, onEditedChange, t } = props
  const [bodyMode, setBodyMode] = useState<'edit' | 'preview'>('edit')
  const [tagDraft, setTagDraft] = useState('')
  const issues = issueKeys(version.issues)
  const titleLength = [...edited.title].length

  const addTag = (): void => {
    // 允许带 # 输入（话题习惯），入列前剥离前缀，避免复制全文产出「##标签」。
    const tag = tagDraft.trim().replace(/^#+/u, '').trim().slice(0, 50)
    if (tag === '' || edited.tags.includes(tag) || edited.tags.length >= MAX_TAGS) return
    onEditedChange({ ...edited, tags: [...edited.tags, tag] })
    setTagDraft('')
  }

  const removeTag = (tag: string): void => {
    onEditedChange({ ...edited, tags: edited.tags.filter(item => item !== tag) })
  }

  return (
    <article className={css.resultCard}>
      <header className={css.resultHead}>
        <span className={css.resultBadge}>{version.version}</span>
        <span className={css.editableBadge}>{t('result.editableBadge')}</span>
      </header>
      {issues.length > 0 && (
        <div className={css.issuesBlock} role='status'>
          <p className={css.issuesTitle}>{t('result.issuesTitle')}</p>
          <ul>
            {issues.map(key => <li key={key}>{t(key)}</li>)}
          </ul>
        </div>
      )}
      <div className={css.fieldGrid}>
        <span className={css.fieldLabel}>{t('result.titleLabel')}</span>
        <div className={css.titleRow}>
          <Input
            type='text'
            value={edited.title}
            maxLength={MAX_TITLE_CHARS}
            aria-label={t('result.titleLabel')}
            onChange={event => { onEditedChange({ ...edited, title: event.target.value }) }}
          />
          <span className={css.titleCount}>{t('result.titleCount', { current: titleLength })}</span>
        </div>
      </div>
      <div className={css.fieldGrid}>
        {/* 编辑/预览切换在正文 label 行右侧（对齐旧版；官方 SegmentedControl）。 */}
        <div className={css.bodyHead}>
          <span className={css.fieldLabel}>{t('result.bodyLabel')}</span>
          <SegmentedControl
            id='xhs-body-mode'
            value={bodyMode}
            onChange={setBodyMode}
            options={[
              { value: 'edit', label: t('result.bodyModeEdit') },
              { value: 'preview', label: t('result.bodyModePreview') },
            ]}
            label={t('result.bodyLabel')}
          />
        </div>
        {bodyMode === 'edit'
          ? (
              <textarea
                className={css.bodyEditor}
                value={edited.body}
                aria-label={t('result.bodyLabel')}
                onChange={event => { onEditedChange({ ...edited, body: event.target.value }) }}
              />
            )
          : (
              <div className={css.bodyPreview}>
                <MarkdownText text={edited.body} labels={{ code: { copyLabel: t('action.copyAll'), copiedLabel: t('action.copiedAll') }, footnotes: '' }} />
              </div>
            )}
      </div>
      <div className={css.fieldGrid}>
        <span className={css.fieldLabel}>{t('result.tagsLabel')}</span>
        {edited.tags.length > 0 && (
          <div className={css.tagRow} aria-label={t('result.tagsLabel')}>
            {edited.tags.map(tag => (
              <span className={css.tagChip} key={tag}>
                {tag}
                <button
                  type='button'
                  className={css.tagRemove}
                  aria-label={`${t('result.tagRemove')}：${tag}`}
                  onClick={() => { removeTag(tag) }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <Input
          type='text'
          value={tagDraft}
          maxLength={50}
          placeholder={t('result.tagAddPlaceholder')}
          aria-label={t('result.tagsLabel')}
          disabled={edited.tags.length >= MAX_TAGS}
          onChange={event => { setTagDraft(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addTag()
            }
          }}
        />
      </div>
      {version.coverCopy !== '' && (
        <div className={css.extraLine}>
          <span className={css.extraLabel}>{t('result.coverLabel')}</span>
          <div className={css.extraBody}>
            <MarkdownText text={version.coverCopy} labels={{ code: { copyLabel: t('action.copyAll'), copiedLabel: t('action.copiedAll') }, footnotes: '' }} />
          </div>
        </div>
      )}
      {version.pages !== undefined && version.pages.length > 0 && (
        <div className={css.extraLine}>
          <span className={css.extraLabel}>{t('result.pagesLabel')}</span>
          <ol>
            {version.pages.map(page => (
              <li key={page.pageIndex}>
                <span className={css.extraLabel}>{page.pageIndex + 1}</span>
                <span className={css.extraBody}>{page.copy}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {version.leadGuide !== '' && (
        <div className={css.extraLine}>
          <span className={css.extraLabel}>{t('result.leadLabel')}</span>
          <div className={css.extraBody}>
            <MarkdownText text={version.leadGuide} labels={{ code: { copyLabel: t('action.copyAll'), copiedLabel: t('action.copiedAll') }, footnotes: '' }} />
          </div>
        </div>
      )}
    </article>
  )
}
