/** Stage local-branded DSH packages for unsigned Desktop builds without a publication record. */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  readClientBuildRecord,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'
import { releaseFamily } from '../../../scripts/release/families.ts'
import { packFamilyMembers, parsePackConcurrency } from '../../../scripts/release/pack.ts'
import { runConcurrent } from '../../../scripts/release/process.ts'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, concurrency: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.out === undefined) throw new Error('desktop local pack: --out must name the package staging directory')
  const concurrency = parsePackConcurrency(values.concurrency)
  const root = process.cwd()
  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), 'local')
  readClientBuildRecord(root, environment)
  const destination = resolve(root, values.out)
  const packed = await packFamilyMembers(root, releaseFamily('dsh'), destination, concurrency)
  // yootun enterprise tier (registered inline change): the dsh family selects only
  // @deepseek-ai packages, so unsigned staging packs the tier separately into the
  // same directory for prepare-package-set's ROOT_PACKAGES closure.
  const tier = pnpmInvocation(['pack', '--recursive', '--filter=@yootun/*', '--pack-destination', destination])
  await runConcurrent(tier.command, tier.args)
  console.log(`desktop local pack: ${String(packed.length)} tarball(s) in ${destination}`)
}

await main()
