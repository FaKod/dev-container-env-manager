import React, { useEffect } from 'react'
import { ScrollText, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react'
import { useAppStore } from './store/useAppStore'
import { Sidebar } from './components/Sidebar'
import { TerminalTabs } from './components/TerminalTabs'
import { TerminalView } from './components/TerminalView'
import { StatusPanel } from './components/StatusPanel'
import { LogViewer } from './components/LogViewer'
import { ProfileEditor } from './components/ProfileEditor'
import { ToastContainer, toast } from './components/Toast'
import { ConfirmModal } from './components/ConfirmModal'
import { useResizablePane } from './hooks/useResizablePane'

export default function App(): React.ReactElement {
  const {
    showProfileEditor,
    showLogViewer,
    showStatusPanel,
    theme,
    profiles,
    setProfiles,
    setConnectionState,
    setContainerState,
    addLog
  } = useAppStore()

  const { size: sidebarWidth, handleMouseDown: sidebarMouseDown } = useResizablePane(280, 180, 480, 'horizontal')
  const { size: bottomHeight, handleMouseDown: bottomMouseDown } = useResizablePane(200, 90, 600, 'vertical')
  const { size: logViewerWidth, handleMouseDown: logViewerMouseDown } = useResizablePane(380, 200, 700, 'horizontal', true)

  // ── Apply theme on mount and whenever it changes ──────────────────────────────
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // ── Load initial data ────────────────────────────────────────────────────────
  useEffect(() => {
    window.api.getProfiles().then(setProfiles).catch((err) => toast(`Failed to load profiles: ${err}`))
  }, [])

  // ── Subscribe to push events ──────────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [
      window.api.onConnectionStateChanged((profileId, state) => {
        setConnectionState(profileId, state)
      }),
      window.api.onContainerStateChanged((profileId, state) => {
        setContainerState(profileId, state)
      }),
      window.api.onLogEntry((entry) => {
        addLog(entry)
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // ── Load existing connection states for already-active profiles ───────────────
  useEffect(() => {
    if (profiles.length === 0) return
    window.api.getAllConnectionStates().then((states) => {
      states.forEach((s) => setConnectionState(s.profileId, s))
    })
  }, [profiles.length])

  // ── Release xterm keyboard focus when focus moves to any non-terminal element ──
  useEffect(() => {
    const handleFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('.terminal-container')) return
      // Something outside the terminal received focus — ensure xterm gives up its textarea focus
      const xtermTextarea = document.querySelector<HTMLTextAreaElement>(
        '.terminal-container textarea'
      )
      if (xtermTextarea && document.activeElement !== xtermTextarea) {
        xtermTextarea.blur()
      }
    }
    document.addEventListener('focusin', handleFocusIn)
    return () => document.removeEventListener('focusin', handleFocusIn)
  }, [])

  return (
    <div className="app-layout">
      <div className="sidebar-pane" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
        <Sidebar />
        <div className="resize-handle resize-handle-ew resize-handle-sidebar" onMouseDown={sidebarMouseDown} />
      </div>
      <div className="main-area">
        <TerminalTabs />
        <TerminalView />
        {showStatusPanel && <div className="resize-handle" onMouseDown={bottomMouseDown} />}
        <PanelToggleBar />
        {showStatusPanel && (
          showLogViewer ? (
            <div className="bottom-panel" style={{ height: bottomHeight, minHeight: bottomHeight }}>
              <StatusPanelArea />
              <div className="resize-handle resize-handle-ew" onMouseDown={logViewerMouseDown} />
              <div style={{ width: logViewerWidth, minWidth: logViewerWidth, overflow: 'hidden', display: 'flex' }}>
                <LogViewer />
              </div>
            </div>
          ) : (
            <div className="bottom-panel" style={{ height: bottomHeight, minHeight: bottomHeight }}>
              <StatusPanelArea />
            </div>
          )
        )}
      </div>
      {showProfileEditor && <ProfileEditor />}
      <ToastContainer />
      <ConfirmModal />
    </div>
  )
}

function StatusPanelArea(): React.ReactElement {
  const { activeProfileId } = useAppStore()
  return (
    <div style={{ flex: 1, overflow: 'hidden' }}>
      {activeProfileId ? (
        <StatusPanel profileId={activeProfileId} />
      ) : (
        <div className="empty-state" style={{ fontSize: 12 }}>
          Select a profile to see status
        </div>
      )}
    </div>
  )
}

function PanelToggleBar(): React.ReactElement {
  const {
    showLogViewer, toggleLogViewer,
    showStatusPanel, toggleStatusPanel,
    activeProfileId, profiles, connections, containers
  } = useAppStore()

  const profile = profiles.find((p) => p.id === activeProfileId)
  const conn = activeProfileId ? connections[activeProfileId] : undefined
  const container = activeProfileId ? containers[activeProfileId] : undefined
  const portCount = conn?.portForwards?.filter((pf) => pf.active).length ?? 0

  return (
    <div className="panel-toggle-bar">
      {profile && (
        <div className="panel-status-strip">
          <span className="panel-status-profile">{profile.name}</span>
          <span className={`panel-status-badge pstatus-${conn?.status ?? 'disconnected'}`}>
            <span className="panel-status-dot" />
            {conn?.status ?? 'disconnected'}
          </span>
          {profile.container && container && (
            <span className={`panel-status-badge pstatus-container-${container.status ?? 'unknown'}`}>
              <span className="panel-status-dot" />
              {container.status ?? 'unknown'}
            </span>
          )}
          {portCount > 0 && (
            <span className="panel-status-ports">{portCount} port{portCount > 1 ? 's' : ''}</span>
          )}
        </div>
      )}
      <span style={{ flex: 1 }} />
      <button
        className={`panel-toggle-btn ${showLogViewer ? 'active' : ''}`}
        onClick={toggleLogViewer}
        title="Toggle event log"
      >
        <ScrollText size={12} />
        {showLogViewer ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        Logs
      </button>
      <button
        className="panel-toggle-btn"
        onClick={toggleStatusPanel}
        title={showStatusPanel ? 'Collapse status panel' : 'Expand status panel'}
      >
        {showStatusPanel ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
      </button>
    </div>
  )
}
