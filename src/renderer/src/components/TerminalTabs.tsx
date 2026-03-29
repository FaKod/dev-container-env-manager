import React from 'react'
import { SplitSquareHorizontal, SplitSquareVertical, Plus, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { cleanupTerminalInstance } from './TerminalView'
import { toast } from './Toast'
import type { TerminalContext } from '../../../shared/types'

export function TerminalTabs(): React.ReactElement {
  const {
    terminals,
    activeTerminalId,
    splits,
    activeProfileId,
    profiles,
    connections,
    containers,
    setActiveTerminal,
    setActiveProfile,
    removeTerminal,
    addTerminal,
    markTerminalRead,
    setSplitSession,
    removeSplit
  } = useAppStore()

  const activeSplit = activeTerminalId ? splits[activeTerminalId] : undefined

  function checkReady(ctx: TerminalContext, profileId: string): boolean {
    if (ctx === 'local') return true
    if (connections[profileId]?.status !== 'connected') {
      toast('Profile is not connected.')
      return false
    }
    if (ctx === 'container' && containers[profileId]?.status !== 'running') {
      toast('Container is not running.')
      return false
    }
    return true
  }

  async function handleCloseTab(
    e: React.MouseEvent,
    terminalId: string
  ): Promise<void> {
    e.stopPropagation()
    // Also destroy the split PTY if this tab owns one
    if (splits[terminalId]) {
      const splitId = splits[terminalId].session.id
      await window.api.destroyTerminal(splitId)
      cleanupTerminalInstance(splitId)
      removeSplit(terminalId)
    }
    await window.api.destroyTerminal(terminalId)
    cleanupTerminalInstance(terminalId)
    removeTerminal(terminalId)
  }

  async function handleSplit(direction: 'vertical' | 'horizontal'): Promise<void> {
    if (!activeTerminalId || !activeProfileId) return
    const profile = profiles.find((p) => p.id === activeProfileId)
    if (!profile) return
    const ctx: TerminalContext = profile.terminal.defaultContext
    if (!checkReady(ctx, activeProfileId)) return
    try {
      const session = await window.api.createTerminal(activeProfileId, ctx, 120, 36)
      setSplitSession(activeTerminalId, session, direction)
    } catch (err) {
      toast(`Failed to split terminal: ${err}`)
    }
  }

  async function handleAddTab(): Promise<void> {
    if (!activeProfileId) return
    const profile = profiles.find((p) => p.id === activeProfileId)
    if (!profile) return
    const ctx: TerminalContext = profile.terminal.defaultContext
    if (!checkReady(ctx, activeProfileId)) return
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
            style={{ marginLeft: 4 }}
            onClick={(e) => handleCloseTab(e, t.id)}
            title="Close terminal"
          >
            <X size={11} />
          </button>
        </div>
      ))}

      {activeTerminalId && !activeSplit && (
        <>
          <div
            className="terminal-tabs-add"
            onClick={() => handleSplit('vertical')}
            title="Split vertical (new login)"
          >
            <SplitSquareHorizontal size={14} />
          </div>
          <div
            className="terminal-tabs-add"
            onClick={() => handleSplit('horizontal')}
            title="Split horizontal (new login)"
          >
            <SplitSquareVertical size={14} />
          </div>
        </>
      )}

      {activeProfileId && (
        <div
          className="terminal-tabs-add"
          onClick={handleAddTab}
          title="Open new terminal for active profile"
        >
          <Plus size={14} />
        </div>
      )}
    </div>
  )
}
