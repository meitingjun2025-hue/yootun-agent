/**
 * yootun 接入层包内冒烟（node --test，不进官方 vitest scope）：路由目录解析、
 * 门禁判定的 fail-closed 语义、生成常量与 brand.json 的一致性。
 * 运行：`pnpm --filter @yootun/dsh-client-ui-access test`（node ≥24 原生 type stripping）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseModelCatalog } from '../src/route.ts'
import { isAuthorized } from '../src/client/logic.ts'
import { TENANT, TENANT_ID, VALIDATION_VERSION } from '../src/access-constants.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('parseModelCatalog 过滤非对话模型并按目录行映射字段', () => {
  const models = parseModelCatalog({
    data: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'managed', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
      { id: 'deepseek-v4-audio', name: 'audio', contextWindow: 1 },
      { id: 'deepseek-v4-pro', name: 'Pro' },
      { id: 'deepseek-v4-flash', name: 'duplicate' },
      { name: 'no-id' },
      'not-an-object',
    ],
  })
  assert.deepEqual(models.map(model => model.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.equal(models[0]?.name, 'DeepSeek V4 Flash')
  assert.equal(models[0]?.description, 'managed')
  assert.equal(models[0]?.contextWindow, 1_000_000)
  assert.deepEqual(models[0]?.inputModalities, ['text', 'image'])
  assert.equal(models[1]?.name, 'Pro')
})

test('parseModelCatalog 接受裸数组与拒绝异常载荷', () => {
  assert.equal(parseModelCatalog([{ id: 'm1' }]).length, 1)
  assert.deepEqual(parseModelCatalog('nope'), [])
  assert.deepEqual(parseModelCatalog(null), [])
  assert.deepEqual(parseModelCatalog({ data: 'nope' }), [])
})

test('isAuthorized 对每个缺失面 fail-closed，版本必须精确一致', () => {
  const authorized: Parameters<typeof isAuthorized>[0] = {
    setupComplete: true, validationVersion: Number(VALIDATION_VERSION), enabledPlugins: [], modelId: 'deepseek-v4-flash',
  }
  assert.equal(isAuthorized(authorized, true), true)
  assert.equal(isAuthorized(undefined, true), false)
  assert.equal(isAuthorized(authorized, false), false)
  assert.equal(isAuthorized({ ...authorized, setupComplete: false }, true), false)
  assert.equal(isAuthorized({ ...authorized, validationVersion: Number(VALIDATION_VERSION) + 1 }, true), false)
  assert.equal(isAuthorized({ ...authorized, validationVersion: 0 }, true), false)
})

test('生成常量与 brand.json 的租户与版本单一来源一致', () => {
  const brandConfig = JSON.parse(readFileSync(join(packageRoot, '../../../yootun/brand/brand.json'), 'utf8')) as {
    tenant: string; tenantId: string; validationVersion: number
  }
  assert.equal(TENANT, brandConfig.tenant)
  assert.equal(TENANT_ID, brandConfig.tenantId)
  assert.equal(Number(VALIDATION_VERSION), brandConfig.validationVersion)
})
