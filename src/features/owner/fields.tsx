// Native inputs where mobile platforms provide the best keyboard/picker
// (datetime-local, decimal amounts). Styled with Astryx tokens.
import { useId } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'

export function NativeField({ label, description, ...input }: { label: string; description?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId()
  return (
    <VStack gap={1}>
      <label htmlFor={id}><Text type="label">{label}</Text></label>
      {description ? <Text type="supporting" id={`${id}-d`}>{description}</Text> : null}
      <input id={id} className="native-input" aria-describedby={description ? `${id}-d` : undefined} {...input} />
    </VStack>
  )
}

/** Rubles as typed by a person -> minor units. */
export function parseMoney(v: string): number | null {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}
