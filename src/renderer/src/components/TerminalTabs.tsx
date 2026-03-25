import React from 'react'
import { useAppStore } from '../store/useAppStore'
import { toast } from './Toast'
import type { TerminalContext } from '../../../shared/types'

export function TerminalTabs(): React.ReactElement {
  const {
    terminals,
    activeTerminalId,
    splitSession,
    activeProfileId,
    profiles,
    setActiveTerminal,
    setActiveProfile,
    removeTerminal,
    addTerminal,
    markTerminalRead,
    setSplitSession
  } = useAppStore()

  async function handleCloseTab(
    e: React.MouseEvent,
    terminalId: string
  ): Promise<void> {
    e.stopPropagation()
    await window.api.destroyTerminal(terminalId)
    removeTerminal(terminalId)
  }

  async function handleSplit(direction: 'vertical' | 'horizontal'): Promise<void> {
    if (!activeTerminalId || !activeProfileId) return
    const profile = profiles.find((p) => p.id === activeProfileId)
    if (!profile) return
    const ctx: TerminalContext = profile.terminal.defaultContext
    try {
      const session = await window.api.createTerminal(activeProfileId, ctx, 120, 36)
      // Do NOT add to terminals[] — split sessions are hidden from the tab bar
      setSplitSession(session, direction)
    } catch (err) {
      toast(`Failed to split terminal: ${err}`)
    }
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

  async function handleTabClick(terminalId: string, profileId: string): Promise<void> {
    // Destroy the split session's PTY when switching tabs
    if (splitSession) {
      await window.api.destroyTerminal(splitSession.id)
      setSplitSession(null)
    }
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

      {activeTerminalId && !splitSession && (
        <>
          <div
            className="terminal-tabs-add"
            onClick={() => handleSplit('vertical')}
            title="Split vertical (new login)"
          >
            ⊢
          </div>
          <div
            className="terminal-tabs-add"
            onClick={() => handleSplit('horizontal')}
            title="Split horizontal (new login)"
          >
            ⊤
          </div>
        </>
      )}

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
