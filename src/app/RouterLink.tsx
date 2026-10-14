import type { AnchorHTMLAttributes, Ref } from 'react'
import { Link } from 'react-router'

/** Lets Astryx links/buttons with `href` navigate client-side. */
export function RouterLink({ href, ref, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string; ref?: Ref<HTMLAnchorElement> }) {
  if (!href || /^(https?:|mailto:|tel:)/.test(href) || rest.target === '_blank' || rest.download !== undefined) {
    return <a href={href} ref={ref} {...rest} />
  }
  return <Link to={href} ref={ref} {...rest} />
}
