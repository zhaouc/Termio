// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { disableDesktopBrowserContextMenu } from './contextMenu'

let uninstall = () => {}

afterEach(() => {
  uninstall()
  uninstall = () => {}
  document.body.innerHTML = ''
})

describe('desktop browser context menu', () => {
  it('hides the WebView2 menu on ordinary UI elements', () => {
    const area = document.createElement('div')
    document.body.append(area)
    uninstall = disableDesktopBrowserContextMenu(document, true)

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    expect(area.dispatchEvent(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not swallow xterm right-click, selection, wheel, or clipboard events', () => {
    const terminal = document.createElement('div')
    terminal.className = 'terminal-canvas'
    document.body.append(terminal)
    const onContextMenu = vi.fn()
    const onMouseDown = vi.fn()
    const onWheel = vi.fn()
    const onPaste = vi.fn()
    terminal.addEventListener('contextmenu', onContextMenu)
    terminal.addEventListener('mousedown', onMouseDown)
    terminal.addEventListener('wheel', onWheel)
    terminal.addEventListener('paste', onPaste)
    uninstall = disableDesktopBrowserContextMenu(document, true)

    const rightClick = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 })
    expect(terminal.dispatchEvent(rightClick)).toBe(true)
    expect(onMouseDown).toHaveBeenCalledOnce()
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    expect(terminal.dispatchEvent(menu)).toBe(false)
    expect(onContextMenu).toHaveBeenCalledOnce() // Still delivered to xterm.
    const scroll = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 20 })
    expect(terminal.dispatchEvent(scroll)).toBe(true)
    expect(onWheel).toHaveBeenCalledOnce()
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    expect(terminal.dispatchEvent(paste)).toBe(true)
    expect(onPaste).toHaveBeenCalledOnce()
  })

  it('keeps copy/paste keyboard shortcuts functional in inputs', () => {
    const input = document.createElement('input')
    document.body.append(input)
    uninstall = disableDesktopBrowserContextMenu(document, true)
    for (const key of ['c', 'v', 'x', 'a']) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key })
      expect(input.dispatchEvent(event)).toBe(true)
      expect(event.defaultPrevented).toBe(false)
    }
    for (const type of ['copy', 'cut', 'paste']) {
      const event = new Event(type, { bubbles: true, cancelable: true })
      expect(input.dispatchEvent(event)).toBe(true)
      expect(event.defaultPrevented).toBe(false)
    }
  })

  it('leaves web preview unchanged and unregisters cleanly', () => {
    const area = document.createElement('div')
    document.body.append(area)
    disableDesktopBrowserContextMenu(document, false)()
    expect(area.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(true)
    uninstall = disableDesktopBrowserContextMenu(document, true)
    expect(area.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false)
    uninstall()
    uninstall = () => {}
    expect(area.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(true)
  })
})
