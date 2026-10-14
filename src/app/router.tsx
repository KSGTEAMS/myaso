import { createBrowserRouter, Navigate, useRouteError } from 'react-router'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { VStack } from '@astryxdesign/core/VStack'
import { ClientLayout } from '@/features/ClientLayout'
import { CatalogPage } from '@/features/catalog/CatalogPage'
import { CartPage } from '@/features/cart/CartPage'
import { OrdersPage } from '@/features/orders/OrdersPage'
import { OrderPage } from '@/features/orders/OrderPage'
import { ClientAssistantPage } from '@/features/assistant/ClientAssistantPage'
import { DirectoryPage } from '@/features/directory/DirectoryPage'
import { OwnerLayout } from '@/features/owner/OwnerLayout'
import { TodayPage } from '@/features/owner/TodayPage'
import { OwnerOrdersPage } from '@/features/owner/OwnerOrdersPage'
import { OwnerOrderPage } from '@/features/owner/OwnerOrderPage'
import { ResourcesPage } from '@/features/owner/ResourcesPage'
import { StatsPage } from '@/features/owner/StatsPage'
import { OwnerCatalogPage } from '@/features/owner/OwnerCatalogPage'
import { MorePage } from '@/features/owner/MorePage'
import { OwnerAssistantPage } from '@/features/owner/OwnerAssistantPage'

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
    element: <OwnerLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <TodayPage /> },
      { path: 'orders', element: <OwnerOrdersPage /> },
      { path: 'orders/:orderId', element: <OwnerOrderPage /> },
      { path: 'resources', element: <ResourcesPage /> },
      { path: 'stats', element: <StatsPage /> },
      { path: 'catalog', element: <OwnerCatalogPage /> },
      { path: 'assistant', element: <OwnerAssistantPage /> },
      { path: 'more', element: <MorePage /> },
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
      { path: 'assistant', element: <ClientAssistantPage /> },
      { path: '*', element: <Navigate to="." replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])
