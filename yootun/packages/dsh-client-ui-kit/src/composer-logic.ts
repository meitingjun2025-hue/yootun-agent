/**
 * AssistantDock 纯逻辑：composer 键位裁决与消息流贴底判定。无 React 依赖。
 * @module
 */

/** One Enter-key adjudication for the dock composer. */
export type ComposerKeyAction =
  | { kind: 'send' }
  | { kind: 'newline' }
  | { kind: 'none' }

/**
 * Adjudicate a composer keydown: Enter sends, Shift+Enter makes a newline,
 * and IME composition (including the closing Enter) is always guarded.
 * @param input.key - the keyboard event's key.
 * @param input.shiftKey - whether Shift was held.
 * @param input.compositionGuarded - whether `observeComposition().guards()` returned true.
 * @param input.canSend - whether sending is currently possible.
 * @returns the action the composer should take.
 */
export function composerKeyAction(input: {
  key: string
  shiftKey: boolean
  compositionGuarded: boolean
  canSend: boolean
}): ComposerKeyAction {
  if (input.compositionGuarded) return { kind: 'none' }
  if (input.key === 'Enter') {
    if (input.shiftKey) return { kind: 'newline' }
    return input.canSend ? { kind: 'send' } : { kind: 'none' }
  }
  return { kind: 'none' }
}

/**
 * Why the send button is disabled, in stable precedence order.
 * @param input.busy - a request is in flight.
 * @param input.modelAvailable - the model is configured and reachable.
 * @param input.unauthorized - activation gate failed.
 * @param input.empty - the draft is empty or whitespace.
 * @returns the disabled reason key suffix, or `undefined` when sending is possible.
 */
export function sendDisabledReason(input: {
  busy: boolean
  modelAvailable: boolean
  unauthorized: boolean
  empty: boolean
}): 'busy' | 'model' | 'unauthorized' | 'empty' | undefined {
  if (input.busy) return 'busy'
  if (input.unauthorized) return 'unauthorized'
  if (!input.modelAvailable) return 'model'
  if (input.empty) return 'empty'
  return undefined
}

/**
 * Whether a message stream should stick to the bottom after new content:
 * the user must already be near the bottom (they scrolled away → no pull-back).
 * @param scroller.scrollTop - current scroll offset.
 * @param scroller.scrollHeight - full content height.
 * @param scroller.clientHeight - visible height.
 * @param thresholdPx - distance from the bottom that still counts as "near" (default 24).
 * @returns whether to auto-scroll to the bottom.
 */
export function shouldStickToBottom(
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx = 24,
): boolean {
  if (scroller.scrollHeight <= scroller.clientHeight) return true
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= thresholdPx
}
