import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { api } from './services/api'
import { detectAppPlatform } from './utils/platform'
import { disableDesktopBrowserContextMenu } from './utils/contextMenu'
import './styles.css'

document.documentElement.dataset.platform = detectAppPlatform(api.isDesktop, navigator.userAgent)

// Hide WebView2's browser menu without changing terminal mouse or clipboard handling.
disableDesktopBrowserContextMenu(document, api.isDesktop)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
