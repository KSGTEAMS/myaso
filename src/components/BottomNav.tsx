import type { ComponentType, SVGProps } from 'react'
import { NavLink } from 'react-router'
import { Icon } from '@astryxdesign/core/Icon'
import { Text } from '@astryxdesign/core/Text'

export interface NavItem { to: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; end?: boolean; badge?: number }

export function BottomNav({ items, label }: { items: NavItem[]; label: string }) {
  return (
    <nav className="bottom-nav" aria-label={label}>
      <ul className="bottom-nav-list">
        {items.map((it) => (
          <li key={it.to}>
            <NavLink to={it.to} end={it.end} className="bottom-nav-item">
              <span className="bottom-nav-icon">
                <Icon icon={it.icon} size="md" />
                {it.badge ? <span className="bottom-nav-badge" aria-label={`${it.badge} в корзине`}>{it.badge}</span> : null}
              </span>
              <Text type="supporting" size="2xs" color="inherit">{it.label}</Text>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
