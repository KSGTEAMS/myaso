import './styles/layers.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { Button } from '@astryxdesign/core/Button'
import { VStack } from '@astryxdesign/core/VStack'
import { themes, defaultThemeSlug } from './astryx-themes'
import './styles/app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={themes[defaultThemeSlug]} mode="dark">
      <VStack gap={4} padding={4}>
        <Button label="Foundation check" variant="primary" />
      </VStack>
    </Theme>
  </StrictMode>,
)
