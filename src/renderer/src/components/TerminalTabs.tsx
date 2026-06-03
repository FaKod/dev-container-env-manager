import React, { useState } from 'react'
import { SplitSquareHorizontal, SplitSquareVertical, Plus, X, LayoutGrid, Rows3, Anchor, ExternalLink, RefreshCw } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { cleanupTerminalInstance } from './TerminalView'
import { toast } from './Toast'
import type { TerminalContext, Profile } from '../../../shared/types'

// Mirrors the auto-color fallback used by ProfileCard so tabs match their card.
const AUTO_PALETTE = ['--blue', '--mauve', '--teal', '--peach', '--green', '--sapphire']
function profileColorVar(profile: Profile | undefined): string {
  if (profile?.color) return profile.color
  if (!profile) return '--overlay0'
  return AUTO_PALETTE[profile.name.charCodeAt(0) % AUTO_PALETTE.length]
}

export function TerminalTabs(): React.ReactElement {
  const terminals = useAppStore((s) => s.terminals)
  const activeTerminalId = useAppStore((s) => s.activeTerminalId)
  const splits = useAppStore((s) => s.splits)
  const detachedTerminalIds = useAppStore((s) => s.detachedTerminalIds)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const profiles = useAppStore((s) => s.profiles)
  const connections = useAppStore((s) => s.connections)
  const containers = useAppStore((s) => s.containers)
  const tileMode = useAppStore((s) => s.tileMode)
  const toggleTileMode = useAppStore((s) => s.toggleTileMode)
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal)
  const setActiveProfile = useAppStore((s) => s.setActiveProfile)
  const removeTerminal = useAppStore((s) => s.removeTerminal)
  const addTerminal = useAppStore((s) => s.addTerminal)
  const markTerminalRead = useAppStore((s) => s.markTerminalRead)
  const setSplitSession = useAppStore((s) => s.setSplitSession)
  const removeSplit = useAppStore((s) => s.removeSplit)
  const reorderTerminals = useAppStore((s) => s.reorderTerminals)

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const visibleTerminals = terminals.filter((t) => !detachedTerminalIds[t.id])

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

    // Auto-select a neighbouring tab when closing the active one
    if (activeTerminalId === terminalId) {
      const idx = visibleTerminals.findIndex((t) => t.id === terminalId)
      const remaining = visibleTerminals.filter((t) => t.id !== terminalId)
      const next = remaining[idx] ?? remaining[idx - 1]
      if (next) {
        setActiveTerminal(next.id)
        setActiveProfile(next.profileId)
      }
    }

    removeTerminal(terminalId)
  }

  async function handleDetachTab(
    e: React.MouseEvent,
    terminalId: string
  ): Promise<void> {
    e.stopPropagation()
    // If this terminal owns a split view, promote its companion to a regular
    // tab so it doesn't disappear when the primary leaves the main window.
    const split = splits[terminalId]
    if (split) {
      addTerminal(split.session)
      removeSplit(terminalId)
    }
    try {
      await window.api.detachTerminal(terminalId)
    } catch (err) {
      toast(`Failed to detach terminal: ${err}`)
    }
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

  async function handleReconnectAll(): Promise<void> {
    const exited = terminals.filter((t) => !t.active && !detachedTerminalIds[t.id])
    if (exited.length === 0) return

    function isReady(t: (typeof exited)[0]): boolean {
      if (t.context === 'local') return true
      if (connections[t.profileId]?.status !== 'connected') return false
      if (t.context === 'container' && containers[t.profileId]?.status !== 'running') return false
      return true
    }

    const ready = exited.filter(isReady)
    const blocked = exited.filter((t) => !isReady(t))

    // Kick off SSH reconnection for blocked profiles (fire-and-forget, deduplicated)
    const launched = new Set<string>()
    for (const t of blocked) {
      if (!launched.has(t.profileId)) {
        launched.add(t.profileId)
        window.api.launch(t.profileId).catch(() => {/* ConnectionManager surfaces errors */})
      }
    }
    if (blocked.length > 0) {
      toast('Reconnecting profile — click Reconnect All again when ready.')
    }

    let firstNewId: string | null = null
    for (const t of ready) {
      let session
      try {
        // Create BEFORE destroying: keeps the profile's terminal count > 0 so the
        // profileTerminalsEmpty auto-disconnect never fires between destroy and create.
        session = await window.api.createTerminal(t.profileId, t.context, 120, 36)
      } catch (err) {
        toast.error(`Failed to restart terminal: ${err}`)
        continue // leave the dead tab in place
      }
      addTerminal(session)
      if (firstNewId === null) firstNewId = session.id
      try {
        await window.api.destroyTerminal(t.id)
      } catch {
        // PTY already cleaned up — continue
      }
      removeTerminal(t.id)
    }

    if (firstNewId) setActiveTerminal(firstNewId)
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
      {!tileMode && visibleTerminals.map((t) => {
        const profile = profiles.find(p => p.id === t.profileId)
        const isPrimary =
          !!profile?.container &&
          (profile.container.terminalMode ?? 'smart') !== 'exec' &&
          terminals.find(other => other.profileId === t.profileId) === t
        const tabColor = profileColorVar(profile)
        return (
        <div
          key={t.id}
          className={[
            'terminal-tab',
            activeTerminalId === t.id ? 'active' : '',
            !t.active ? 'inactive' : '',
            draggingId === t.id ? 'dragging' : '',
            dragOverId === t.id && draggingId !== t.id ? 'drag-over' : '',
          ].filter(Boolean).join(' ')}
          onClick={() => handleTabClick(t.id, t.profileId)}
          title={t.title}
          style={{ ['--tab-color' as string]: `var(${tabColor})` }}
          draggable
          onDragStart={(e) => {
            setDraggingId(t.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnter={(e) => {
            e.preventDefault()
            if (draggingId && draggingId !== t.id) setDragOverId(t.id)
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (draggingId && draggingId !== t.id) reorderTerminals(draggingId, t.id)
            setDraggingId(null)
            setDragOverId(null)
          }}
          onDragEnd={() => {
            setDraggingId(null)
            setDragOverId(null)
          }}
        >
          <span
            className={`terminal-tab-context tab-ctx-${t.context}`}
            title={t.context}
          >
            {t.context === 'container' ? 'c' : t.context}
          </span>
          {isPrimary && (
            <Anchor size={10} style={{ flexShrink: 0, opacity: 0.6 }} title="Primary terminal — closing this will stop the container" />
          )}
          <span className="terminal-tab-title">{t.title}</span>
          {t.hasUnread && <span className="terminal-tab-unread" />}
          <button
            className="btn btn-icon"
            style={{ marginLeft: 4 }}
            onClick={(e) => handleDetachTab(e, t.id)}
            title="Detach into its own window"
          >
            <ExternalLink size={11} />
          </button>
          <button
            className="btn btn-icon"
            onClick={(e) => handleCloseTab(e, t.id)}
            title="Close terminal"
          >
            <X size={11} />
          </button>
        </div>
        )
      })}

      {!tileMode && activeTerminalId && !activeSplit && (
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

      {!tileMode && activeProfileId && (
        <div
          className="terminal-tabs-add"
          onClick={handleAddTab}
          title="Open new terminal for active profile"
        >
          <Plus size={14} />
        </div>
      )}

      {terminals.some((t) => !t.active) && (
        <div
          className="terminal-tabs-add"
          onClick={handleReconnectAll}
          title="Reconnect all exited terminals"
        >
          <RefreshCw size={14} />
        </div>
      )}

      {terminals.length > 0 && (
        <div
          className={`terminal-tabs-add${tileMode ? ' active' : ''}`}
          onClick={toggleTileMode}
          title={tileMode ? 'Switch to tab view' : 'Switch to tile view'}
          style={{ marginLeft: 'auto' }}
        >
          {tileMode ? <Rows3 size={14} /> : <LayoutGrid size={14} />}
        </div>
      )}
    </div>
  )
}
