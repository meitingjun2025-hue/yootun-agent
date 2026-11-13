/**
 * yootun 产品 bundle 的 node 半：本包的实质内容是 `cordis.patch.yml`
 * （由 `dsh.bundle.patch` manifest 字段声明、profile composer 解析），
 * 本模块不承载运行时 API，为 Loader 提供规范的包入口占位。
 * @module @yootun/dsh-bundle-yootun
 */

/** Bundle node half — this package contributes its patch layer only. */
export function apply(): void {}
