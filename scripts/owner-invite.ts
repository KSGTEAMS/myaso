// Create (or reuse) an owner account and attach it to a tenant.
// There is no public sign-up: this script, run with the service role, is the
// only way to become an owner.
//   npm run owner:invite -- --slug <slug> --email owner@example.com [--password ...] [--role owner|staff]
import { randomBytes } from 'node:crypto'
import { arg, resolveTarget, rpc, serviceClient, type Target } from './lib/env.ts'

export async function inviteOwner(opts: { slug: string; email: string; password?: string; role?: 'owner' | 'staff' }, target: Target = resolveTarget()) {
  const sb = serviceClient(target)
  const password = opts.password ?? randomBytes(12).toString('base64url')
  let userId: string | undefined
  const created = await sb.auth.admin.createUser({ email: opts.email, password, email_confirm: true })
  if (created.data.user) userId = created.data.user.id
  else {
    // Already registered: find the user and keep the existing password unless one was given.
    for (let page = 1; !userId && page < 50; page++) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 })
      if (error) throw error
      userId = data.users.find((u) => u.email?.toLowerCase() === opts.email.toLowerCase())?.id
      if (data.users.length < 200) break
    }
    if (!userId) throw new Error(`could not create or find user: ${created.error?.message}`)
    if (opts.password) await sb.auth.admin.updateUserById(userId, { password: opts.password })
  }
  const member = await rpc(sb, 'add_tenant_member', { p_slug: opts.slug, p_user_id: userId, p_role: opts.role ?? 'owner' })
  if (!member) throw new Error(`tenant ${opts.slug} not found`)
  return { userId, email: opts.email, password: created.data.user || opts.password ? password : undefined }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = arg('slug')
  const email = arg('email')
  if (!slug || !email) {
    console.error('usage: npm run owner:invite -- --slug <slug> --email <email> [--password <pw>] [--role owner|staff]')
    process.exit(1)
  }
  inviteOwner({ slug, email, password: arg('password'), role: (arg('role') as 'owner' | 'staff') ?? 'owner' })
    .then((r) => console.log(r.password ? `owner ${r.email} attached to ${slug}; password: ${r.password}` : `owner ${r.email} attached to ${slug} (existing password kept)`))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
