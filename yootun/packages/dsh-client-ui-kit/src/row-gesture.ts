/**
 * 表格行打开详情的统一手势守卫：行级双击不处理落在行内交互元素上的事件，
 * 快速双击行内按钮不会连带打开详情（A5）。
 * @module
 */

/** 守卫读取的事件面（React 合成事件的只读投影）。 */
export interface GestureEventLike {
  target: EventTarget | null
}

/**
 * 事件目标是否落在行内交互元素（button / a / input / select / textarea）上。
 * @param event - 行级双击的合成事件。
 * @returns true 时行处理器直接返回，不触发行的打开动作。
 */
export function isOnInteractiveTarget(event: GestureEventLike): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  return target.closest('button, a, input, select, textarea') !== null
}
