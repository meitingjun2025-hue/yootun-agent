/**
 * yootun 接入的 locale 词典：zh 为 key-set source of truth，en 跟随键集
 * （分册 05 第 4 节）。产品名与品牌眉标经构建环境内联（分册 06 的
 * onboarding 词条同款机制），官方构建链不注入时回退官方名。
 */

/** 产品名：构建环境注入的品牌名，官方构建回退官方产品名。 */
const PRODUCT_NAME = process.env.YOOTUN_BRAND_PRODUCT_NAME ?? 'DeepSeek Harness'

/** 品牌眉标：构建环境注入（官方构建为空串，不渲染落款）。 */
export const BRAND_EYEBROW = process.env.YOOTUN_BRAND_EYEBROW ?? ''

export const zh = {
  nav: 'Yootun 接入',
  title: `激活 ${PRODUCT_NAME}`,
  intro: `输入Key并选择默认模型，验证通过后即可使用 ${PRODUCT_NAME}`,
  key: 'Model API Key',
  keyPlaceholder: '输入 Key',
  showKey: '显示 Key',
  hideKey: '隐藏 Key',
  load: '获取可用模型',
  loading: '正在获取…',
  modelsLoaded: '已获取 {count} 个可用模型',
  model: '默认模型',
  modelPlaceholder: '输入 Key 后获取模型列表',
  submit: '验证并进入',
  saving: '正在验证…',
  remove: '移除 Key',
  confirmRemove: '确认移除',
  cancel: '取消',
  removeWarning: '移除后将退出当前授权状态，需要重新输入 Key 才能继续使用',
  help: '获取Key，请联系优惠豚 AI 部凯文',
  statusTitle: '激活状态',
  statusActive: '已激活，当前模型 {model}',
  statusInactive: '未激活',
  changeKey: '更换 Key',
  removeKey: '移除 Key',
  invalid: 'Key 验证失败，请检查后重试',
  tenantMismatch: '该 Key 不属于本产品租户，请使用管理员分配的 model_api_key',
  tenantUnavailable: '暂时无法确认该 Key 的租户归属，请稍后重试',
  modelError: '无法获取模型列表，请检查 Key 与模型服务',
  saveError: '保存失败，请检查配置后重试',
  removeError: '移除失败，请稍后重试',
} as const

export type AccessLocaleKey = keyof typeof zh

export const en: Record<AccessLocaleKey, string> = {
  nav: 'Yootun access',
  title: `Activate ${PRODUCT_NAME}`,
  intro: `Enter your key and choose a default model to start using ${PRODUCT_NAME}`,
  key: 'Model API Key',
  keyPlaceholder: 'Enter your key',
  showKey: 'Show key',
  hideKey: 'Hide key',
  load: 'Load available models',
  loading: 'Loading…',
  modelsLoaded: '{count} models available',
  model: 'Default model',
  modelPlaceholder: 'Load models after entering the key',
  submit: 'Verify and enter',
  saving: 'Verifying…',
  remove: 'Remove key',
  confirmRemove: 'Confirm removal',
  cancel: 'Cancel',
  removeWarning: 'Removing the key signs you out; you will need to enter it again to continue',
  help: 'For a key, contact Kevin from the Yootun AI team',
  statusTitle: 'Activation',
  statusActive: 'Activated, current model {model}',
  statusInactive: 'Not activated',
  changeKey: 'Change key',
  removeKey: 'Remove key',
  invalid: 'The key could not be verified',
  tenantMismatch: 'This key belongs to a different tenant; use the model_api_key your administrator assigned',
  tenantUnavailable: 'The key tenant could not be confirmed; try again shortly',
  modelError: 'Could not load models; check the key and the model service',
  saveError: 'Could not save the configuration',
  removeError: 'Could not remove the key',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** yootun activation and gate copy. */
    'yootun.access': AccessLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'yootun.access'
