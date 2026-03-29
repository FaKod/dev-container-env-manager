import React, { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import { toast } from './Toast'
import { showConfirm } from './ConfirmModal'
import type { Profile, PortForward } from '../../../shared/types'

type DraftProfile = Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>

function emptyDraft(): DraftProfile {
  return {
    name: '',
    ssh: {
      host: '',
      user: '',
      port: undefined,
      identityFile: '',
      forwards: [],
      keepalive: true
    },
    terminal: {
      presentation: 'tab',
      defaultContext: 'container',
      keepVisibleWhenDisconnected: true
    },
    container: {
      name: '',
      image: '',
      runtime: '',
      ports: [],
      workspaceMount: { localPath: '${cwd}', containerPath: '/workspace' },
      workdir: '/workspace',
      interactive: true
    },
    connectionPolicy: {
      autoReconnect: true,
      preventDuplicateConnections: true,
      existingContainerBehavior: 'attach-or-recreate',
      reconnectDelay: 3000,
      maxReconnectAttempts: 5
    },
    workspace: { localPath: '', recentPaths: [] }
  }
}

function profileToDraft(p: Profile): DraftProfile {
  return {
    name: p.name,
    ssh: { ...p.ssh, forwards: [...(p.ssh.forwards ?? [])] },
    terminal: { ...p.terminal },
    container: p.container
      ? {
          ...p.container,
          ports: [...(p.container.ports ?? [])],
          env: p.container.env ? { ...p.container.env } : undefined
        }
      : emptyDraft().container,
    connectionPolicy: { ...p.connectionPolicy },
    workspace: p.workspace ? { ...p.workspace } : {}
  }
}

export function ProfileEditor(): React.ReactElement {
  const { editingProfileId, profiles, closeProfileEditor, upsertProfile } = useAppStore()

  const existing = editingProfileId
    ? profiles.find((p) => p.id === editingProfileId)
    : undefined

  const [draft, setDraft] = useState<DraftProfile>(
    existing ? profileToDraft(existing) : emptyDraft()
  )
  const [activeTab, setActiveTab] = useState<'general' | 'ssh' | 'container' | 'policy'>('general')
  const [saving, setSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (existing) setDraft(profileToDraft(existing))
  }, [editingProfileId])

  // Focus the first input after the modal has painted — more reliable than autoFocus
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      firstInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [])

  function set<K extends keyof DraftProfile>(key: K, value: DraftProfile[K]): void {
    setDraft((d) => {
      const next = { ...d, [key]: value }
      // Keep container name in sync with profile name unless manually diverged
      if (key === 'name' && d.container && d.container.name === d.name) {
        next.container = { ...d.container, name: value as string }
      }
      return next
    })
    setIsDirty(true)
  }

  async function handleSave(): Promise<void> {
    if (!draft.name.trim()) { toast('Profile name is required'); return }
    if (!draft.ssh.host.trim()) { toast('SSH host is required'); return }

    setSaving(true)
    try {
      // Ensure container name always falls back to profile name
      const finalDraft = draft.container && !draft.container.name.trim()
        ? { ...draft, container: { ...draft.container, name: draft.name.trim() } }
        : draft

      if (existing) {
        const updated = await window.api.updateProfile(existing.id, finalDraft)
        upsertProfile(updated)
      } else {
        const created = await window.api.createProfile(finalDraft)
        upsertProfile(created)
      }
      setIsDirty(false)
      closeProfileEditor()
    } catch (err) {
      toast(`Save failed: ${err}`)
    } finally {
      setSaving(false)
    }
  }

  function handleClose(): void {
    if (isDirty) {
      showConfirm('Discard unsaved changes?', closeProfileEditor)
    } else {
      closeProfileEditor()
    }
  }

  function handleOverlayClick(e: React.MouseEvent): void {
    if (e.target === e.currentTarget) handleClose()
  }

  const tabs = ['general', 'ssh', 'container', 'policy'] as const

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <h2>{existing ? `Edit — ${existing.name}` : 'New Profile'}</h2>
          <button className="btn btn-icon" onClick={handleClose}>✕</button>
        </div>

        {/* Tab navigation */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--surface0)', padding: '0 20px' }}>
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: activeTab === t ? '2px solid var(--blue)' : '2px solid transparent',
                padding: '8px 12px',
                cursor: 'pointer',
                color: activeTab === t ? 'var(--text)' : 'var(--overlay1)',
                fontSize: 12,
                fontWeight: 500,
                textTransform: 'capitalize'
              }}
            >
              {t === 'ssh' ? 'SSH' : t}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {activeTab === 'general' && (
            <GeneralTab draft={draft} onChange={set} firstInputRef={firstInputRef} />
          )}
          {activeTab === 'ssh' && (
            <SSHTab draft={draft} onChange={set} />
          )}
          {activeTab === 'container' && (
            <ContainerTab draft={draft} onChange={set} />
          )}
          {activeTab === 'policy' && (
            <PolicyTab draft={draft} onChange={set} />
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={handleClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Profile'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Tab components ────────────────────────────────────────────────────────────

interface TabProps {
  draft: DraftProfile
  onChange: <K extends keyof DraftProfile>(key: K, value: DraftProfile[K]) => void
  firstInputRef?: React.RefObject<HTMLInputElement>
}

function GeneralTab({ draft, onChange, firstInputRef }: TabProps): React.ReactElement {
  const [detecting, setDetecting] = useState(false)

  function addForward(): void {
    onChange('ssh', {
      ...draft.ssh,
      forwards: [...draft.ssh.forwards, { localPort: 3000, remoteHost: 'localhost', remotePort: 3000, containerPort: 3000 }]
    })
  }

  function removeForward(i: number): void {
    onChange('ssh', {
      ...draft.ssh,
      forwards: draft.ssh.forwards.filter((_, idx) => idx !== i)
    })
  }

  function updateForward(i: number, fwd: PortForward): void {
    const hostPort = fwd.localPort
    const containerPort = fwd.containerPort ?? fwd.remotePort
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
      toast('Host port must be an integer between 1 and 65535')
      return
    }
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      toast('Container port must be an integer between 1 and 65535')
      return
    }
    const fwds = [...draft.ssh.forwards]
    fwds[i] = fwd
    onChange('ssh', { ...draft.ssh, forwards: fwds })
  }

  async function autoDetectPorts(): Promise<void> {
    const image = draft.container?.image?.trim()
    if (!image) { toast('Set the container image first (Container tab)'); return }
    if (!draft.ssh.host?.trim()) { toast('Set the SSH host first'); return }
    setDetecting(true)
    try {
      const ports = await window.api.detectContainerPorts(
        draft.ssh.host,
        draft.ssh.user || undefined,
        draft.ssh.port,
        draft.ssh.identityFile || undefined,
        image
      )
      if (ports.length === 0) {
        toast('No EXPOSE ports found in image', 'info')
        return
      }
      onChange('ssh', {
        ...draft.ssh,
        forwards: ports.map((p) => ({ localPort: p, remoteHost: 'localhost', remotePort: p, containerPort: p }))
      })
      toast(`Detected ${ports.length} port(s): ${ports.join(', ')}`, 'info')
    } catch (err) {
      toast(`Port detection failed: ${err}`)
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="form-section">
      <div className="form-section-title">General</div>
      <div className="form-group">
        <label>Profile Name *</label>
        <input
          ref={firstInputRef}
          className="form-control"
          value={draft.name}
          onChange={(e) => onChange('name', e.target.value)}
          placeholder="e.g. aiact-anthropic"
        />
      </div>

      <div className="form-section-title" style={{ marginTop: 8 }}>
        Port Forwards
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={addForward}>
          + Add
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: 4 }}
          onClick={autoDetectPorts}
          disabled={detecting}
          title="Detect EXPOSE ports from container image"
        >
          {detecting ? 'Detecting…' : 'Auto-detect'}
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--overlay1)', marginBottom: 6 }}>
        Host port: used as the SSH local/remote port (<code>-L n:localhost:n</code>) and the Docker host port (<code>-p host:container</code>).
        Container port: the port inside the container.
      </div>
      {draft.ssh.forwards.map((fwd, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
          <div className="form-group" style={{ maxWidth: 110, marginBottom: 0 }}>
            <label>Host port</label>
            <input
              className="form-control"
              type="number"
              value={fwd.localPort}
              onChange={(e) => {
                const port = Number(e.target.value)
                updateForward(i, { ...fwd, localPort: port, remotePort: port })
              }}
              placeholder="3000"
            />
          </div>
          <div className="form-group" style={{ maxWidth: 110, marginBottom: 0 }}>
            <label>Container port</label>
            <input
              className="form-control"
              type="number"
              value={fwd.containerPort ?? fwd.remotePort}
              onChange={(e) => {
                const port = Number(e.target.value)
                updateForward(i, { ...fwd, containerPort: port })
              }}
              placeholder="3000"
            />
          </div>
          <button className="btn btn-icon" style={{ marginBottom: 2 }} onClick={() => removeForward(i)}>
            ✕
          </button>
        </div>
      ))}

      <div className="form-section-title" style={{ marginTop: 8 }}>Terminal</div>
      <div className="form-row">
        <div className="form-group">
          <label>Default Context</label>
          <select
            className="form-control"
            value={draft.terminal.defaultContext}
            onChange={(e) =>
              onChange('terminal', {
                ...draft.terminal,
                defaultContext: e.target.value as 'local' | 'ssh' | 'container'
              })
            }
          >
            <option value="local">Local shell</option>
            <option value="ssh">SSH shell</option>
            <option value="container">Container shell</option>
          </select>
        </div>
        <div className="form-group">
          <label>Presentation</label>
          <select
            className="form-control"
            value={draft.terminal.presentation}
            onChange={(e) =>
              onChange('terminal', {
                ...draft.terminal,
                presentation: e.target.value as 'tab' | 'window' | 'pane'
              })
            }
          >
            <option value="tab">Tab</option>
            <option value="window">Window</option>
            <option value="pane">Pane</option>
          </select>
        </div>
      </div>
      <div className="form-group">
        <label style={{ flexDirection: 'row', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={draft.terminal.keepVisibleWhenDisconnected ?? true}
            onChange={(e) =>
              onChange('terminal', {
                ...draft.terminal,
                keepVisibleWhenDisconnected: e.target.checked
              })
            }
          />
          Keep terminal visible when disconnected
        </label>
      </div>
    </div>
  )
}

function SSHTab({ draft, onChange }: TabProps): React.ReactElement {
  function updateSSH<K extends keyof typeof draft.ssh>(
    key: K,
    value: (typeof draft.ssh)[K]
  ): void {
    onChange('ssh', { ...draft.ssh, [key]: value })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">SSH Connection</div>
      <div className="form-row">
        <div className="form-group" style={{ flex: 3 }}>
          <label>Host / SSH Alias *</label>
          <input
            className="form-control mono"
            value={draft.ssh.host}
            onChange={(e) => updateSSH('host', e.target.value)}
            placeholder="spark-7406.tail845a53.ts.net"
          />
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Port</label>
          <input
            className="form-control"
            type="number"
            value={draft.ssh.port ?? ''}
            onChange={(e) =>
              updateSSH('port', e.target.value ? Number(e.target.value) : undefined)
            }
            placeholder="22"
          />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Username</label>
          <input
            className="form-control"
            value={draft.ssh.user ?? ''}
            onChange={(e) => updateSSH('user', e.target.value || undefined)}
            placeholder="(from ~/.ssh/config)"
          />
        </div>
        <div className="form-group">
          <label>Identity File</label>
          <input
            className="form-control mono"
            value={draft.ssh.identityFile ?? ''}
            onChange={(e) =>
              updateSSH('identityFile', e.target.value || undefined)
            }
            placeholder="~/.ssh/id_ed25519"
          />
        </div>
      </div>
      <div className="form-group">
        <label style={{ flexDirection: 'row', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={draft.ssh.keepalive ?? true}
            onChange={(e) => updateSSH('keepalive', e.target.checked)}
          />
          Enable SSH keepalive (ServerAliveInterval=30)
        </label>
      </div>
    </div>
  )
}

function ContainerTab({ draft, onChange }: TabProps): React.ReactElement {
  const c = draft.container!

  function updateContainer<K extends keyof typeof c>(
    key: K,
    value: (typeof c)[K]
  ): void {
    onChange('container', { ...c, [key]: value })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Container</div>
      <div className="form-row">
        <div className="form-group">
          <label>Shell</label>
          <input
            className="form-control mono"
            value={c.shell ?? ''}
            onChange={(e) => updateContainer('shell', e.target.value || undefined)}
            placeholder="bash"
          />
        </div>
        <div className="form-group">
          <label>Runtime</label>
          <input
            className="form-control"
            value={c.runtime ?? ''}
            onChange={(e) => updateContainer('runtime', e.target.value || undefined)}
            placeholder="sysbox-runc (optional)"
          />
        </div>
      </div>
      <div className="form-group">
        <label>Image</label>
        <input
          className="form-control mono"
          value={c.image}
          onChange={(e) => updateContainer('image', e.target.value)}
          placeholder="quay.io/innoq/claude-dind:latest"
        />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Workspace Mount (local path)</label>
          <input
            className="form-control mono"
            value={c.workspaceMount?.localPath ?? ''}
            onChange={(e) =>
              updateContainer('workspaceMount', {
                ...(c.workspaceMount ?? { containerPath: '/workspace' }),
                localPath: e.target.value
              })
            }
            placeholder="${cwd}"
          />
        </div>
        <div className="form-group">
          <label>Container Path</label>
          <input
            className="form-control mono"
            value={c.workspaceMount?.containerPath ?? '/workspace'}
            onChange={(e) =>
              updateContainer('workspaceMount', {
                ...(c.workspaceMount ?? { localPath: '${cwd}' }),
                containerPath: e.target.value
              })
            }
            placeholder="/workspace"
          />
        </div>
      </div>
      <div className="form-group">
        <label>Working Directory</label>
        <input
          className="form-control mono"
          value={c.workdir ?? ''}
          onChange={(e) => updateContainer('workdir', e.target.value)}
          placeholder="/workspace"
        />
      </div>
      <div className="form-group">
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={c.interactive ?? true}
            onChange={(e) => updateContainer('interactive', e.target.checked)}
          />
          Interactive / allocate TTY
        </label>
      </div>
      <div style={{ fontSize: 11, color: 'var(--overlay1)', marginTop: 8 }}>
        Port mappings (<code>-p</code>) are derived automatically from the ports configured on the General tab.
      </div>
    </div>
  )
}

function PolicyTab({ draft, onChange }: TabProps): React.ReactElement {
  const p = draft.connectionPolicy

  function updatePolicy<K extends keyof typeof p>(
    key: K,
    value: (typeof p)[K]
  ): void {
    onChange('connectionPolicy', { ...p, [key]: value })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Connection Policy</div>
      <div className="form-group">
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={p.autoReconnect ?? true}
            onChange={(e) => updatePolicy('autoReconnect', e.target.checked)}
          />
          Auto-reconnect on disconnect
        </label>
      </div>
      <div className="form-group">
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={p.autoConnectOnStart ?? false}
            onChange={(e) => updatePolicy('autoConnectOnStart', e.target.checked)}
          />
          Auto-connect on app startup
        </label>
      </div>
      <div className="form-group">
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={p.preventDuplicateConnections ?? true}
            onChange={(e) => updatePolicy('preventDuplicateConnections', e.target.checked)}
          />
          Prevent duplicate connections
        </label>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Reconnect Delay (ms)</label>
          <input
            className="form-control"
            type="number"
            value={p.reconnectDelay ?? 3000}
            onChange={(e) => updatePolicy('reconnectDelay', Number(e.target.value))}
          />
        </div>
        <div className="form-group">
          <label>Max Reconnect Attempts</label>
          <input
            className="form-control"
            type="number"
            value={p.maxReconnectAttempts ?? 5}
            onChange={(e) => updatePolicy('maxReconnectAttempts', Number(e.target.value))}
          />
        </div>
      </div>
      <div className="form-group">
        <label>Existing Container Behavior</label>
        <select
          className="form-control"
          value={p.existingContainerBehavior ?? 'attach-or-recreate'}
          onChange={(e) =>
            updatePolicy(
              'existingContainerBehavior',
              e.target.value as typeof p.existingContainerBehavior
            )
          }
        >
          <option value="attach">Attach to existing</option>
          <option value="start">Start existing (if stopped)</option>
          <option value="recreate">Remove and recreate</option>
          <option value="attach-or-recreate">Attach if running, else recreate</option>
          <option value="ask">Ask each time</option>
        </select>
      </div>
    </div>
  )
}
