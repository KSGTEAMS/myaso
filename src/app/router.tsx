import { createBrowserRouter, Navigate, useRouteError } from 'react-router'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { VStack } from '@astryxdesign/core/VStack'
import { ClientLayout } from '@/features/ClientLayout'
import { CatalogPage } from '@/features/catalog/CatalogPage'
import { CartPage } from '@/features/cart/CartPage'
import { OrdersPage } from '@/features/orders/OrdersPage'
import { OrderPage } from '@/features/orders/OrderPage'
import { DirectoryPage } from '@/features/directory/DirectoryPage'

function RouteError() {
  const error = useRouteError() as { status?: number } | undefined
  return (
    <VStack minHeight="100dvh" vAlign="center" padding={6}>
      <EmptyState title={error?.status === 404 ? 'Страница не найдена' : 'Что-то пошло не так'}
        actions={<Button label="Обновить" variant="primary" onClick={() => location.reload()} />} />
    </VStack>
  )
}

export const router = createBrowserRouter([
  { path: '/', element: <DirectoryPage />, errorElement: <RouteError /> },
  {
    path: '/s/:slug/owner',
    // The cabinet is a separate chunk: customers never download it.
    lazy: () => import('@/features/owner/OwnerLayout').then((m) => ({ Component: m.OwnerLayout })),
    errorElement: <RouteError />,
    children: [
      { index: true, lazy: () => import('@/features/owner/TodayPage').then((m) => ({ Component: m.TodayPage })) },
      { path: 'orders', lazy: () => import('@/features/owner/OwnerOrdersPage').then((m) => ({ Component: m.OwnerOrdersPage })) },
      { path: 'orders/:orderId', lazy: () => import('@/features/owner/OwnerOrderPage').then((m) => ({ Component: m.OwnerOrderPage })) },
      { path: 'resources', lazy: () => import('@/features/owner/ResourcesPage').then((m) => ({ Component: m.ResourcesPage })) },
      { path: 'stats', lazy: () => import('@/features/owner/StatsPage').then((m) => ({ Component: m.StatsPage })) },
      { path: 'catalog', lazy: () => import('@/features/owner/OwnerCatalogPage').then((m) => ({ Component: m.OwnerCatalogPage })) },
      { path: 'assistant', lazy: () => import('@/features/owner/OwnerAssistantPage').then((m) => ({ Component: m.OwnerAssistantPage })) },
      { path: 'more', lazy: () => import('@/features/owner/MorePage').then((m) => ({ Component: m.MorePage })) },
      { path: '*', element: <Navigate to="." replace /> },
    ],
  },
  {
    path: '/s/:slug',
    element: <ClientLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <CatalogPage /> },
      { path: 'cart', element: <CartPage /> },
      { path: 'orders', element: <OrdersPage /> },
      { path: 'orders/:orderId', element: <OrderPage /> },
      { path: 'assistant', lazy: () => import('@/features/assistant/ClientAssistantPage').then((m) => ({ Component: m.ClientAssistantPage })) },
      { path: '*', element: <Navigate to="." replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])
