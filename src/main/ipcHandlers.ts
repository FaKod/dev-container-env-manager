import { ipcMain, dialog, app, shell, clipboard, nativeImage } from 'electron'
import { writeFileSync } from 'fs'
import type { BrowserWindow } from 'electron'
import type { ProfileManager } from './managers/ProfileManager'
import type { ConnectionManager } from './managers/ConnectionManager'
import type { TerminalManager } from './managers/TerminalManager'
import type { ContainerManager } from './managers/ContainerManager'
import type { EventLogManager } from './managers/EventLogManager'
import type { SessionManager } from './managers/SessionManager'
import type {
  TerminalContext,
  Profile,
  PersistedSession,
  WindowBounds
} from '../shared/types'

interface SetupOptions {
  mainWindow: BrowserWindow
  profileManager: ProfileManager
  connectionManager: ConnectionManager
  terminalManager: TerminalManager
  containerManager: ContainerManager
  eventLogManager: EventLogManager
  sessionManager: SessionManager
  createDetachedTerminalWindow: (terminalId: string, bounds?: WindowBounds) => BrowserWindow
}

/**
 * Read an image off the system clipboard as PNG bytes, or null if there is none.
 *
 * Electron 44 removed `clipboard.readImage()` in favour of the W3C-shaped
 * `clipboard.read()`, which returns MIME-typed entries rather than a
 * NativeImage. PNG data is taken as-is; any other image type is routed through
 * nativeImage so callers still get PNG, which is what `readImage().toPNG()`
 * produced before.
 */
/** The slice of Electron's ClipboardItem this needs, so it can be tested with stand-ins. */
export interface ClipboardEntry {
  readonly types: string[]
  getType(type: string): Promise<unknown>
}

/**
 * Pick an image out of already-read clipboard entries and return it as PNG.
 * Split from the OS call so the MIME selection and decoding can be exercised
 * directly — a headless X server refuses to carry image data on the clipboard,
 * which makes the whole path untestable through `clipboard.read()`.
 */
export async function pngFromClipboardEntries(
  entries: readonly ClipboardEntry[]
): Promise<Buffer | null> {
  const entry = entries.find((e) => e.types.some((t) => t.startsWith('image/')))
  if (!entry) return null

  // Prefer PNG so the common case needs no re-encoding.
  const type =
    entry.types.find((t) => t === 'image/png') ?? entry.types.find((t) => t.startsWith('image/'))
  if (!type) return null

  try {
    const payload = await entry.getType(type)
    if (!(payload instanceof Blob)) return null

    const bytes = Buffer.from(await payload.arrayBuffer())
    if (bytes.length === 0) return null
    if (type === 'image/png') return bytes

    // Match what readImage().toPNG() used to hand back for non-PNG sources.
    const img = nativeImage.createFromBuffer(bytes)
    return img.isEmpty() ? null : img.toPNG()
  } catch {
    return null // malformed entry — fall back to a plain text paste
  }
}

export async function readClipboardPng(): Promise<Buffer | null> {
  try {
    return await pngFromClipboardEntries(await clipboard.read())
  } catch {
    return null // clipboard unavailable (no session / headless)
  }
}

export interface IpcHandles {
  /** Rebuild the previous run's detached terminal windows. */
  restoreDetachedWindows: (session: PersistedSession) => Promise<void>
}

export function setupIpcHandlers(opts: SetupOptions): IpcHandles {
  const {
    mainWindow,
    profileManager,
    connectionManager,
    terminalManager,
    containerManager,
    eventLogManager,
    sessionManager,
    createDetachedTerminalWindow
  } = opts

  // Detached terminal windows, keyed by terminalId. A terminal is in this map
  // exactly while it lives in its own free-floating window.
  const detachedWindows = new Map<string, BrowserWindow>()
  // Marker set so we can distinguish a user-driven close (auto re-attach) from
  // the close we trigger ourselves after an explicit attach IPC.
  const closingAfterAttach = new Set<string>()
  // On quit every window closes, which would otherwise look like the user
  // re-attaching each detached terminal and get saved as "not detached".
  let quitting = false
  app.on('before-quit', () => { quitting = true })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!url.startsWith('https://') && !url.startsWith('http://')) return
    shell.openExternal(url)
  })

  ipcMain.handle('app:getVersion', () => app.getVersion())

  // ─── Profiles ──────────────────────────────────────────────────────────────

  ipcMain.handle('profile:list', () => profileManager.getAll())

  ipcMain.handle('profile:create', (_e, data: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>>) => profileManager.create(data))

  ipcMain.handle('profile:update', (_e, id: string, updates: Partial<Omit<Profile, 'id' | 'createdAt'>>) =>
    profileManager.update(id, updates)
  )

  ipcMain.handle('profile:delete', (_e, id: string) => {
    connectionManager.disconnect(id).catch((err) => {
      eventLogManager.warn('IpcHandlers', `Disconnect failed during profile delete: ${err}`, id)
    })
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
    // Electron 43 stopped reopening the last-used directory and now starts in
    // Downloads. Seed it from the workspace this profile already points at, so
    // re-picking a folder doesn't start from an unrelated place every time.
    const current = profileManager.getById(profileId)?.workspace
    const defaultPath = current?.localPath ?? current?.recentPaths?.[0]

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select workspace folder',
      ...(defaultPath ? { defaultPath } : {})
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

  // Full launch: SSH tunnel + container start/attach (per policy).
  // Extracted from the IPC handler so reconnecting a restored terminal can run
  // the identical sequence rather than a second, drifting copy of it.
  async function launchProfile(profile: Profile): Promise<void> {
    const profileId = profile.id

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
  }

  ipcMain.handle('connection:launch', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    await launchProfile(profile)
  })

  ipcMain.handle('connection:connect', async (_e, profileId: string) => {
    const profile = profileManager.getById(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    await connectionManager.connect(profile, mainWindow)
  })

  ipcMain.handle('connection:disconnect', async (_e, profileId: string) => {
    terminalManager.destroyForProfile(profileId)
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

  // Stage a clipboard image into the terminal's environment and return the path
  // its process will see. Returns null when the clipboard holds no image.
  ipcMain.handle('terminal:pasteImage', async (_e, terminalId: string) => {
    const png = await readClipboardPng()
    if (!png) return null
    return terminalManager.stageImage(terminalId, png)
  })

  // Stage files dropped onto the terminal into its environment; returns the
  // in-terminal paths (in input order, skipping any that failed to stage).
  ipcMain.handle('terminal:dropFiles', async (_e, terminalId: string, hostPaths: string[]) => {
    const staged: string[] = []
    for (const hostPath of hostPaths) {
      const result = await terminalManager.stageFile(terminalId, hostPath)
      if (result?.path) staged.push(result.path)
    }
    return staged
  })

  ipcMain.handle('terminal:resize', (_e, terminalId: string, cols: number, rows: number) => {
    terminalManager.resize(terminalId, cols, rows)
  })

  ipcMain.handle('terminal:sessions', () => terminalManager.getSessions())

  // Bring a terminal restored from the previous run back to life: launch its
  // profile (SSH tunnel + container), then start a process behind the existing
  // stub. The terminal id is preserved, so tabs, splits and any detached window
  // already pointing at it stay valid.
  ipcMain.handle(
    'terminal:reconnect',
    async (_e, terminalId: string, cols: number, rows: number) => {
      const session = terminalManager.getSession(terminalId)
      if (!session) throw new Error(`Terminal ${terminalId} not found`)

      const profile = profileManager.getById(session.profileId)
      if (!profile) throw new Error(`Profile ${session.profileId} no longer exists`)

      if (session.context !== 'local') await launchProfile(profile)
      return terminalManager.activateStub(terminalId, profile, cols, rows)
    }
  )

  // ─── Session persistence ───────────────────────────────────────────────────

  // Detached-window frames live here in main, not in the renderer, so the
  // SessionManager reads them straight off the live windows at write time.
  sessionManager.setBoundsProvider((terminalId) => {
    const win = detachedWindows.get(terminalId)
    if (!win || win.isDestroyed()) return undefined
    return win.getBounds()
  })

  ipcMain.handle('session:restored', () => sessionManager.getRestored())

  // Fire-and-forget (`send`, not `invoke`): the renderer also pushes a final
  // snapshot from beforeunload, where awaiting a reply is not an option.
  ipcMain.on('session:save', (_e, snapshot: PersistedSession) => {
    sessionManager.save(snapshot)
  })

  // ─── Detached terminals ────────────────────────────────────────────────────

  /**
   * Open a terminal in its own window and take ownership of its PTY output.
   * Shared by the detach IPC and by session restore, so a window rebuilt at
   * startup behaves exactly like one the user detached by hand — including
   * re-attaching to the main window if they simply close it.
   */
  async function openDetached(terminalId: string, bounds?: WindowBounds): Promise<void> {
    if (detachedWindows.has(terminalId)) return

    const win = createDetachedTerminalWindow(terminalId, bounds)
    detachedWindows.set(terminalId, win)

    // Wait for the window's renderer to be ready before retargeting PTY data —
    // otherwise the first chunk of output goes nowhere (no listener yet).
    await new Promise<void>((resolve) => {
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', () => resolve())
      } else {
        resolve()
      }
    })

    terminalManager.setTargetWindow(terminalId, win)

    // Track the frame as the user moves/resizes it so the window can be put
    // back in the same place next run. 'move'/'resize' fire continuously during
    // a drag, but this only writes to a map — the disk write happens on save.
    const rememberFrame = (): void => {
      if (!win.isDestroyed()) sessionManager.rememberBounds(terminalId, win.getBounds())
    }
    win.on('move', rememberFrame)
    win.on('resize', rememberFrame)
    rememberFrame()

    // Tell the main window to drop its xterm instance + hide the tab.
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:detached', terminalId)
      }
    } catch { /* destroyed */ }

    // If the user closes the detached window directly (without clicking
    // Attach), re-attach the terminal to the main window — less destructive.
    win.on('closed', () => {
      detachedWindows.delete(terminalId)
      // During shutdown the terminal stays "detached" for next run's restore.
      if (quitting) return
      if (closingAfterAttach.delete(terminalId)) return
      if (!terminalManager.getSession(terminalId)) return // already destroyed
      terminalManager.setTargetWindow(terminalId, mainWindow)
      try {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:attached', terminalId)
        }
      } catch { /* destroyed */ }
    })

    eventLogManager.info(
      'IpcHandlers',
      `Detached terminal ${terminalId}`,
      terminalManager.getSession(terminalId)?.profileId
    )
  }

  ipcMain.handle('terminal:detach', async (_e, terminalId: string) => {
    if (!terminalManager.getSession(terminalId)) {
      throw new Error(`Terminal ${terminalId} not found`)
    }
    await openDetached(terminalId)
  })

  /**
   * Rebuild the detached windows from the previous run. Called once at startup,
   * after the restored stubs are registered with the TerminalManager.
   */
  async function restoreDetachedWindows(session: PersistedSession): Promise<void> {
    for (const t of session.terminals) {
      if (!t.detached) continue
      if (!terminalManager.getSession(t.id)) continue // stub was skipped (profile gone)
      try {
        await openDetached(t.id, t.bounds)
      } catch (err) {
        eventLogManager.warn(
          'IpcHandlers',
          `Failed to restore detached window for terminal ${t.id}: ${err}`,
          t.profileId
        )
      }
    }
  }

  ipcMain.handle('terminal:attach', (_e, terminalId: string) => {
    const win = detachedWindows.get(terminalId)
    if (!win) return

    terminalManager.setTargetWindow(terminalId, mainWindow)

    // Tell the main window to show the tab again before we close the detached
    // window — the new xterm instance can start receiving data immediately.
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:attached', terminalId)
      }
    } catch { /* destroyed */ }

    closingAfterAttach.add(terminalId)
    if (!win.isDestroyed()) win.close()

    const session = terminalManager.getSession(terminalId)
    eventLogManager.info('IpcHandlers', `Attached terminal ${terminalId}`, session?.profileId)
  })

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
      image: string,
      local: boolean
    ) => containerManager.detectImagePorts(host, user, port, identityFile, image, local)
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

  return { restoreDetachedWindows }
}
