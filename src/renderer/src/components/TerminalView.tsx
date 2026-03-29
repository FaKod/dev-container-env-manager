import React, { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as TerminalIcon, ChevronUp, ChevronDown, X as XIcon } from 'lucide-react'
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
      selectionBackground: 'rgba(30,102,245,0.22)',
      selectionForeground: '#4c4f69',
      selectionInactiveBackground: 'rgba(30,102,245,0.12)',
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

export function applyFontSize(size: number): void {
  terminalFontSize = Math.max(8, Math.min(28, size))
  for (const inst of terminalInstances.values()) {
    inst.xterm.options.fontSize = terminalFontSize
    requestAnimationFrame(() => inst.fitAddon.fit())
  }
}

export const increaseFontSize = (): void => applyFontSize(terminalFontSize + 1)
export const decreaseFontSize = (): void => applyFontSize(terminalFontSize - 1)
export const resetFontSize    = (): void => applyFontSize(13)

// ── Keep xterm instances alive across renders, keyed by terminal ID ────────────
const terminalInstances = new Map<
  string,
  { xterm: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon }
>()

export function cleanupTerminalInstance(id: string): void {
  const inst = terminalInstances.get(id)
  if (inst) {
    inst.xterm.dispose()
    terminalInstances.delete(id)
  }
}

function createXterm(
  container: HTMLElement,
  terminalId: string,
  onData: (data: string) => void,
  onOpenFind: () => void,
  onTitleChange: (title: string) => void
): { xterm: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon } {
  const mode = (document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark'
  const xterm = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: terminalFontSize,
    lineHeight: 1.4,
    scrollback: 5000,
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

  // OSC 0 = set icon name + title; OSC 2 = set title only — both used by common shells/PS1
  xterm.parser.registerOscHandler(0, (data) => { onTitleChange(data); return true })
  xterm.parser.registerOscHandler(2, (data) => { onTitleChange(data); return true })

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
    // Font size: Ctrl+= / Ctrl++ to increase ('+' requires Shift on most keyboards)
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
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
  const { markTerminalInactive, markTerminalUnread, markTerminalRead, setTerminalTitle } = useAppStore()
  const profileName = useAppStore((s) => s.profiles.find((p) => p.id === session.profileId)?.name ?? '')
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
      createXterm(containerRef.current, session.id, handleData, () => setFindOpen(true), (title) => setTerminalTitle(session.id, profileName ? `${profileName}: ${title}` : title))
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

  // Handle window/pane resize — debounced via rAF to avoid rapid-fire IPC
  useEffect(() => {
    if (!visible) return
    let rafId = 0
    const handleResize = (): void => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const inst = terminalInstances.get(session.id)
        if (!inst) return
        inst.fitAddon.fit()
        window.api.terminalResize(session.id, inst.xterm.cols, inst.xterm.rows)
      })
    }
    const observer = new ResizeObserver(handleResize)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => { observer.disconnect(); cancelAnimationFrame(rafId) }
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
          <button className="btn btn-icon" onClick={findPrev} title="Previous (Shift+Enter)"><ChevronUp size={13} /></button>
          <button className="btn btn-icon" onClick={findNext} title="Next (Enter)"><ChevronDown size={13} /></button>
          <button className="btn btn-icon" onClick={closeFind} title="Close (Esc)"><XIcon size={13} /></button>
        </div>
      )}
    </div>
  )
}

// ── TerminalView ───────────────────────────────────────────────────────────────

function fitAll(ids: string[]): void {
  for (const id of ids) {
    const inst = terminalInstances.get(id)
    if (!inst) continue
    requestAnimationFrame(() => {
      inst.fitAddon.fit()
      window.api.terminalResize(id, inst.xterm.cols, inst.xterm.rows)
    })
  }
}

// ── Tile grid view ─────────────────────────────────────────────────────────────

function TileGrid(): React.ReactElement {
  const terminals = useAppStore((s) => s.terminals)
  const containerRef = useRef<HTMLDivElement>(null)
  // Array of column container DOM refs (populated via ref callbacks)
  const colRefs = useRef<(HTMLDivElement | null)[]>([])

  const numCols = terminals.length <= 1 ? 1 : terminals.length <= 4 ? 2 : 3

  // Assign terminals to columns: t0→col0, t1→col1, t2→col0, …
  const columns: TerminalSession[][] = Array.from({ length: numCols }, () => [])
  terminals.forEach((t, i) => columns[i % numCols].push(t))

  const [colRatios, setColRatios] = useState<number[]>(() => Array(numCols).fill(1))
  const [rowRatios, setRowRatios] = useState<number[][]>(() =>
    columns.map((col) => Array(col.length).fill(1))
  )

  // Reset ratios when terminal count or column count changes
  useEffect(() => {
    setColRatios(Array(numCols).fill(1))
    setRowRatios(Array.from({ length: numCols }, (_, i) => {
      const len = Math.ceil(terminals.length / numCols) - (i >= terminals.length % numCols && terminals.length % numCols !== 0 ? 1 : 0)
      return Array(Math.max(1, len)).fill(1)
    }))
    colRefs.current = Array(numCols).fill(null)
  }, [terminals.length, numCols])

  // Re-fit all on entry and when count changes
  useEffect(() => {
    const id = setTimeout(() => fitAll(terminals.map((t) => t.id)), 50)
    return () => clearTimeout(id)
  }, [terminals.length])

  function handleColDivider(e: React.MouseEvent, divIdx: number): void {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    // Snapshot ratios at drag start to avoid stale closure issues
    const captured = [...colRatios]
    const totalFr  = captured.reduce((a, b) => a + b, 0)
    const leftFr   = captured.slice(0, divIdx).reduce((a, b) => a + b, 0)
    const pairFr   = captured[divIdx] + captured[divIdx + 1]

    const onMouseMove = (ev: MouseEvent): void => {
      const leftPx  = (leftFr / totalFr) * rect.width
      const pairPx  = (pairFr / totalFr) * rect.width
      const ratio   = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left - leftPx) / pairPx))
      const next    = [...captured]
      next[divIdx]      = pairFr * ratio
      next[divIdx + 1]  = pairFr * (1 - ratio)
      setColRatios(next)
      fitAll(terminals.map((t) => t.id))
    }
    const onMouseUp = (): void => window.removeEventListener('mousemove', onMouseMove)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp, { once: true })
  }

  function handleRowDivider(e: React.MouseEvent, colIdx: number, divIdx: number): void {
    e.preventDefault()
    const colEl = colRefs.current[colIdx]
    if (!colEl) return
    const rect      = colEl.getBoundingClientRect()
    const captured  = [...(rowRatios[colIdx] ?? [])]
    const totalFr   = captured.reduce((a, b) => a + b, 0)
    const topFr     = captured.slice(0, divIdx).reduce((a, b) => a + b, 0)
    const pairFr    = captured[divIdx] + captured[divIdx + 1]

    const onMouseMove = (ev: MouseEvent): void => {
      const topPx  = (topFr / totalFr) * rect.height
      const pairPx = (pairFr / totalFr) * rect.height
      const ratio  = Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top - topPx) / pairPx))
      const nextCol = [...captured]
      nextCol[divIdx]     = pairFr * ratio
      nextCol[divIdx + 1] = pairFr * (1 - ratio)
      const next = [...rowRatios]
      next[colIdx] = nextCol
      setRowRatios(next)
      fitAll(terminals.map((t) => t.id))
    }
    const onMouseUp = (): void => window.removeEventListener('mousemove', onMouseMove)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp, { once: true })
  }

  const totalColFr = colRatios.reduce((a, b) => a + b, 0)

  return (
    <div ref={containerRef} className="terminal-tile-grid-flex">
      {columns.map((colTerminals, colIdx) => {
        const rows    = rowRatios[colIdx] ?? colTerminals.map(() => 1)
        const totalRowFr = rows.reduce((a, b) => a + b, 0)
        return (
          <React.Fragment key={colIdx}>
            <div
              ref={(el) => { colRefs.current[colIdx] = el }}
              className="terminal-tile-col"
              style={{ flex: `${(colRatios[colIdx] ?? 1) / totalColFr} 0 0` }}
            >
              {colTerminals.map((session, rowIdx) => (
                <React.Fragment key={session.id}>
                  <div
                    className="terminal-tile"
                    style={{ flex: `${(rows[rowIdx] ?? 1) / totalRowFr} 0 0` }}
                  >
                    <div className="terminal-tile-header">
                      <span className={`terminal-tile-ctx tab-ctx-${session.context}`}>{session.context}</span>
                      <span className="terminal-tile-title">{session.title}</span>
                    </div>
                    <div className="terminal-tile-body">
                      <TerminalPane session={session} visible={true} />
                    </div>
                  </div>
                  {rowIdx < colTerminals.length - 1 && (
                    <div
                      className="terminal-split-divider terminal-split-divider-h"
                      onMouseDown={(e) => handleRowDivider(e, colIdx, rowIdx)}
                    />
                  )}
                </React.Fragment>
              ))}
            </div>
            {colIdx < columns.length - 1 && (
              <div
                className="terminal-split-divider"
                onMouseDown={(e) => handleColDivider(e, colIdx)}
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

export function TerminalView(): React.ReactElement {
  const { terminals, activeTerminalId, splits, removeSplit, theme, tileMode } = useAppStore()
  const activeSplit = activeTerminalId ? splits[activeTerminalId] : undefined
  const splitSession = activeSplit?.session ?? null
  const splitDirection = activeSplit?.direction ?? 'vertical'
  const [splitRatio, setSplitRatio] = useState(0.5)
  const containerRef = useRef<HTMLDivElement>(null)

  // Update all open terminal themes when the theme changes
  useEffect(() => {
    const t = xtermTheme(theme)
    for (const inst of terminalInstances.values()) {
      inst.xterm.options.theme = t
    }
  }, [theme])

  // Re-fit all terminals when exiting tile mode (returning to tab view)
  useEffect(() => {
    if (!tileMode && activeTerminalId) {
      const ids = splitSession ? [activeTerminalId, splitSession.id] : [activeTerminalId]
      setTimeout(() => fitAll(ids), 50)
    }
  }, [tileMode])

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()

      const onMouseMove = (ev: MouseEvent): void => {
        const ratio = splitDirection === 'vertical'
          ? Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width))
          : Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height))
        setSplitRatio(ratio)
        if (activeTerminalId) fitAll([activeTerminalId])
        if (splitSession) fitAll([splitSession.id])
      }

      const onMouseUp = (): void => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [activeTerminalId, splitSession, splitDirection]
  )

  async function handleCloseSplit(): Promise<void> {
    if (!splitSession || !activeTerminalId) return
    await window.api.destroyTerminal(splitSession.id)
    cleanupTerminalInstance(splitSession.id)
    removeSplit(activeTerminalId)
  }

  const activeSession = terminals.find((t) => t.id === activeTerminalId)

  if (terminals.length === 0) {
    return (
      <div className="terminal-container">
        <div className="terminal-empty">
          <TerminalIcon size={48} className="terminal-empty-icon" />
          <h2>No terminal open</h2>
          <p>Select a profile in the sidebar and click Connect to open a terminal.</p>
        </div>
      </div>
    )
  }

  if (tileMode) {
    return (
      <div className="terminal-container" style={{ overflow: 'hidden' }}>
        <TileGrid />
      </div>
    )
  }

  const isSplit = !!(activeSession && splitSession)

  return (
    <div className="terminal-container" ref={containerRef} style={{ position: 'relative' }}>
      {isSplit ? (
        <div
          className="terminal-split-container"
          style={{ flexDirection: splitDirection === 'vertical' ? 'row' : 'column' }}
        >
          <div className="terminal-split-pane" style={{ flex: `${splitRatio} 0 0` }}>
            <TerminalPane session={activeSession} visible={true} />
            <div className={`context-breadcrumb ctx-${activeSession.context}`}>
              {activeSession.context.toUpperCase()}
            </div>
          </div>
          <div
            className={`terminal-split-divider${splitDirection === 'horizontal' ? ' terminal-split-divider-h' : ''}`}
            onMouseDown={handleDividerMouseDown}
          />
          <div className="terminal-split-pane" style={{ flex: `${1 - splitRatio} 0 0` }}>
            <TerminalPane session={splitSession} visible={true} />
            <div className={`context-breadcrumb ctx-${splitSession.context}`}>
              {splitSession.context.toUpperCase()}
            </div>
            <button className="terminal-split-close" onClick={handleCloseSplit} title="Close split">✕</button>
          </div>
        </div>
      ) : (
        terminals.map((session) => {
          const isVisible = session.id === activeTerminalId
          return (
            <React.Fragment key={session.id}>
              <TerminalPane session={session} visible={isVisible} />
              {isVisible && (
                <div className={`context-breadcrumb ctx-${session.context}`}>
                  {session.context.toUpperCase()}
                </div>
              )}
            </React.Fragment>
          )
        })
      )}
    </div>
  )
}
