import React, { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../store/useAppStore'
import type { TerminalSession } from '../../../shared/types'

function xtermTheme(mode: 'dark' | 'light'): object {
  if (mode === 'light') {
    return {
      background: '#eff1f5', foreground: '#4c4f69',
      cursor: '#dc8a78', cursorAccent: '#eff1f5',
      black: '#5c5f77', red: '#d20f39', green: '#40a02b',
      yellow: '#df8e1d', blue: '#1e66f5', magenta: '#8839ef',
      cyan: '#179299', white: '#acb0be',
      brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b',
      brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#8839ef',
      brightCyan: '#179299', brightWhite: '#bcc0cc'
    }
  }
  return {
    background: '#1e1e2e', foreground: '#cdd6f4',
    cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1',
    yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7',
    cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5', brightWhite: '#a6adc8'
  }
}

// ── Module-level font size shared across all terminals ─────────────────────────
let terminalFontSize = 13

function applyFontSize(size: number): void {
  terminalFontSize = Math.max(8, Math.min(28, size))
  for (const inst of terminalInstances.values()) {
    inst.xterm.options.fontSize = terminalFontSize
    requestAnimationFrame(() => inst.fitAddon.fit())
  }
}

// ── Keep xterm instances alive across renders, keyed by terminal ID ────────────
const terminalInstances = new Map<
  string,
  { xterm: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon }
>()

function createXterm(
  container: HTMLElement,
  terminalId: string,
  onData: (data: string) => void,
  onOpenFind: () => void
): { xterm: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon } {
  const mode = (document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark'
  const xterm = new Terminal({
    allowTransparency: true,
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: terminalFontSize,
    lineHeight: 1.4,
    scrollback: 5000,
    overviewRulerWidth: 10,
    theme: xtermTheme(mode)
  })

  const fitAddon = new FitAddon()
  const searchAddon = new SearchAddon()
  const webLinksAddon = new WebLinksAddon()

  xterm.loadAddon(fitAddon)
  xterm.loadAddon(searchAddon)
  xterm.loadAddon(webLinksAddon)

  xterm.open(container)
  fitAddon.fit()

  xterm.onData(onData)

  // Copy selection to clipboard whenever the selection changes
  xterm.onSelectionChange(() => {
    const sel = xterm.getSelection()
    if (sel) navigator.clipboard.writeText(sel).catch(() => {})
  })

  xterm.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true

    // Find bar
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
      onOpenFind()
      return false
    }
    // Copy selection
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      const sel = xterm.getSelection()
      if (sel) navigator.clipboard.writeText(sel)
      return false
    }
    // Paste
    if (e.ctrlKey && e.shiftKey && e.key === 'V') {
      navigator.clipboard.readText().then((text) => onData(text)).catch(() => {})
      return false
    }
    // Font size: Ctrl+= / Ctrl++ to increase
    if (e.ctrlKey && !e.shiftKey && (e.key === '=' || e.key === '+')) {
      applyFontSize(terminalFontSize + 1)
      return false
    }
    // Font size: Ctrl+- to decrease
    if (e.ctrlKey && !e.shiftKey && e.key === '-') {
      applyFontSize(terminalFontSize - 1)
      return false
    }
    // Font size: Ctrl+0 to reset
    if (e.ctrlKey && !e.shiftKey && e.key === '0') {
      applyFontSize(13)
      return false
    }
    // Clear scrollback: Ctrl+L
    if (e.ctrlKey && !e.shiftKey && e.key === 'l') {
      xterm.clear()
      onData('\x0c') // also send form-feed so shell redraws prompt
      return false
    }
    return true
  })

  // Block native paste events — Chromium fires 'paste' for Ctrl+V independently
  // of our key handler, causing double-paste. All paste is handled above.
  xterm.textarea?.addEventListener('paste', (e) => {
    e.stopImmediatePropagation()
    e.preventDefault()
  }, true)

  // Right-click pastes from clipboard
  xterm.element?.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    navigator.clipboard.readText().then((text) => onData(text)).catch(() => {})
  })

  terminalInstances.set(terminalId, { xterm, fitAddon, searchAddon })
  return { xterm, fitAddon, searchAddon }
}

// ── TerminalPane ───────────────────────────────────────────────────────────────

interface TerminalPaneProps {
  session: TerminalSession
  visible: boolean
}

function TerminalPane({ session, visible }: TerminalPaneProps): React.ReactElement {
  const { markTerminalInactive, markTerminalUnread, markTerminalRead } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const visibleRef = useRef(visible)

  const [findOpen, setFindOpen] = useState(false)
  const [findTerm, setFindTerm] = useState('')
  const findInputRef = useRef<HTMLInputElement>(null)

  // Keep visibleRef current without re-subscribing data handlers
  useEffect(() => { visibleRef.current = visible }, [visible])

  const handleData = useCallback(
    (data: string) => { window.api.terminalInput(session.id, data) },
    [session.id]
  )

  // Focus find input when the bar opens
  useEffect(() => {
    if (findOpen) findInputRef.current?.focus()
  }, [findOpen])

  // Initialize xterm on mount
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return
    if (!terminalInstances.has(session.id)) {
      createXterm(containerRef.current, session.id, handleData, () => setFindOpen(true))
    } else {
      const inst = terminalInstances.get(session.id)!
      containerRef.current.appendChild(inst.xterm.element!)
    }
    initializedRef.current = true
  }, [session.id, handleData])

  // Receive data / exit events from main process
  useEffect(() => {
    const unsub = window.api.onTerminalData((terminalId, data) => {
      if (terminalId !== session.id) return
      terminalInstances.get(session.id)?.xterm.write(data)
      if (!visibleRef.current) markTerminalUnread(session.id)
    })

    const unsubExit = window.api.onTerminalExited((terminalId) => {
      if (terminalId !== session.id) return
      const inst = terminalInstances.get(terminalId)
      inst?.xterm.write('\r\n\x1b[31m[Process exited]\x1b[0m\r\n')
      markTerminalInactive(terminalId)
    })

    return () => { unsub(); unsubExit() }
  }, [session.id])

  // Clear unread flag when terminal becomes visible
  useEffect(() => {
    if (visible) markTerminalRead(session.id)
  }, [visible, session.id])

  // Fit when becoming visible; blur when hidden
  useEffect(() => {
    const inst = terminalInstances.get(session.id)
    if (!inst) return
    if (!visible) {
      inst.xterm.blur()
      return
    }
    requestAnimationFrame(() => {
      inst.fitAddon.fit()
      window.api.terminalResize(session.id, inst.xterm.cols, inst.xterm.rows)
    })
  }, [visible, session.id])

  // Dispose xterm on unmount
  useEffect(() => {
    return () => {
      const inst = terminalInstances.get(session.id)
      if (inst) {
        inst.xterm.dispose()
        terminalInstances.delete(session.id)
      }
    }
  }, [session.id])

  // Handle window/pane resize
  useEffect(() => {
    if (!visible) return
    const handleResize = (): void => {
      const inst = terminalInstances.get(session.id)
      if (!inst) return
      inst.fitAddon.fit()
      window.api.terminalResize(session.id, inst.xterm.cols, inst.xterm.rows)
    }
    const observer = new ResizeObserver(handleResize)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [visible, session.id])

  function findNext(): void {
    if (!findTerm) return
    terminalInstances.get(session.id)?.searchAddon.findNext(findTerm)
  }

  function findPrev(): void {
    if (!findTerm) return
    terminalInstances.get(session.id)?.searchAddon.findPrevious(findTerm)
  }

  function closeFind(): void {
    setFindOpen(false)
    setFindTerm('')
    terminalInstances.get(session.id)?.xterm.focus()
  }

  return (
    <div
      ref={containerRef}
      className={`terminal-wrapper${visible ? ' visible' : ''}`}
    >
      {findOpen && visible && (
        <div className="terminal-find-bar">
          <input
            ref={findInputRef}
            className="terminal-find-input"
            value={findTerm}
            onChange={(e) => {
              setFindTerm(e.target.value)
              if (e.target.value) {
                terminalInstances.get(session.id)?.searchAddon.findNext(
                  e.target.value, { incremental: true }
                )
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { closeFind() }
              else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); findPrev() }
              else if (e.key === 'Enter') { e.preventDefault(); findNext() }
            }}
            placeholder="Find in terminal…"
          />
          <button className="btn btn-icon" onClick={findPrev} title="Previous (Shift+Enter)">↑</button>
          <button className="btn btn-icon" onClick={findNext} title="Next (Enter)">↓</button>
          <button className="btn btn-icon" onClick={closeFind} title="Close (Esc)">✕</button>
        </div>
      )}
    </div>
  )
}

// ── TerminalView ───────────────────────────────────────────────────────────────

export function TerminalView(): React.ReactElement {
  const { terminals, activeTerminalId, theme } = useAppStore()

  // Update all open terminal themes when the theme changes
  useEffect(() => {
    const t = xtermTheme(theme)
    for (const inst of terminalInstances.values()) {
      inst.xterm.options.theme = t
    }
  }, [theme])

  if (terminals.length === 0) {
    return (
      <div className="terminal-container">
        <div className="terminal-empty">
          <h2>No terminal open</h2>
          <p>Select a profile in the sidebar and click Connect to open a terminal.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="terminal-container" style={{ position: 'relative' }}>
      {terminals.map((session) => {
        const isVisible = session.id === activeTerminalId
        return (
          <React.Fragment key={session.id}>
            <TerminalPane session={session} visible={isVisible} />
            {isVisible && (
              <div className={`context-breadcrumb ctx-${session.context}`}>
                {session.context === 'local' && 'LOCAL'}
                {session.context === 'ssh' && `SSH › ${session.title.split(' — ')[1] ?? ''}`}
                {session.context === 'container' && `CONTAINER › ${session.title.split(' — ')[1] ?? ''}`}
              </div>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
