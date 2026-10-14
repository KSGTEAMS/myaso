// Procedural product art for demo tenants. The sandbox that produced this
// project had no access to photo sources, so demo images are generated:
// textured "plated" renders per product style. Real shops replace them by
// dropping photos into tenants/<slug>/images and re-running tenant:publish.
import sharp from 'sharp'

export type ArtStyle = 'steak' | 'mince' | 'smoked' | 'sausage' | 'poultry' | 'ribs' | 'game' | 'dumplings' | 'hero' | 'fillet'

interface Palette { meat: [string, string]; fat: string; board: [string, string] }

const PALETTES: Record<ArtStyle, Palette> = {
  steak: { meat: ['#B0242C', '#5C0D14'], fat: '#F3E6DA', board: ['#2A211C', '#120E0C'] },
  fillet: { meat: ['#C0303A', '#6A1018'], fat: '#F5E9DE', board: ['#232227', '#0E0E11'] },
  mince: { meat: ['#C8434A', '#7A1C22'], fat: '#F0D8CF', board: ['#1F2226', '#0C0D0F'] },
  smoked: { meat: ['#8A3B1C', '#3A1408'], fat: '#E9B77A', board: ['#2B2017', '#100B07'] },
  sausage: { meat: ['#9E3B2A', '#4A160E'], fat: '#E7A07A', board: ['#262019', '#0F0C09'] },
  poultry: { meat: ['#E7B7A2', '#B77B66'], fat: '#FBEFE4', board: ['#22262A', '#0D0F11'] },
  ribs: { meat: ['#A8332A', '#4F120C'], fat: '#F1DFCF', board: ['#2A211C', '#120E0C'] },
  game: { meat: ['#7A1620', '#2E060B'], fat: '#E8D6CC', board: ['#1E2321', '#0B0E0D'] },
  dumplings: { meat: ['#F4EEE4', '#D9CBB6'], fat: '#FFFFFF', board: ['#24262B', '#0D0E10'] },
  hero: { meat: ['#A3222B', '#4A0A10'], fat: '#F3E3D6', board: ['#1B1714', '#080706'] },
}

function hashSeed(s: string): number {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return Math.abs(h) % 997
}

/** Irregular blob path around (cx, cy). */
function blob(cx: number, cy: number, rx: number, ry: number, seed: number, points = 9): string {
  const pts: Array<[number, number]> = []
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2
    const j = 0.86 + ((Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.22
    pts.push([cx + Math.cos(a) * rx * j, cy + Math.sin(a) * ry * j])
  }
  const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  let d = `M ${mid(pts[points - 1]!, pts[0]!).join(' ')}`
  for (let i = 0; i < points; i++) {
    const p = pts[i]!
    const m = mid(p, pts[(i + 1) % points]!)
    d += ` Q ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${m[0].toFixed(1)} ${m[1].toFixed(1)}`
  }
  return `${d} Z`
}

function pieces(style: ArtStyle, w: number, h: number, seed: number, p: Palette): string {
  const meatFill = 'url(#meat)'
  switch (style) {
    case 'mince': {
      const d = blob(w / 2, h / 2, w * 0.3, h * 0.3, seed, 11)
      return `<path d="${d}" fill="${meatFill}"/><path d="${d}" fill="url(#mincegrain)" filter="url(#grain)" opacity="0.9"/>`
    }
    case 'sausage': {
      let s = ''
      for (let i = 0; i < 4; i++) {
        const y = h * 0.3 + i * h * 0.13
        s += `<rect x="${w * 0.16 + (i % 2) * 20}" y="${y}" width="${w * 0.66}" height="${h * 0.1}" rx="${h * 0.05}" fill="${meatFill}"/>`
        s += `<rect x="${w * 0.2 + (i % 2) * 20}" y="${y + h * 0.018}" width="${w * 0.5}" height="${h * 0.015}" rx="4" fill="#fff" opacity="0.18"/>`
      }
      return s
    }
    case 'dumplings': {
      let s = ''
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
        const x = w * 0.22 + c * w * 0.17 + (r % 2) * w * 0.06
        const y = h * 0.3 + r * h * 0.17
        s += `<path d="${blob(x, y, w * 0.07, h * 0.065, seed + r * 4 + c, 7)}" fill="${meatFill}"/>`
        s += `<path d="M ${x - w * 0.05} ${y - h * 0.01} q ${w * 0.05} ${-h * 0.05} ${w * 0.1} 0" stroke="#d8c7ae" stroke-width="3" fill="none"/>`
      }
      return s
    }
    case 'ribs': {
      const d = blob(w / 2, h / 2, w * 0.36, h * 0.24, seed, 8)
      let bones = ''
      for (let i = 0; i < 5; i++) bones += `<rect x="${w * 0.24 + i * w * 0.11}" y="${h * 0.28}" width="${w * 0.035}" height="${h * 0.44}" rx="10" fill="#EFE3D3" opacity="0.92"/>`
      return `<path d="${d}" fill="${meatFill}"/><path d="${d}" filter="url(#marble)" opacity="0.55"/>${bones}`
    }
    case 'poultry': {
      const d = blob(w / 2, h / 2, w * 0.3, h * 0.26, seed, 8)
      return `<path d="${d}" fill="${meatFill}"/><path d="${d}" filter="url(#skin)" opacity="0.5"/>`
    }
    default: {
      const d = blob(w / 2, h * 0.52, w * (style === 'hero' ? 0.34 : 0.32), h * (style === 'hero' ? 0.3 : 0.28), seed, 9)
      const fatCap = style === 'steak' || style === 'hero'
        ? `<path d="${blob(w * 0.5, h * 0.27, w * 0.27, h * 0.05, seed + 3, 7)}" fill="${p.fat}" opacity="0.95"/>` : ''
      const gloss = style === 'smoked' ? `<path d="${d}" fill="url(#gloss)" opacity="0.5"/>` : ''
      return `${fatCap}<path d="${d}" fill="${meatFill}"/><path d="${d}" filter="url(#marble)" opacity="${style === 'fillet' ? 0.3 : style === 'smoked' || style === 'game' ? 0.45 : 0.85}"/>${gloss}`
    }
  }
}

export function artSvg(style: ArtStyle, name: string, w = 1200, h = 900): string {
  const p = PALETTES[style]
  const seed = hashSeed(name)
  const fat = p.fat
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
  <radialGradient id="meat" cx="45%" cy="40%" r="70%"><stop offset="0" stop-color="${p.meat[0]}"/><stop offset="1" stop-color="${p.meat[1]}"/></radialGradient>
  <radialGradient id="board" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="${p.board[0]}"/><stop offset="1" stop-color="${p.board[1]}"/></radialGradient>
  <linearGradient id="gloss" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd9a0" stop-opacity="0.7"/><stop offset="0.5" stop-color="#ffd9a0" stop-opacity="0"/></linearGradient>
  <pattern id="mincegrain" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="3" fill="${fat}" opacity="0.35"/><circle cx="11" cy="10" r="2" fill="#5a0c12" opacity="0.5"/></pattern>
  <filter id="marble" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.009 0.04" numOctaves="5" seed="${seed}" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.96  0 0 0 0 0.9  0 0 0 0 0.85  0 0 0 -60 25.5" result="veins"/>
    <feComposite in="veins" in2="SourceGraphic" operator="in"/>
  </filter>
  <filter id="skin"><feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="${seed}"/>
    <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 0.95  0 0 0 0 0.9  0 0 0 -6 3.4"/><feComposite in2="SourceGraphic" operator="in"/></filter>
  <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.35" numOctaves="1" seed="${seed}"/>
    <feColorMatrix type="matrix" values="0 0 0 0 0.98  0 0 0 0 0.85  0 0 0 0 0.8  0 0 0 -9 4.6"/><feComposite in2="SourceGraphic" operator="in"/></filter>
  <filter id="wood"><feTurbulence type="fractalNoise" baseFrequency="0.002 0.08" numOctaves="3" seed="${seed + 11}"/>
    <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.09 0"/></filter>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
  <radialGradient id="vignette" cx="50%" cy="50%" r="70%"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.75"/></radialGradient>
  <radialGradient id="light" cx="35%" cy="25%" r="55%"><stop offset="0" stop-color="#fff" stop-opacity="0.12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${w}" height="${h}" fill="url(#board)"/>
<rect width="${w}" height="${h}" filter="url(#wood)"/>
<ellipse cx="${w / 2 + 24}" cy="${h * 0.56 + 30}" rx="${w * 0.36}" ry="${h * 0.3}" fill="#000" opacity="0.55" filter="url(#shadow)"/>
${pieces(style, w, h, seed, p)}
<rect width="${w}" height="${h}" fill="url(#light)"/>
<rect width="${w}" height="${h}" fill="url(#vignette)"/>
</svg>`
}

export async function renderArt(style: ArtStyle, name: string, file: string, w = 1200, h = 900) {
  await sharp(Buffer.from(artSvg(style, name, w, h))).jpeg({ quality: 86, mozjpeg: true }).toFile(file)
}

export function iconSvg(letter: string, accent: string, background: string, onAccent: string, size = 1024): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${background}"/>
  <circle cx="512" cy="512" r="340" fill="${accent}"/>
  <text x="512" y="512" dy="0.35em" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700"
        font-size="${letter.length > 1 ? 300 : 400}" fill="${onAccent}">${letter}</text>
</svg>`
}
