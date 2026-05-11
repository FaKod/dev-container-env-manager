import React, { useEffect, useState } from 'react'
import { Anchor } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { TerminalPane } from './TerminalView'
import { ToastContainer, toast } from './Toast'
import type { TerminalSession } from '../../../shared/types'

interface Props {
  terminalId: string
}

export function DetachedTerminalApp({ terminalId }: Props): React.ReactElement {
  const setProfiles = useAppStore((s) => s.setProfiles)
  const theme = useAppStore((s) => s.theme)
  const sessionTitle = useAppStore(
    (s) => s.terminals.find((t) => t.id === terminalId)?.title ?? ''
  )

  const [session, setSession] = useState<TerminalSession | null>(null)
  const [exited, setExited] = useState(false)

  // Apply theme to documentElement so xterm picks up the right palette
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Window title mirrors the terminal title (OSC sequence updates via TerminalPane)
  useEffect(() => {
    document.title = sessionTitle || 'Detached terminal'
  }, [sessionTitle])

  // Bootstrap: load profiles + locate the session this window owns
  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.getProfiles(),
      window.api.getTerminalSessions()
    ])
      .then(([profiles, sessions]) => {
        if (cancelled) return
        setProfiles(profiles)
        const s = sessions.find((t) => t.id === terminalId)
        if (!s) {
          toast('Terminal not found — close this window.')
          return
        }
        // Seed the store with the single terminal we're hosting so TerminalPane
        // (and its title/unread helpers) can read it via useAppStore.
        useAppStore.setState({ terminals: [s], activeTerminalId: s.id })
        setSession(s)
      })
      .catch((err) => toast(`Failed to load terminal: ${err}`))
    return () => { cancelled = true }
  }, [terminalId])

  // Track PTY exit so we can disable the Attach button
  useEffect(() => {
    const unsub = window.api.onTerminalExited((id) => {
      if (id === terminalId) setExited(true)
    })
    return () => unsub()
  }, [terminalId])

  async function handleAttach(): Promise<void> {
    try {
      await window.api.attachTerminal(terminalId)
      // Main process will close this window once the retargeting is done.
    } catch (err) {
      toast(`Failed to re-attach: ${err}`)
    }
  }

  if (!session) {
    return (
      <div className="detached-terminal-window">
        <div className="empty-state" style={{ fontSize: 13 }}>Loading terminal…</div>
        <ToastContainer />
      </div>
    )
  }

  return (
    <div className="detached-terminal-window">
      <div className="detached-terminal-toolbar">
        <span className={`terminal-tab-context tab-ctx-${session.context}`}>
          {session.context}
        </span>
        <span className="detached-terminal-title">{sessionTitle}</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleAttach}
          disabled={exited}
          title={exited ? 'Terminal has exited — just close the window' : 'Re-attach to main window'}
        >
          <Anchor size={13} />
          <span>Attach</span>
        </button>
      </div>
      <div className="detached-terminal-body">
        <TerminalPane session={session} visible={true} />
      </div>
      <ToastContainer />
    </div>
  )
}
