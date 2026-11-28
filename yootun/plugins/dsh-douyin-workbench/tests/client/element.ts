/**
 * RTL 查询结果的首元素：`getAllByRole`/`findAllByRole` 返回数组，下标取值在
 * `noUncheckedIndexedAccess` 下可能为 `undefined`；测试取首元素即断言至少一条
 * 命中，取不到视为装配与渲染不一致并抛错。
 * @module
 */

/**
 * Read the first element of a query result.
 * @param items - the array returned by a `*AllByRole` query.
 * @returns the first match.
 */
export function firstOf<T>(items: readonly T[]): T {
  const first = items[0]
  if (first === undefined) throw new Error('查询结果为空，测试装配与页面渲染不一致')
  return first
}
