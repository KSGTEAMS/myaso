import { useQuery } from '@tanstack/react-query'
import { Badge } from '@astryxdesign/core/Badge'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { QueryState } from '@/components/QueryState'
import { Photo } from '@/components/Photo'

interface Entry { slug: string; name: string; tagline: string; accent: string; status: string; hero: string | null }

/** Root page: shops published on this deployment (from the generated tenants.json). */
export function DirectoryPage() {
  const q = useQuery({
    queryKey: ['directory'],
    queryFn: async () => {
      const r = await fetch('/tenants.json', { cache: 'no-cache' })
      if (!r.ok) return [] as Entry[]
      return ((await r.json()) as { tenants: Entry[] }).tenants
    },
  })
  return (
    <VStack gap={4} padding={4} maxWidth={640} className="mx-auto">
      <Heading level={1}>Магазины</Heading>
      <QueryState query={q} isEmpty={(d) => d.length === 0} empty={{ title: 'Пока нет опубликованных магазинов', description: 'Опубликуйте магазин: npm run tenant:publish -- <slug>' }}>
        {(list) => (
          <VStack gap={3}>
            {list.map((t) => (
              <ClickableCard key={t.slug} label={t.name} href={`/s/${t.slug}/`} padding={0}>
                <Photo path={t.hero ? `static:${t.hero}` : null} alt="" ratio={21 / 9} widths={[800]} />
                <VStack gap={1} padding={4}>
                  <Heading level={2}>{t.name}</Heading>
                  <Text type="supporting">{t.tagline}</Text>
                  {t.status === 'preview' ? <Badge label="демо" variant="warning" /> : null}
                </VStack>
              </ClickableCard>
            ))}
          </VStack>
        )}
      </QueryState>
    </VStack>
  )
}
