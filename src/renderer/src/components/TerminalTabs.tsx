import React from 'react'
import { useAppStore } from '../store/useAppStore'
import { toast } from './Toast'
import type { TerminalContext } from '../../../shared/types'

export function TerminalTabs(): React.ReactElement {
  const {
    terminals,
    activeTerminalId,
    activeProfileId,
    profiles,
    setActiveTerminal,
    setActiveProfile,
    removeTerminal,
    addTerminal,
    markTerminalRead
  } = useAppStore()

  async function handleCloseTab(
    e: React.MouseEvent,
    terminalId: string
  ): Promise<void> {
    e.stopPropagation()
    await window.api.destroyTerminal(terminalId)
    removeTerminal(terminalId)
  }

  async function handleAddTab(): Promise<void> {
    if (!activeProfileId) return
    const profile = profiles.find((p) => p.id === activeProfileId)
    if (!profile) return
    const ctx: TerminalContext = profile.terminal.defaultContext
    try {
      const session = await window.api.createTerminal(activeProfileId, ctx, 120, 36)
      addTerminal(session)
      setActiveTerminal(session.id)
    } catch (err) {
      toast(`Failed to open terminal: ${err}`)
    }
  }

  function handleTabClick(terminalId: string, profileId: string): void {
    setActiveTerminal(terminalId)
    setActiveProfile(profileId)
    markTerminalRead(terminalId)
  }

  return (
    <div className="terminal-tabs">
      {terminals.map((t) => (
        <div
          key={t.id}
          className={`terminal-tab${activeTerminalId === t.id ? ' active' : ''}${!t.active ? ' inactive' : ''}`}
          onClick={() => handleTabClick(t.id, t.profileId)}
          title={t.title}
        >
          <span className={`terminal-tab-context tab-ctx-${t.context}`}>
            {t.context}
          </span>
          <span className="terminal-tab-title">{t.title}</span>
          {t.hasUnread && <span className="terminal-tab-unread" />}
          <button
            className="btn btn-icon"
            style={{ padding: '0 2px', fontSize: 11, marginLeft: 4 }}
            onClick={(e) => handleCloseTab(e, t.id)}
            title="Close terminal"
          >
            ×
          </button>
        </div>
      ))}

      {activeProfileId && (
        <div
          className="terminal-tabs-add"
          onClick={handleAddTab}
          title="Open new terminal for active profile"
        >
          +
        </div>
      )}
    </div>
  )
}
