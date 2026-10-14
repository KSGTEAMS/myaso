// One shared Astryx theme (dark), re-seeded per shop with its single accent
// through the documented runtime `defineTheme({extends, color})` path.
import { useMemo, type ReactNode } from 'react'
import { Theme } from '@astryxdesign/core/theme'
import { defineTheme } from '@astryxdesign/core/theme'
import { themes, defaultThemeSlug } from '@/astryx-themes'

const base = themes[defaultThemeSlug]

function onAccentFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const l = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#FFFFFF'
}

export function TenantTheme({ accent, background, id, children }: { accent?: string | null; background?: string | null; id: string; children: ReactNode }) {
  const theme = useMemo(() => {
    if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return base
    const tokens: Record<string, string | [string, string]> = {
      '--color-on-accent': [onAccentFor(accent), onAccentFor(accent)],
      '--focus-outline-color': 'var(--color-accent)',
    }
    if (background && /^#[0-9a-f]{6}$/i.test(background)) tokens['--color-background-body'] = [background, background]
    return defineTheme({
      name: `shop-${id}`,
      extends: base,
      color: { accent: [accent, accent], neutralStyle: 'neutral', contrast: 'standard' },
      tokens,
    } as Parameters<typeof defineTheme>[0])
  }, [accent, background, id])
  return <Theme theme={theme} mode="dark">{children}</Theme>
}
