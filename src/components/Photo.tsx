import { AspectRatio } from '@astryxdesign/core/AspectRatio'
import { mediaSrcSet, mediaUrl } from '@/lib/supabase'

/** Product / hero photo: responsive WebP for pipeline images, Storage URL for owner uploads. */
export function Photo({ path, alt, ratio = 4 / 3, sizes = '(max-width: 640px) 100vw, 640px', priority = false, widths = [480, 960] }:
  { path: string | null | undefined; alt: string; ratio?: number; sizes?: string; priority?: boolean; widths?: number[] }) {
  const src = mediaUrl(path, widths[0]!)
  return (
    <AspectRatio ratio={ratio}>
      {src ? (
        <img className="photo-cover" src={src} srcSet={mediaSrcSet(path, widths)} sizes={sizes} alt={alt}
          loading={priority ? 'eager' : 'lazy'} decoding="async" fetchPriority={priority ? 'high' : 'auto'} />
      ) : <span className="photo-placeholder" role="img" aria-label={alt} />}
    </AspectRatio>
  )
}
