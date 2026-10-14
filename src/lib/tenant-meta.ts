// The per-tenant HTML shell carries the tenant identity in <meta> tags, so
// the shared bundle can theme the first paint before any network request.
export interface ShellMeta {
  slug: string | null
  kind: 'client' | 'owner' | null
  accent: string | null
  background: string | null
  name: string | null
}

const read = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null

export function shellMeta(): ShellMeta {
  return {
    slug: read('tenant-slug'),
    kind: read('tenant-kind') as ShellMeta['kind'],
    accent: read('tenant-accent'),
    background: read('tenant-background'),
    name: read('tenant-name'),
  }
}
