import { ipcMain, dialog } from 'electron'
import { writeFileSync } from 'fs'
import type { BrowserWindow } from 'electron'
import type { ProfileManager } from './managers/ProfileManager'
import type { ConnectionManager } from './managers/ConnectionManager'
import type { TerminalManager } from './managers/TerminalManager'
import type { ContainerManager } from './managers/ContainerManager'
import type { EventLogManager } from './managers/EventLogManager'
import type { TerminalContext } from '../shared/types'

interface SetupOptions {
  mainWindow: BrowserWindow
  profileManager: ProfileManager
  connectionManager: ConnectionManager
  terminalManager: TerminalManager
  containerManager: ContainerManager
  eventLogManager: EventLogManager
}

export function setupIpcHandlers(opts: SetupOptions): void {
  const {
    mainWindow,
    profileManager,
    connectionManager,
    terminalManager,
    containerManager,
    eventLogManager
  } = opts

  // ─── Profiles ──────────────────────────────────────────────────────────────

  ipcMain.handle('profile:list', () => profileManager.getAll())

  ipcMain.handle('profile:create', (_e, data) => profileManager.create(data))

  ipcMain.handle('profile:update', (_e, id: string, updates) =>
    profileManager.update(id, updates)
  )

  ipcMain.handle('profile:delete', (_e, id: string) => {
    connectionManager.disconnect(id).catch(() => {})
    terminalManager.destroyForProfile(id)
    profileManager.delete(id)
  })

  ipcMain.handle('profile:clone', (_e, id: string) => profileManager.clone(id))

  ipcMain.handle('profile:export', (_e, id: string) => profileManager.exportProfile(id))

  ipcMain.handle('profile:exportAll', () => profileManager.exportAll())

  ipcMain.handle('profile:import', (_e, json: string) => profileManager.importProfile(json))

  ipcMain.handle('profile:moveToProject', (_e, profileId: string, projectId: string | undefined) =>
    profileManager.moveProfileToProject(profileId, projectId)
  )

  // ─── Projects ──────────────────────────────────────────────────────────────

  ipcMain.handle('project:list', () => profileManager.getProjects())

  ipcMain.handle('project:create', (_e, data: { name: string }) =>
    profileManager.createProject(data)
  )

  ipcMain.handle('project:update', (_e, id: string, updates: { name: string }) =>
    profileManager.updateProject(id, updates)
  )

  ipcMain.handle('project:delete', (_e, id: string) => profileManager.deleteProject(id))

  ipcMain.handle('profile:pickWorkspace', async (_e, profileId: string) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select workspace folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const localPath = result.filePaths[0]
    const profile = profileManager.getById(profileId)
    if (!profile) return null

    const recentPaths = [
      localPath,
      ...(profile.workspace?.recentPaths ?? []).filter((p) => p !== localPath)
    ].slice(0, 10)

    return profileManager.update(profileId, {
      workspace: { localPath, recentPaths }
    })
  })

  // ─── Connections ───────────────────────────────────────────────────────────

  // Full launch: SSH tunnel + container start/attach (per policy)
  ipcMain.handle('connection:launch', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)

    // 1. Start SSH tunnel (port forwards)
    await connectionManager.connect(profile, mainWindow)

    // 2. Handle container lifecycle per existingContainerBehavior policy
    if (profile.container) {
      const current = await containerManager.getStatus(profile)
      const name = profile.container.name
      const behavior = profile.connectionPolicy.existingContainerBehavior ?? 'attach-or-recreate'

      eventLogManager.info('Launch', `Container "${name}" status: ${current.status}, behavior: ${behavior}`, profileId)

      if (behavior === 'recreate') {
        if (current.status !== 'not-found') {
          eventLogManager.info('Launch', `Removing container "${name}" for recreate`, profileId)
          await containerManager.remove(profile)
        }
        await containerManager.start(profile)

      } else if (behavior === 'attach') {
        if (current.status === 'paused') {
          eventLogManager.info('Launch', `Unpausing container "${name}"`, profileId)
          await containerManager.unpause(profile)
        } else if (current.status !== 'running') {
          throw new Error(`Container "${name}" is not running (status: ${current.status})`)
        } else {
          eventLogManager.info('Launch', `Attaching to running container "${name}"`, profileId)
        }

      } else if (behavior === 'start') {
        if (current.status === 'running') {
          eventLogManager.info('Launch', `Attaching to running container "${name}"`, profileId)
        } else if (current.status === 'paused') {
          eventLogManager.info('Launch', `Unpausing container "${name}"`, profileId)
          await containerManager.unpause(profile)
        } else if (current.status === 'stopped') {
          eventLogManager.info('Launch', `Starting stopped container "${name}"`, profileId)
          await containerManager.start(profile)
        } else {
          throw new Error(`Container "${name}" does not exist (status: ${current.status})`)
        }

      } else {
        // 'attach-or-recreate' (default) or 'ask' (falls back to attach-or-recreate)
        if (current.status === 'running') {
          eventLogManager.info('Launch', `Attaching to running container "${name}"`, profileId)
        } else if (current.status === 'paused') {
          eventLogManager.info('Launch', `Unpausing container "${name}"`, profileId)
          await containerManager.unpause(profile)
        } else {
          eventLogManager.info('Launch', `Starting/creating container "${name}"`, profileId)
          await containerManager.start(profile)
        }
      }

      const finalStatus = await containerManager.getStatus(profile)
      mainWindow.webContents.send('container:stateChanged', profileId, finalStatus)
    }
  })

  ipcMain.handle('connection:connect', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    await connectionManager.connect(profile, mainWindow)
  })

  // Shared helper: apply onDisconnectBehavior policy to a profile's container
  async function applyDisconnectBehavior(profileId: string): Promise<void> {
    const profile = profileManager.getById(profileId)
    if (!profile?.container) return
    const behavior = profile.connectionPolicy.onDisconnectBehavior ?? 'stop'
    try {
      const state = await containerManager.getStatus(profile)
      if (state.status === 'running') {
        if (behavior === 'stop') {
          await containerManager.stop(profile)
          try {
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send('container:stateChanged', profileId, {
                profileId, status: 'stopped', containerName: profile.container.name
              })
            }
          } catch { /* window destroyed */ }
        } else if (behavior === 'pause') {
          await containerManager.pause(profile)
          try {
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send('container:stateChanged', profileId, {
                profileId, status: 'paused', containerName: profile.container.name
              })
            }
          } catch { /* window destroyed */ }
        }
        // 'leave' → do nothing
      }
    } catch { /* ignore errors on disconnect */ }
  }

  ipcMain.handle('connection:disconnect', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    const behavior = profile?.connectionPolicy.onDisconnectBehavior ?? 'stop'
    // Hard-kill PTYs (no exit\n) when pausing so the buffered command
    // doesn't reach the shell when the container is later unpaused
    terminalManager.destroyForProfile(profileId, behavior === 'pause')
    await applyDisconnectBehavior(profileId)
    await connectionManager.disconnect(profileId)
  })

  ipcMain.handle('connection:state', (_e, profileId: string) =>
    connectionManager.getState(profileId)
  )

  ipcMain.handle('connection:allStates', () => connectionManager.getAllStates())

  // ─── Terminals ─────────────────────────────────────────────────────────────

  ipcMain.handle(
    'terminal:create',
    (_e, profileId: string, context: TerminalContext, cols: number, rows: number) => {
      const profile = profileManager.getById(profileId)
      if (!profile) throw new Error(`Profile ${profileId} not found`)
      return terminalManager.createTerminal(profile, context, mainWindow, cols, rows)
    }
  )

  ipcMain.handle('terminal:destroy', (_e, terminalId: string) => {
    terminalManager.destroy(terminalId)
  })

  ipcMain.handle('terminal:input', (_e, terminalId: string, data: string) => {
    terminalManager.write(terminalId, data)
  })

  ipcMain.handle('terminal:resize', (_e, terminalId: string, cols: number, rows: number) => {
    terminalManager.resize(terminalId, cols, rows)
  })

  ipcMain.handle('terminal:sessions', () => terminalManager.getSessions())

  // ─── Containers ────────────────────────────────────────────────────────────

  ipcMain.handle('container:status', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    return containerManager.getStatus(profile)
  })

  ipcMain.handle('container:start', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    await containerManager.start(profile)
    mainWindow.webContents.send('container:stateChanged', profileId, {
      profileId,
      status: 'running',
      containerName: profile.container?.name
    })
  })

  ipcMain.handle('container:stop', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    await containerManager.stop(profile)
    mainWindow.webContents.send('container:stateChanged', profileId, {
      profileId,
      status: 'stopped',
      containerName: profile.container?.name
    })
  })

  ipcMain.handle('container:restart', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    await containerManager.restart(profile)
    mainWindow.webContents.send('container:stateChanged', profileId, {
      profileId,
      status: 'running',
      containerName: profile.container?.name
    })
  })

  ipcMain.handle('container:remove', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    // Kill terminals before removing so they don't reconnect to a new container
    terminalManager.destroyForProfile(profileId)
    await containerManager.remove(profile)
    mainWindow.webContents.send('container:stateChanged', profileId, {
      profileId,
      status: 'not-found',
      containerName: profile.container?.name
    })
  })

  ipcMain.handle('container:recreate', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    // Kill terminals before recreating so they don't reconnect to the new container
    terminalManager.destroyForProfile(profileId)
    await containerManager.recreate(profile)
    mainWindow.webContents.send('container:stateChanged', profileId, {
      profileId,
      status: 'running',
      containerName: profile.container?.name
    })
  })

  ipcMain.handle('container:pause', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    await containerManager.pause(profile)
    mainWindow.webContents.send('container:stateChanged', profileId, {
      profileId, status: 'paused', containerName: profile.container?.name
    })
  })

  ipcMain.handle('container:unpause', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    await containerManager.unpause(profile)
    mainWindow.webContents.send('container:stateChanged', profileId, {
      profileId, status: 'running', containerName: profile.container?.name
    })
  })

  ipcMain.handle('container:logs', async (_e, profileId: string, lines: number) => {
    const profile = profileManager.getById(profileId)
    if (!profile) return ''
    return containerManager.getLogs(profile, lines)
  })

  ipcMain.handle(
    'container:detectPorts',
    async (
      _e,
      host: string,
      user: string | undefined,
      port: number | undefined,
      identityFile: string | undefined,
      image: string
    ) => containerManager.detectImagePorts(host, user, port, identityFile, image)
  )

  // ─── Logs ──────────────────────────────────────────────────────────────────

  ipcMain.handle('log:getAll', (_e, profileId?: string) =>
    eventLogManager.getLogs(profileId)
  )

  ipcMain.handle('log:clear', (_e, profileId?: string) => {
    eventLogManager.clear(profileId)
  })

  // ─── File dialogs ──────────────────────────────────────────────────────────

  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('fs:writeText', (_e, filePath: string, content: string) => {
    writeFileSync(filePath, content, 'utf-8')
  })

  ipcMain.handle('dialog:saveFile', async (_e, defaultName: string) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    return result.canceled ? null : result.filePath
  })

  // ─── Auto-disconnect when last terminal for a profile closes ───────────────

  terminalManager.on('profileTerminalsEmpty', async (profileId: string) => {
    const connState = connectionManager.getState(profileId)
    if (!connState || connState.status === 'disconnected') return
    await applyDisconnectBehavior(profileId)
    await connectionManager.disconnect(profileId)
  })

  // ─── Forward event-log entries to renderer ─────────────────────────────────

  eventLogManager.on('log', (entry) => {
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('log:entry', entry)
      }
    } catch { /* window destroyed between check and send */ }
  })
}
