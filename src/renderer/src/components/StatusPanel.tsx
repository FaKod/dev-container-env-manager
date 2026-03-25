import React, { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { toast } from './Toast'
import { showConfirm } from './ConfirmModal'
import type { ContainerStatus } from '../../../shared/types'

interface Props {
  profileId: string
}

export function StatusPanel({ profileId }: Props): React.ReactElement {
  const { profiles, connections, containers, setContainerState, addTerminal, setActiveTerminal } =
    useAppStore()

  const profile = profiles.find((p) => p.id === profileId)
  const connState = connections[profileId]
  const containerState = containers[profileId]

  const [containerBusy, setContainerBusy] = useState(false)

  // Poll container status when connected
  useEffect(() => {
    if (connState?.status !== 'connected') return
    if (!profile?.container) return

    const poll = async (): Promise<void> => {
      try {
        const state = await window.api.getContainerStatus(profileId)
        setContainerState(profileId, state)
      } catch {
        // silently ignore
      }
    }

    poll()
    const id = setInterval(poll, 10_000)
    return () => clearInterval(id)
  }, [connState?.status, profileId])

  if (!profile) return <></>

  function containerAction(
    action: 'start' | 'stop' | 'restart' | 'remove' | 'recreate'
  ): void {
    if (action === 'remove') {
      const name = profile?.container?.name ?? 'this container'
      showConfirm(`Remove container "${name}"? This cannot be undone.`, () => {
        void runContainerAction('remove')
      })
      return
    }
    void runContainerAction(action)
  }

  async function runContainerAction(
    action: 'start' | 'stop' | 'restart' | 'remove' | 'recreate'
  ): Promise<void> {
    setContainerBusy(true)
    try {
      await window.api[
        action === 'start'
          ? 'startContainer'
          : action === 'stop'
          ? 'stopContainer'
          : action === 'restart'
          ? 'restartContainer'
          : action === 'remove'
          ? 'removeContainer'
          : 'recreateContainer'
      ](profileId)

      // Open a terminal after start, restart, or recreate
      if (action === 'start' || action === 'restart' || action === 'recreate') {
        await openContainerTerminal()
      }

      // Disconnect SSH when container is stopped or removed
      if (action === 'stop' || action === 'remove') {
        await window.api.disconnect(profileId)
      }
    } catch (err) {
      toast(`Container ${action} failed: ${err}`)
    } finally {
      setContainerBusy(false)
    }
  }

  async function openContainerTerminal(): Promise<void> {
    try {
      const session = await window.api.createTerminal(profileId, 'container', 120, 36)
      addTerminal(session)
      setActiveTerminal(session.id)
    } catch (err) {
      toast(`Failed to open terminal: ${err}`)
    }
  }

  return (
    <div className="status-panel">
      {/* SSH Connection */}
      <div className="status-section">
        <div className="status-section-title">SSH Connection</div>
        <div className="status-row">
          <span className="status-label">Host</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {profile.ssh.host}
          </span>
        </div>
        <div className="status-row">
          <span className="status-label">Status</span>
          <ConnectionStatusBadge status={connState?.status ?? 'disconnected'} />
        </div>
        {connState?.connectedAt && (
          <div className="status-row">
            <span className="status-label">Since</span>
            <span>{new Date(connState.connectedAt).toLocaleTimeString()}</span>
          </div>
        )}
        {connState?.error && (
          <div className="status-row" style={{ color: 'var(--red)' }}>
            <span className="status-label">Error</span>
            <span style={{ fontSize: 11 }}>{connState.error}</span>
          </div>
        )}
      </div>

      {/* Port Forwards */}
      {(connState?.portForwards?.length ?? 0) > 0 && (
        <div className="status-section">
          <div className="status-section-title">Port Forwards</div>
          {connState!.portForwards.map((pf, i) => (
            <div key={i} className="port-forward-item">
              <span className={pf.active ? 'port-active' : 'port-inactive'}>
                {pf.active ? '●' : '○'}
              </span>
              <span>
                localhost:{pf.forward.localPort}{' '}
                <span style={{ color: 'var(--overlay0)' }}>→</span>{' '}
                {pf.forward.remoteHost}:{pf.forward.remotePort}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Container */}
      {profile.container && (
        <div className="status-section">
          <div className="status-section-title">Container</div>
          <div className="status-row">
            <span className="status-label">Name</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {profile.container.name}
            </span>
          </div>
          <div className="status-row">
            <span className="status-label">Image</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
              title={profile.container.image}
            >
              {profile.container.image}
            </span>
          </div>
          <div className="status-row">
            <span className="status-label">Status</span>
            <ContainerStatusBadge status={containerState?.status ?? 'unknown'} />
          </div>
          <div className="container-actions">
            <button
              className="btn btn-success btn-sm"
              onClick={() => containerAction('start')}
              disabled={containerBusy || containerState?.status === 'running'}
            >
              Start
            </button>
            <button
              className="btn btn-warning btn-sm"
              onClick={() => containerAction('stop')}
              disabled={containerBusy || containerState?.status !== 'running'}
            >
              Stop
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => containerAction('restart')}
              disabled={containerBusy}
            >
              Restart
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => containerAction('recreate')}
              disabled={containerBusy}
            >
              Recreate
            </button>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => containerAction('remove')}
              disabled={containerBusy || containerState?.status === 'not-found'}
              title="Remove container from remote host"
            >
              Delete
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={openContainerTerminal}
            >
              Shell
            </button>
          </div>
        </div>
      )}

    </div>
  )
}

function ConnectionStatusBadge({ status }: { status: string }): React.ReactElement {
  const color: Record<string, string> = {
    connected: 'var(--green)',
    connecting: 'var(--yellow)',
    reconnecting: 'var(--yellow)',
    degraded: 'var(--peach)',
    failed: 'var(--red)',
    disconnected: 'var(--overlay0)'
  }
  return (
    <span style={{ color: color[status] ?? 'var(--overlay0)', fontWeight: 600, fontSize: 12 }}>
      {status}
    </span>
  )
}

function ContainerStatusBadge({ status }: { status: ContainerStatus }): React.ReactElement {
  const color: Record<string, string> = {
    running: 'var(--green)',
    stopped: 'var(--yellow)',
    starting: 'var(--yellow)',
    stopping: 'var(--yellow)',
    failed: 'var(--red)',
    'not-found': 'var(--overlay0)',
    unknown: 'var(--overlay0)'
  }
  return (
    <span style={{ color: color[status] ?? 'var(--overlay0)', fontWeight: 600, fontSize: 12 }}>
      {status}
    </span>
  )
}
