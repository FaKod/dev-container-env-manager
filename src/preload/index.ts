import { contextBridge, ipcRenderer } from 'electron'
import type {
  Profile,
  ConnectionState,
  ContainerState,
  TerminalContext,
  TerminalSession,
  LogEntry
} from '../shared/types'

// ─── Type-safe IPC bridge ─────────────────────────────────────────────────────

const api = {
  // ── Profiles ──────────────────────────────────────────────────────────────
  getProfiles: (): Promise<Profile[]> => ipcRenderer.invoke('profile:list'),

  createProfile: (
    data: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<Profile> => ipcRenderer.invoke('profile:create', data),

  updateProfile: (
    id: string,
    updates: Partial<Omit<Profile, 'id' | 'createdAt'>>
  ): Promise<Profile> => ipcRenderer.invoke('profile:update', id, updates),

  deleteProfile: (id: string): Promise<void> => ipcRenderer.invoke('profile:delete', id),

  cloneProfile: (id: string): Promise<Profile> => ipcRenderer.invoke('profile:clone', id),

  exportProfile: (id: string): Promise<string> => ipcRenderer.invoke('profile:export', id),

  exportAllProfiles: (): Promise<string> => ipcRenderer.invoke('profile:exportAll'),

  importProfile: (json: string): Promise<Profile> =>
    ipcRenderer.invoke('profile:import', json),

  pickWorkspace: (profileId: string): Promise<Profile | null> =>
    ipcRenderer.invoke('profile:pickWorkspace', profileId),

  // ── Connections ──────────────────────────────────────────────────────────
  // Full launch: SSH tunnel + container start/attach + ready for terminal
  launch: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('connection:launch', profileId),

  connect: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('connection:connect', profileId),

  disconnect: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('connection:disconnect', profileId),

  getConnectionState: (profileId: string): Promise<ConnectionState | null> =>
    ipcRenderer.invoke('connection:state', profileId),

  getAllConnectionStates: (): Promise<ConnectionState[]> =>
    ipcRenderer.invoke('connection:allStates'),

  // ── Terminals ─────────────────────────────────────────────────────────────
  createTerminal: (
    profileId: string,
    context: TerminalContext,
    cols: number,
    rows: number
  ): Promise<TerminalSession> =>
    ipcRenderer.invoke('terminal:create', profileId, context, cols, rows),

  destroyTerminal: (terminalId: string): Promise<void> =>
    ipcRenderer.invoke('terminal:destroy', terminalId),

  terminalInput: (terminalId: string, data: string): Promise<void> =>
    ipcRenderer.invoke('terminal:input', terminalId, data),

  terminalResize: (terminalId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal:resize', terminalId, cols, rows),

  getTerminalSessions: (): Promise<TerminalSession[]> =>
    ipcRenderer.invoke('terminal:sessions'),

  // ── Containers ────────────────────────────────────────────────────────────
  getContainerStatus: (profileId: string): Promise<ContainerState> =>
    ipcRenderer.invoke('container:status', profileId),

  startContainer: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('container:start', profileId),

  stopContainer: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('container:stop', profileId),

  restartContainer: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('container:restart', profileId),

  removeContainer: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('container:remove', profileId),

  recreateContainer: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('container:recreate', profileId),

  getContainerLogs: (profileId: string, lines?: number): Promise<string> =>
    ipcRenderer.invoke('container:logs', profileId, lines ?? 100),

  detectContainerPorts: (
    host: string,
    user: string | undefined,
    port: number | undefined,
    identityFile: string | undefined,
    image: string
  ): Promise<number[]> =>
    ipcRenderer.invoke('container:detectPorts', host, user, port, identityFile, image),

  // ── Logs ──────────────────────────────────────────────────────────────────
  getLogs: (profileId?: string): Promise<LogEntry[]> =>
    ipcRenderer.invoke('log:getAll', profileId),

  clearLogs: (profileId?: string): Promise<void> =>
    ipcRenderer.invoke('log:clear', profileId),

  // ── File dialogs ──────────────────────────────────────────────────────────
  openFileDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),

  saveFileDialog: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', defaultName),

  writeTextFile: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('fs:writeText', filePath, content),

  // ── Event subscriptions (return unsubscribe function) ────────────────────
  onTerminalData: (
    callback: (terminalId: string, data: string) => void
  ): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, terminalId: string, data: string) =>
      callback(terminalId, data)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },

  onTerminalExited: (callback: (terminalId: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, terminalId: string) =>
      callback(terminalId)
    ipcRenderer.on('terminal:exited', handler)
    return () => ipcRenderer.removeListener('terminal:exited', handler)
  },

  onConnectionStateChanged: (
    callback: (profileId: string, state: ConnectionState) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      profileId: string,
      state: ConnectionState
    ) => callback(profileId, state)
    ipcRenderer.on('connection:stateChanged', handler)
    return () => ipcRenderer.removeListener('connection:stateChanged', handler)
  },

  onContainerStateChanged: (
    callback: (profileId: string, state: ContainerState) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      profileId: string,
      state: ContainerState
    ) => callback(profileId, state)
    ipcRenderer.on('container:stateChanged', handler)
    return () => ipcRenderer.removeListener('container:stateChanged', handler)
  },

  onLogEntry: (callback: (entry: LogEntry) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, entry: LogEntry) => callback(entry)
    ipcRenderer.on('log:entry', handler)
    return () => ipcRenderer.removeListener('log:entry', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

// Declare global type for the renderer
declare global {
  interface Window {
    api: typeof api
  }
}
