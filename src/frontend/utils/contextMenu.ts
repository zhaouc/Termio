/**
 * WebView2 exposes Edge's web-page context menu by default. Prevent that menu
 * without swallowing the underlying mouse events: xterm.js must still see
 * right-button actions, mouse tracking, selection and wheel events.
 *
 * This handler deliberately does not intercept keydown, copy or paste, so
 * Ctrl+C / Ctrl+V continue to work in form fields and in the terminal.
 */
export function disableDesktopBrowserContextMenu(target: Document, isDesktop: boolean): () => void {
  if (!isDesktop) return () => {}

  const preventBrowserMenu = (event: MouseEvent) => {
    event.preventDefault()
  }

  target.addEventListener('contextmenu', preventBrowserMenu)
  return () => target.removeEventListener('contextmenu', preventBrowserMenu)
}
