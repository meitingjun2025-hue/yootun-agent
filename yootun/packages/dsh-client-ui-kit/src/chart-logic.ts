/**
 * 图表纯逻辑：高度钳制、tooltip 放置与翻转。无 React、无 DOM 依赖，
 * 便于 node/vitest 双层测试。
 * @module
 */

/** The spec band for chart plot heights (§三 图表卡 180–320px). */
export const CHART_HEIGHT_MIN_PX = 180
export const CHART_HEIGHT_MAX_PX = 320

/**
 * Clamp a caller-provided plot height into the spec band.
 * @param height - requested height in px; `undefined` uses the 240 default.
 * @returns the clamped height.
 */
export function clampChartHeight(height: number | undefined): number {
  if (height === undefined || !Number.isFinite(height)) return 240
  return Math.min(CHART_HEIGHT_MAX_PX, Math.max(CHART_HEIGHT_MIN_PX, Math.round(height)))
}

/** Geometry inputs for one tooltip placement decision. */
export interface TooltipGeometry {
  /** Anchor point in container coordinates. */
  point: { x: number; y: number }
  /** Tooltip bubble size. */
  bubble: { width: number; height: number }
  /** Visible container rect the bubble must stay within. */
  container: { width: number; height: number }
  /** Cursor-to-bubble gap in px (default 12). */
  gap?: number
}

/** One resolved tooltip position plus the side it settled on. */
export interface TooltipPlacement {
  left: number
  top: number
  /** Which side of the anchor the bubble sits on after flipping. */
  side: 'left' | 'right'
}

/**
 * Place a chart tooltip near the anchor, flipping horizontally when the
 * default side would overflow the container, and clamping vertically. The
 * vertical clamp keeps the bubble inside the container but does not pick an
 * above/below candidate — a mark at the very top edge may be overlapped; the
 * caller should keep plots tall enough for their bubble sizes (§5.3).
 * @param geometry - anchor, bubble, and container geometry.
 * @returns the bubble position and settled side.
 */
export function placeTooltip(geometry: TooltipGeometry): TooltipPlacement {
  const gap = geometry.gap ?? 12
  const preferRight = geometry.point.x + gap + geometry.bubble.width <= geometry.container.width
  const side = preferRight ? 'right' : 'left'
  const rawLeft = side === 'right' ? geometry.point.x + gap : geometry.point.x - gap - geometry.bubble.width
  const left = Math.max(0, Math.min(rawLeft, Math.max(0, geometry.container.width - geometry.bubble.width)))
  const rawTop = geometry.point.y - geometry.bubble.height / 2
  const top = Math.max(0, Math.min(rawTop, Math.max(0, geometry.container.height - geometry.bubble.height)))
  return { left: Math.round(left), top: Math.round(top), side }
}
