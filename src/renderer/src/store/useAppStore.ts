import { create } from 'zustand'
import type {
  Profile,
  ConnectionState,
  ContainerState,
  TerminalSession,
  LogEntry
} from '../../../shared/types'

interface AppStore {
  // ── Data ────────────────────────────────────────────────────────────────────
  profiles: Profile[]
  connections: Record<string, ConnectionState>
  containers: Record<string, ContainerState>
  terminals: TerminalSession[]
  logs: LogEntry[]

  // ── UI state ────────────────────────────────────────────────────────────────
  activeProfileId: string | null
  activeTerminalId: string | null
  splitSession: TerminalSession | null
  splitDirection: 'vertical' | 'horizontal'
  showProfileEditor: boolean
  editingProfileId: string | null
  showLogViewer: boolean
  theme: 'dark' | 'light'

  // ── Actions ─────────────────────────────────────────────────────────────────
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

  addLog: (entry: LogEntry) => void
  setLogs: (logs: LogEntry[]) => void

  setActiveProfile: (id: string | null) => void
  setActiveTerminal: (id: string | null) => void
  setSplitSession: (session: TerminalSession | null, direction?: 'vertical' | 'horizontal') => void
  openProfileEditor: (profileId?: string) => void
  closeProfileEditor: () => void
  toggleLogViewer: () => void
  toggleTheme: () => void
}

const MAX_LOGS = 500

export const useAppStore = create<AppStore>((set) => ({
  profiles: [],
  connections: {},
  containers: {},
  terminals: [],
  logs: [],

  activeProfileId: null,
  activeTerminalId: null,
  splitSession: null,
  splitDirection: 'vertical' as const,
  showProfileEditor: false,
  editingProfileId: null,
  showLogViewer: false,
  theme: (localStorage.getItem('theme') as 'dark' | 'light') ?? 'dark',

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
    set((s) => ({
      terminals: s.terminals.filter((t) => t.id !== id),
      activeTerminalId: s.activeTerminalId === id ? null : s.activeTerminalId
    })),

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

  addLog: (entry) =>
    set((s) => {
      const logs = [...s.logs, entry]
      return { logs: logs.length > MAX_LOGS ? logs.slice(logs.length - MAX_LOGS) : logs }
    }),

  setLogs: (logs) => set({ logs }),

  setActiveProfile: (id) => set({ activeProfileId: id }),

  setActiveTerminal: (id) => set({ activeTerminalId: id }),

  setSplitSession: (session, direction = 'vertical') =>
    set({ splitSession: session, splitDirection: direction }),

  openProfileEditor: (profileId) =>
    set({ showProfileEditor: true, editingProfileId: profileId ?? null }),

  closeProfileEditor: () =>
    set({ showProfileEditor: false, editingProfileId: null }),

  toggleLogViewer: () => set((s) => ({ showLogViewer: !s.showLogViewer })),

  toggleTheme: () =>
    set((s) => {
      const next = s.theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem('theme', next)
      document.documentElement.dataset.theme = next
      return { theme: next }
    })
}))
