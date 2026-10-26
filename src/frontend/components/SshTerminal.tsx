import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { AlertCircle, RefreshCw, SquareTerminal, X } from 'lucide-react'
import { api } from '../services/api'
import { analyzeCudaCommand } from '../utils/cudaCommand'
import { bracketTerminalPaste, isMultilineTerminalPaste, normalizeTerminalPaste } from '../utils/terminalPaste'

interface TerminalEvent { sessionId: string; data?: string }

export function SshTerminal({ serverId, serverName, gpuIndex, acceleratorVendor = 'nvidia', onNotice }: { serverId: string; serverName: string; gpuIndex?: number; acceleratorVendor?: 'nvidia' | 'ascend'; onNotice?: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Notification callback changes should not restart an active SSH connection.
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice
  const sessionRef = useRef<string | null>(null)
  const lineRef = useRef('')
  const pendingEnterRef = useRef(false)
  const pendingPasteRef = useRef<string | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed' | 'error'>(api.isDesktop ? 'connecting' : 'closed')
  const [error, setError] = useState<string | null>(null)
  const [restart, setRestart] = useState(0)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [pendingPaste, setPendingPaste] = useState<string | null>(null)

  useEffect(() => {
    if (!api.isDesktop || !containerRef.current) return
    let disposed = false
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: {
        background: '#ffffff',
        foreground: '#24292f',
        cursor: '#0969da',
        cursorAccent: '#ffffff',
        selectionBackground: '#b6d7ff',
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#9a6700',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        white: '#57606a',
        brightBlack: '#6e7781',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#bf8700',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
        brightCyan: '#3192aa',
        brightWhite: '#24292f',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(containerRef.current)
    fit.fit()
    terminal.focus()
    let fitFrame: number | null = null

    const fitAndResize = () => {
      if (fitFrame !== null) cancelAnimationFrame(fitFrame)
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null
        if (disposed) return
        fit.fit()
        const id = sessionRef.current
        if (id) void api.resizeTerminal(id, terminal.cols, terminal.rows)
      })
    }

    const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
    // SSH can produce output (or exit) before startTerminal returns the session
    // ID. Buffer startup events and replay them once the ID is available.
    let starting = true
    const earlyEvents: Array<{ type: 'output' | 'exit'; payload: TerminalEvent }> = []
    const handleEvent = (type: 'output' | 'exit', payload: TerminalEvent) => {
      if (disposed) return
      if (starting) {
        if (earlyEvents.length < 512) earlyEvents.push({ type, payload })
        return
      }
      if (payload.sessionId !== sessionRef.current) return
      if (type === 'exit') {
        sessionRef.current = null
        setStatus('closed')
        terminal.write('\r\n\x1b[90m[会话已断开]\x1b[0m\r\n')
      } else if (payload.data) {
        terminal.write(decode(payload.data))
      }
    }
    const outputListener = listen<TerminalEvent>('terminal-output', ({ payload }) => handleEvent('output', payload))
    const exitListener = listen<TerminalEvent>('terminal-exit', ({ payload }) => handleEvent('exit', payload))

    const send = (data: string) => { const id = sessionRef.current; if (id) void api.writeTerminal(id, data).catch((reason) => setError(String(reason))) }
    const handlePaste = (event: ClipboardEvent) => {
      const pasted = event.clipboardData?.getData('text/plain') ?? ''
      if (!isMultilineTerminalPaste(pasted)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const normalized = normalizeTerminalPaste(pasted)
      pendingPasteRef.current = normalized
      setPendingPaste(normalized)
      terminal.focus()
      onNoticeRef.current?.(`已整体粘贴 ${normalized.split('\n').filter(Boolean).length} 行，按回车执行`)
    }
    containerRef.current.addEventListener('paste', handlePaste, true)
    const dataDisposable = terminal.onData((data) => {
      if (pendingEnterRef.current) return
      if (pendingPasteRef.current !== null) {
        if (data === '\r' || data === '\n') {
          const script = pendingPasteRef.current
          pendingPasteRef.current = null
          setPendingPaste(null)
          lineRef.current = ''
          if (gpuIndex !== undefined) {
            const analysis = analyzeCudaCommand(script, gpuIndex)
            if (analysis.requiresConfirmation) {
              send(bracketTerminalPaste(script))
              pendingEnterRef.current = true
              setConfirmation(analysis.message ?? '无法确认 GPU 绑定，仍要执行吗？')
              return
            }
            if (analysis.modified) {
              send(`${bracketTerminalPaste(analysis.command)}\r`)
              onNoticeRef.current?.(analysis.message ?? '已修正 GPU 绑定')
              return
            }
          }
          send(`${bracketTerminalPaste(script)}\r`)
        } else if (data === '\x1b') {
          pendingPasteRef.current = null
          setPendingPaste(null)
          onNoticeRef.current?.('已取消多行命令')
        }
        return
      }
      if (gpuIndex !== undefined && (data === '\r' || data === '\n')) {
        const analysis = analyzeCudaCommand(lineRef.current, gpuIndex)
        lineRef.current = ''
        if (analysis.requiresConfirmation) { pendingEnterRef.current = true; setConfirmation(analysis.message ?? '无法确认 GPU 绑定，仍要执行吗？'); return }
        if (analysis.modified) { send(`\x15${analysis.command}\r`); onNoticeRef.current?.(analysis.message ?? '已修正 GPU 绑定'); return }
      } else if (data === '\x7f') lineRef.current = lineRef.current.slice(0, -1)
      else if (data === '\x15') lineRef.current = ''
      else if (!data.startsWith('\x1b') && !/^[\x00-\x1f]$/.test(data)) lineRef.current += data
      send(data)
    })

    const resize = new ResizeObserver(fitAndResize)
    resize.observe(containerRef.current)
    void Promise.all([outputListener, exitListener]).then(async () => {
      if (disposed) return
      const id = await api.startTerminal(serverId, terminal.cols, terminal.rows, gpuIndex, acceleratorVendor)
      if (disposed) { void api.closeTerminal(id); return }
      sessionRef.current = id
      starting = false
      setStatus('connected')
      for (const event of earlyEvents) handleEvent(event.type, event.payload)
      earlyEvents.length = 0
      if (sessionRef.current !== id) return // Already exited during startup.
      fit.fit()
      void api.resizeTerminal(id, terminal.cols, terminal.rows)
      fitAndResize()
      terminal.focus()
    }).catch((reason) => {
      if (!disposed) { setStatus('error'); setError(String(reason)) }
    })

    return () => {
      disposed = true
      if (fitFrame !== null) cancelAnimationFrame(fitFrame)
      resize.disconnect()
      containerRef.current?.removeEventListener('paste', handlePaste, true)
      dataDisposable.dispose()
      void outputListener.then((unlisten) => unlisten())
      void exitListener.then((unlisten) => unlisten())
      const id = sessionRef.current
      sessionRef.current = null
      if (id) void api.closeTerminal(id)
      terminal.dispose()
    }
  }, [acceleratorVendor, gpuIndex, restart, serverId])

  const confirmPending = (sendEnter: boolean) => {
    pendingEnterRef.current = false
    setConfirmation(null)
    if (sendEnter && sessionRef.current) void api.writeTerminal(sessionRef.current, '\r')
  }

  if (!api.isDesktop) return <section className="panel terminal-unavailable"><SquareTerminal size={28} /><h3>终端在桌面 App 中可用</h3><p>网页演示不会建立或伪造 SSH 会话。</p></section>
  return <section className={`terminal-shell${error ? ' terminal-shell--has-error' : ''}`} aria-label={`${serverName} SSH 终端`}>
    <header><span className={`terminal-status terminal-status--${status}`} /><strong>{gpuIndex === undefined ? serverName : `${serverName} · GPU ${gpuIndex}`}</strong><small>{status === 'connecting' ? '正在连接' : status === 'connected' ? '已连接' : status === 'error' ? '连接失败' : '已断开'}</small><button className="icon-button" aria-label="重新连接终端" title="重新连接" onClick={() => { setError(null); setStatus('connecting'); setRestart((value) => value + 1) }}><RefreshCw size={14} /></button></header>
    {error && <div className="terminal-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button onClick={() => setError(null)} aria-label="关闭错误"><X size={13} /></button></div>}
    <div className="terminal-workspace">
      <div className="terminal-canvas" ref={containerRef} />
    </div>
    {pendingPaste && <div className="terminal-paste-preview" role="status"><header><strong>待执行的多行命令</strong><small>按回车执行 · Esc 取消</small></header><pre>{pendingPaste}</pre></div>}
    {confirmation && <div className="terminal-confirm" role="alertdialog" aria-modal="true"><div><strong>确认 GPU 绑定</strong><p>{confirmation}。命令仍停留在远端输入行，尚未执行。</p></div><button className="button button--secondary button--small" onClick={() => confirmPending(false)}>暂不执行</button><button className="button button--primary button--small" onClick={() => confirmPending(true)}>仍然执行</button></div>}
  </section>
}
