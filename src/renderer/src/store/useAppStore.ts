import { create } from 'zustand'
import type {
  Profile,
  Project,
  ConnectionState,
  ContainerState,
  TerminalSession,
  LogEntry
} from '../../../shared/types'

interface AppStore {
  // ── Data ────────────────────────────────────────────────────────────────────
  projects: Project[]
  profiles: Profile[]
  connections: Record<string, ConnectionState>
  containers: Record<string, ContainerState>
  terminals: TerminalSession[]
  logs: LogEntry[]

  // ── UI state ────────────────────────────────────────────────────────────────
  activeProfileId: string | null
  activeTerminalId: string | null
  // Which visible terminal currently owns the keyboard. Distinct from
  // activeTerminalId because in split/tile modes multiple terminals are
  // visible at once but only one can have focus.
  focusedTerminalId: string | null
  splits: Record<string, { session: TerminalSession; direction: 'vertical' | 'horizontal' }>
  // Terminal IDs currently displayed in their own detached BrowserWindow.
  // They stay in `terminals[]` so re-attaching can find them again, but are
  // hidden from tabs/splits/tiles in the main window.
  detachedTerminalIds: Record<string, true>
  showProfileEditor: boolean
  editingProfileId: string | null
  showLogViewer: boolean
  showStatusPanel: boolean
  tileMode: boolean
  theme: 'dark' | 'light'

  // ── Actions ─────────────────────────────────────────────────────────────────
  setProjects: (projects: Project[]) => void
  upsertProject: (project: Project) => void
  removeProject: (id: string) => void

  setProfiles: (profiles: Profile[]) => void
  upsertProfile: (profile: Profile) => void
  removeProfile: (id: string) => void

  setConnectionState: (profileId: string, state: ConnectionState) => void
  removeConnectionState: (profileId: string) => void

  setContainerState: (profileId: string, state: ContainerState) => void

  setTerminals: (terminals: TerminalSession[]) => void
  addTerminal: (session: TerminalSession) => void
  removeTerminal: (id: string) => void
  markTerminalInactive: (id: string) => void
  markTerminalUnread: (id: string) => void
  markTerminalRead: (id: string) => void
  setTerminalTitle: (id: string, title: string) => void

  addLog: (entry: LogEntry) => void
  setLogs: (logs: LogEntry[]) => void

  setActiveProfile: (id: string | null) => void
  setActiveTerminal: (id: string | null) => void
  setFocusedTerminal: (id: string | null) => void
  setSplitSession: (primaryId: string, session: TerminalSession, direction: 'vertical' | 'horizontal') => void
  removeSplit: (primaryId: string) => void
  setTerminalDetached: (id: string, detached: boolean) => void
  openProfileEditor: (profileId?: string) => void
  closeProfileEditor: () => void
  toggleLogViewer: () => void
  toggleStatusPanel: () => void
  toggleTileMode: () => void
  toggleTheme: () => void
}

const MAX_LOGS = 500

export const useAppStore = create<AppStore>((set) => ({
  projects: [],
  profiles: [],
  connections: {},
  containers: {},
  terminals: [],
  logs: [],

  activeProfileId: null,
  activeTerminalId: null,
  focusedTerminalId: null,
  splits: {},
  detachedTerminalIds: {},
  showProfileEditor: false,
  editingProfileId: null,
  showLogViewer: false,
  showStatusPanel: false,
  tileMode: false,
  theme: (localStorage.getItem('theme') as 'dark' | 'light') ?? 'dark',

  setProjects: (projects) => set({ projects }),

  upsertProject: (project) =>
    set((s) => {
      const exists = s.projects.some((p) => p.id === project.id)
      return {
        projects: exists
          ? s.projects.map((p) => (p.id === project.id ? project : p))
          : [...s.projects, project]
      }
    }),

  removeProject: (id) =>
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) })),

  setProfiles: (profiles) => set({ profiles }),

  upsertProfile: (profile) =>
    set((s) => {
      const exists = s.profiles.some((p) => p.id === profile.id)
      return {
        profiles: exists
          ? s.profiles.map((p) => (p.id === profile.id ? profile : p))
          : [...s.profiles, profile]
      }
    }),

  removeProfile: (id) =>
    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      activeProfileId: s.activeProfileId === id ? null : s.activeProfileId
    })),

  setConnectionState: (profileId, state) =>
    set((s) => ({ connections: { ...s.connections, [profileId]: state } })),

  removeConnectionState: (profileId) =>
    set((s) => {
      const next = { ...s.connections }
      delete next[profileId]
      return { connections: next }
    }),

  setContainerState: (profileId, state) =>
    set((s) => ({ containers: { ...s.containers, [profileId]: state } })),

  setTerminals: (terminals) => set({ terminals }),

  addTerminal: (session) =>
    set((s) => ({ terminals: [...s.terminals, session] })),

  removeTerminal: (id) =>
    set((s) => {
      const nextSplits = { ...s.splits }
      delete nextSplits[id]
      const nextDetached = { ...s.detachedTerminalIds }
      delete nextDetached[id]
      const nextActive = s.activeTerminalId === id ? null : s.activeTerminalId
      return {
        terminals: s.terminals.filter((t) => t.id !== id),
        activeTerminalId: nextActive,
        focusedTerminalId: s.focusedTerminalId === id ? nextActive : s.focusedTerminalId,
        splits: nextSplits,
        detachedTerminalIds: nextDetached
      }
    }),

  markTerminalInactive: (id) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, active: false } : t))
    })),

  markTerminalUnread: (id) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, hasUnread: true } : t))
    })),

  markTerminalRead: (id) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, hasUnread: false } : t))
    })),

  setTerminalTitle: (id, title) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, title } : t))
    })),

  addLog: (entry) =>
    set((s) => {
      const logs = [...s.logs, entry]
      return { logs: logs.length > MAX_LOGS ? logs.slice(logs.length - MAX_LOGS) : logs }
    }),

  setLogs: (logs) => set({ logs }),

  setActiveProfile: (id) => set({ activeProfileId: id }),

  setActiveTerminal: (id) => set({ activeTerminalId: id, focusedTerminalId: id }),

  setFocusedTerminal: (id) => set({ focusedTerminalId: id }),

  setSplitSession: (primaryId, session, direction) =>
    set((s) => ({
      splits: { ...s.splits, [primaryId]: { session, direction } },
      focusedTerminalId: session.id
    })),

  removeSplit: (primaryId) =>
    set((s) => {
      const next = { ...s.splits }
      const removed = s.splits[primaryId]
      delete next[primaryId]
      const focused =
        removed && s.focusedTerminalId === removed.session.id
          ? primaryId
          : s.focusedTerminalId
      return { splits: next, focusedTerminalId: focused }
    }),

  setTerminalDetached: (id, detached) =>
    set((s) => {
      const next = { ...s.detachedTerminalIds }
      if (detached) next[id] = true
      else delete next[id]
      return { detachedTerminalIds: next }
    }),

  openProfileEditor: (profileId) =>
    set({ showProfileEditor: true, editingProfileId: profileId ?? null }),

  closeProfileEditor: () =>
    set({ showProfileEditor: false, editingProfileId: null }),

  toggleLogViewer: () => set((s) => ({ showLogViewer: !s.showLogViewer })),
  toggleStatusPanel: () => set((s) => ({ showStatusPanel: !s.showStatusPanel })),
  toggleTileMode: () => set((s) => ({ tileMode: !s.tileMode })),

  toggleTheme: () =>
    set((s) => {
      const next = s.theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem('theme', next)
      document.documentElement.dataset.theme = next
      return { theme: next }
    })
}))
