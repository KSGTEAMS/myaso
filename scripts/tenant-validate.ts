// npm run tenant:validate -- <slug> [<slug> ...] | --all
// Checks business.json against the schema, cross references, business rules
// (contrast, hours), and the images (presence, size). Exit 1 on problems.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { BusinessSchema } from '../shared/business-schema.ts'
import { TENANTS_DIR, listTenantFolders, validateTenant } from './lib/tenant.ts'

export function writeJsonSchema() {
  const schema = z.toJSONSchema(BusinessSchema, { io: 'input', unrepresentable: 'any' })
  writeFileSync(path.join(TENANTS_DIR, 'business.schema.json'), `${JSON.stringify(schema, null, 2)}\n`)
}

export async function validateMany(slugs: string[]): Promise<boolean> {
  let ok = true
  for (const slug of slugs) {
    const { problems, business } = await validateTenant(slug)
    if (problems.length) {
      ok = false
      console.log(`✗ ${slug}`)
      for (const p of problems) console.log(`    ${p.path}: ${p.message}`)
    } else {
      console.log(`✓ ${slug} — ${business!.products.length} products, ${business!.resources.length} resources, ${business!.timezone}`)
    }
  }
  return ok
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeJsonSchema()
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const slugs = process.argv.includes('--all') || args.length === 0 ? listTenantFolders() : args
  validateMany(slugs).then((ok) => process.exit(ok ? 0 : 1))
}
