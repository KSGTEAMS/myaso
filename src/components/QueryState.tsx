import type { ReactNode } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { VStack } from '@astryxdesign/core/VStack'
import { errorMessage } from '@/lib/errors'

/** Loading / error / empty / success for every network-backed block. */
export function QueryState<T>(props: {
  query: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown; isFetching?: boolean; fetchStatus?: string }
  isEmpty?: (data: T) => boolean
  empty?: { title: string; description?: string; action?: ReactNode }
  skeleton?: ReactNode
  children: (data: T) => ReactNode
}) {
  const { query } = props
  if (query.isPending && query.fetchStatus === 'paused') {
    return (
      <VStack padding={4}>
        <Banner status="warning" title="Нет соединения" description="Данные загрузятся, как только появится интернет."
          endContent={<Button label="Повторить" size="sm" onClick={() => query.refetch()} />} />
      </VStack>
    )
  }
  if (query.isPending) {
    return <>{props.skeleton ?? (
      <VStack gap={3} padding={4} aria-busy="true" aria-label="Загрузка">
        <Skeleton height={72} /><Skeleton height={72} index={1} /><Skeleton height={72} index={2} />
      </VStack>
    )}</>
  }
  if (query.isError) {
    return (
      <VStack padding={4}>
        <Banner status="error" title="Не удалось загрузить" description={errorMessage(query.error)}
          endContent={<Button label="Повторить" size="sm" isLoading={query.isFetching} onClick={() => query.refetch()} />} />
      </VStack>
    )
  }
  const data = query.data as T
  if (props.isEmpty?.(data) && props.empty) {
    return <EmptyState title={props.empty.title} description={props.empty.description} actions={props.empty.action} />
  }
  return <>{props.children(data)}</>
}
