import './styles/layers.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { InternationalizationProvider } from '@astryxdesign/core/i18n'
import { LinkProvider } from '@astryxdesign/core/Link'
import ruRU from '@astryxdesign/core/locales/ru-RU.generated.js'
import { Theme } from '@astryxdesign/core/theme'
import { themes, defaultThemeSlug } from './astryx-themes'
import { RouterLink } from './app/RouterLink'
import { router } from './app/router'
import { ApiError } from './lib/errors'
import './styles/app.css'

// Start from the real connectivity state so offline launches show an
// explicit "no connection" state instead of retrying in the dark.
onlineManager.setOnline(navigator.onLine)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status >= 400 && e.status < 500),
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <InternationalizationProvider locale="ru-RU" messages={{ 'ru-RU': ruRU }}>
        <Theme theme={themes[defaultThemeSlug]} mode="dark">
          <LinkProvider component={RouterLink}>
            <RouterProvider router={router} />
          </LinkProvider>
        </Theme>
      </InternationalizationProvider>
    </QueryClientProvider>
  </StrictMode>,
)
