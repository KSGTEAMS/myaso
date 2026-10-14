// Consistent bottom sheet on the shadcn Drawer (vaul branch). Opening pushes
// a history entry, so the system Back button / gesture closes the sheet
// instead of leaving the page. Focus is trapped and restored by the dialog.
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'

export function useSheet(name: string) {
  const [params, setParams] = useSearchParams()
  const value = params.get(name)
  const pushed = useRef(false)
  const open = useCallback((v = '1') => {
    pushed.current = true
    setParams((p) => { const n = new URLSearchParams(p); n.set(name, v); return n })
  }, [name, setParams])
  const close = useCallback(() => {
    if (!params.has(name)) return
    if (pushed.current) { pushed.current = false; history.back() }
    else setParams((p) => { const n = new URLSearchParams(p); n.delete(name); return n }, { replace: true })
  }, [name, params, setParams])
  return { value, isOpen: value !== null, open, close }
}

export function Sheet(props: {
  isOpen: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  initialFocus?: string
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!props.isOpen || !props.initialFocus) return
    const t = setTimeout(() => contentRef.current?.querySelector<HTMLElement>(props.initialFocus!)?.focus(), 50)
    return () => clearTimeout(t)
  }, [props.isOpen, props.initialFocus])
  return (
    <Drawer open={props.isOpen} onOpenChange={(o) => { if (!o) props.onClose() }} repositionInputs>
      <DrawerContent ref={contentRef} className="sheet-content mx-auto max-w-[640px] bg-surface border-border">
        <DrawerHeader className="text-left">
          <DrawerTitle className="text-lg">{props.title}</DrawerTitle>
          {props.description ? <DrawerDescription>{props.description}</DrawerDescription> : null}
        </DrawerHeader>
        <div className="sheet-scroll px-4">{props.children}</div>
        {props.footer ? <DrawerFooter className="sheet-body">{props.footer}</DrawerFooter> : <div className="sheet-body" />}
      </DrawerContent>
    </Drawer>
  )
}
