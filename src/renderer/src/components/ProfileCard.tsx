import React, { useState } from 'react'
import { Pencil, Copy, Trash2 } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { toast } from './Toast'
import { showConfirm } from './ConfirmModal'
import type { Profile } from '../../../shared/types'

const AVATAR_COLORS = ['--blue', '--mauve', '--teal', '--peach', '--green', '--sapphire']

interface Props {
  profile: Profile
}

export function ProfileCard({ profile }: Props): React.ReactElement {
  const {
    connections,
    activeProfileId,
    terminals,
    setActiveProfile,
    setActiveTerminal,
    setConnectionState,
    removeProfile,
    upsertProfile,
    addTerminal,
    markTerminalInactive,
    openProfileEditor
  } = useAppStore()

  const [busy, setBusy] = useState(false)
  const connState = connections[profile.id]
  const status = connState?.status ?? 'disconnected'

  const isConnected = status === 'connected' || status === 'degraded'
  const isConnecting = status === 'connecting' || status === 'reconnecting'

  async function handleConnect(): Promise<void> {
    setBusy(true)
    try {
      // SSH tunnel + container start/attach in one shot
      await window.api.launch(profile.id)
      setActiveProfile(profile.id)

      // Open container shell immediately (falls back to ssh if no container configured)
      const ctx = profile.container ? 'container' : 'ssh'
      const session = await window.api.createTerminal(profile.id, ctx, 120, 36)
      addTerminal(session)
      setActiveTerminal(session.id)
    } catch (err) {
      toast(`Connect failed: ${err}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleDisconnect(): Promise<void> {
    setBusy(true)
    try {
      await window.api.disconnect(profile.id)
      terminals
        .filter((t) => t.profileId === profile.id)
        .forEach((t) => markTerminalInactive(t.id))
    } finally {
      setBusy(false)
    }
  }

  function handleDelete(): void {
    showConfirm(`Delete profile "${profile.name}"?`, async () => {
      try {
        await window.api.deleteProfile(profile.id)
        removeProfile(profile.id)
      } catch (err) {
        toast(`Delete failed: ${err}`)
      }
    })
  }

  async function handleClone(): Promise<void> {
    try {
      const cloned = await window.api.cloneProfile(profile.id)
      upsertProfile(cloned)
    } catch (err) {
      toast(`Clone failed: ${err}`)
    }
  }

  function handleSelect(): void {
    setActiveProfile(profile.id)
    // Switch to first terminal of this profile if available
    const profileTerminals = terminals.filter((t) => t.profileId === profile.id)
    if (profileTerminals.length > 0) {
      setActiveTerminal(profileTerminals[0].id)
    }
  }

  const avatarColor = AVATAR_COLORS[profile.name.charCodeAt(0) % AVATAR_COLORS.length]

  return (
    <div
      className={[
        'profile-card',
        activeProfileId === profile.id ? 'active' : '',
        isConnected && activeProfileId !== profile.id ? 'connected-glow' : ''
      ].filter(Boolean).join(' ')}
      onClick={handleSelect}
      draggable
      onDragStart={(e) => {
        e.stopPropagation()
        e.dataTransfer.setData('text/plain', profile.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <div className="profile-card-header">
        <span
          className={[
            'profile-avatar',
            isConnected  ? 'avatar-connected'  : '',
            isConnecting ? 'avatar-connecting' : ''
          ].filter(Boolean).join(' ')}
          style={{ background: `var(${avatarColor})` }}
        >
          {profile.name[0].toUpperCase()}
        </span>
        <div className="profile-name" title={profile.name}>
          {profile.name}
        </div>
        <StatusBadge status={status} />
      </div>
      <div className="profile-host">{profile.ssh.host}</div>

      <div className="profile-card-actions" onClick={(e) => e.stopPropagation()}>
        {isConnected || isConnecting ? (
          <button
            className="btn btn-danger btn-sm"
            onClick={handleDisconnect}
            disabled={busy}
          >
            Disconnect
          </button>
        ) : (
          <button
            className="btn btn-success btn-sm"
            onClick={handleConnect}
            disabled={busy}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}

        <button
          className="btn btn-icon"
          onClick={() => openProfileEditor(profile.id)}
          title="Edit profile"
        >
          <Pencil size={12} />
        </button>

        <button
          className="btn btn-icon"
          onClick={handleClone}
          title="Clone profile"
        >
          <Copy size={12} />
        </button>

        <button
          className="btn btn-icon"
          onClick={handleDelete}
          title="Delete profile"
          style={{ marginLeft: 'auto' }}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const labels: Record<string, string> = {
    disconnected: 'Off',
    connecting: 'Connecting',
    connected: 'On',
    degraded: 'Degraded',
    reconnecting: 'Reconnect',
    failed: 'Failed'
  }
  return (
    <span className={`status-badge ${status}`}>
      <span className="dot" />
      {labels[status] ?? status}
    </span>
  )
}
