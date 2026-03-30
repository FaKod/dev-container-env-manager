import React, { useEffect, useRef, useState } from 'react'
import { Wifi, Network, Box, Circle } from 'lucide-react'
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
  const [sshIconKey, setSshIconKey] = useState(0)
  const prevStatus = useRef(connState?.status)

  useEffect(() => {
    if (connState?.status !== prevStatus.current) {
      prevStatus.current = connState?.status
      setSshIconKey((k) => k + 1)
    }
  }, [connState?.status])

  // Poll container status when connected — only update store if status changed
  const prevContainerStatus = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (connState?.status !== 'connected') return
    if (!profile?.container) return

    const poll = async (): Promise<void> => {
      try {
        const state = await window.api.getContainerStatus(profileId)
        if (state.status !== prevContainerStatus.current) {
          prevContainerStatus.current = state.status
          setContainerState(profileId, state)
        }
      } catch {
        // silently ignore
      }
    }

    poll()
    const id = setInterval(poll, 30_000)
    return () => clearInterval(id)
  }, [connState?.status, profileId])

  if (!profile) return <></>

  function containerAction(
    action: 'start' | 'stop' | 'restart' | 'remove' | 'recreate' | 'pause' | 'unpause'
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
    action: 'start' | 'stop' | 'restart' | 'remove' | 'recreate' | 'pause' | 'unpause'
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
          : action === 'pause'
          ? 'pauseContainer'
          : action === 'unpause'
          ? 'unpauseContainer'
          : 'recreateContainer'
      ](profileId)

      // Open a terminal after start, restart, or recreate.
      // In attach mode, give the container's PID 1 a moment to initialize its TTY
      // before docker attach connects, otherwise attach may fail immediately.
      if (action === 'start' || action === 'restart' || action === 'recreate') {
        if (profile?.container?.terminalMode === 'attach') {
          await new Promise((r) => setTimeout(r, 600))
        }
        await openContainerTerminal()
      }

      // Disconnect SSH when container is stopped or removed
      if (action === 'stop' || action === 'remove') {
        await window.api.disconnect(profileId)
      }

      // Unpause opens a terminal if none are open
      if (action === 'unpause') {
        await openContainerTerminal()
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
      <div className="status-section status-section-ssh">
        <div className="status-section-title">
          <span key={sshIconKey} className="icon-pulse"><Wifi size={11} /></span>
          SSH Connection
        </div>
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
        <div className="status-section status-section-ports">
          <div className="status-section-title"><Network size={11} /> Port Forwards</div>
          {connState!.portForwards.map((pf, i) => (
            <div key={i} className="port-forward-item">
              <span className={pf.active ? 'port-active' : 'port-inactive'}>
                <Circle size={8} fill={pf.active ? 'currentColor' : 'none'} />
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
        <div className="status-section status-section-container">
          <div className="status-section-title"><Box size={11} /> Container</div>
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
              disabled={containerBusy || containerState?.status === 'running' || containerState?.status === 'paused'}
            >
              Start
            </button>
            {containerState?.status === 'paused' ? (
              <button
                className="btn btn-warning btn-sm"
                onClick={() => containerAction('unpause')}
                disabled={containerBusy}
              >
                Unpause
              </button>
            ) : (
              <button
                className="btn btn-warning btn-sm"
                onClick={() => containerAction('pause')}
                disabled={containerBusy || containerState?.status !== 'running'}
              >
                Pause
              </button>
            )}
            <button
              className="btn btn-warning btn-sm"
              onClick={() => containerAction('stop')}
              disabled={containerBusy || (containerState?.status !== 'running' && containerState?.status !== 'paused')}
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
              disabled={containerState?.status === 'paused'}
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
  const cls: Record<string, string> = {
    connected: 'connected', connecting: 'connecting', reconnecting: 'reconnecting',
    degraded: 'degraded', failed: 'failed', disconnected: 'disconnected'
  }
  return <span className={`status-badge ${cls[status] ?? 'disconnected'}`}><span className="dot" />{status}</span>
}

function ContainerStatusBadge({ status }: { status: ContainerStatus }): React.ReactElement {
  const cls: Record<string, string> = {
    running: 'connected', stopped: 'connecting', paused: 'reconnecting', starting: 'connecting',
    stopping: 'connecting', failed: 'failed', 'not-found': 'disconnected', unknown: 'disconnected'
  }
  return <span className={`status-badge ${cls[status] ?? 'disconnected'}`}><span className="dot" />{status}</span>
}
