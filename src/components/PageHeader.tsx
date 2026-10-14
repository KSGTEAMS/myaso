import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { StackItem } from '@astryxdesign/core/Stack'

export function PageHeader({ title, back, end }: { title: string; back?: string | true; end?: ReactNode }) {
  const navigate = useNavigate()
  return (
    <header className="page-header">
      <HStack gap={2} vAlign="center" paddingInline={4} paddingBlock={3}>
        {back ? (
          <IconButton label="Назад" variant="ghost" icon={<Icon icon={ChevronLeft} />}
            onClick={() => (back === true || history.length > 1 ? navigate(-1) : navigate(back))} />
        ) : null}
        <StackItem size="fill"><Heading level={1} maxLines={1}>{title}</Heading></StackItem>
        {end}
      </HStack>
    </header>
  )
}
