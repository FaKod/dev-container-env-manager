import { app, BrowserWindow, shell, Menu, screen } from 'electron'
import { join } from 'path'
import { ProfileManager } from './managers/ProfileManager'
import { ConnectionManager } from './managers/ConnectionManager'
import { TerminalManager } from './managers/TerminalManager'
import { ContainerManager } from './managers/ContainerManager'
import { EventLogManager } from './managers/EventLogManager'
import { SessionManager } from './managers/SessionManager'
import { setupIpcHandlers } from './ipcHandlers'
import type { WindowBounds } from '../shared/types'

// ─── Manager initialization ───────────────────────────────────────────────────

const eventLogManager = new EventLogManager()
const profileManager = new ProfileManager()
const connectionManager = new ConnectionManager(eventLogManager)
const terminalManager = new TerminalManager(eventLogManager)
const containerManager = new ContainerManager(eventLogManager)
const sessionManager = new SessionManager()

// ─── Window creation ──────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null

// Renderer URL is loaded with an optional query string so the same bundle can
// render either the full app or a single detached terminal.
function loadRenderer(win: BrowserWindow, query?: string): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    win.loadURL(query ? `${base}/?${query}` : base)
  } else {
    const opts = query ? { search: query } : undefined
    win.loadFile(join(__dirname, '../renderer/index.html'), opts)
  }
}

/**
 * Validate a window frame saved in a previous run. A frame is dropped entirely
 * if it is nonsensical, and nudged back onto the nearest display if the monitor
 * it used to live on is gone — otherwise the window would restore off-screen
 * with no way to reach it.
 */
function onScreenBounds(bounds?: WindowBounds): WindowBounds | undefined {
  if (!bounds) return undefined
  const { x, y, width, height } = bounds
  if (![x, y, width, height].every(Number.isFinite)) return undefined
  if (width < 200 || height < 150) return undefined

  const area = screen.getDisplayMatching({ x, y, width, height }).workArea
  const intersects =
    x < area.x + area.width &&
    x + width > area.x &&
    y < area.y + area.height &&
    y + height > area.y

  return intersects ? bounds : { ...bounds, x: area.x + 40, y: area.y + 40 }
}

/**
 * Spawn a separate, free-floating BrowserWindow that hosts a single terminal.
 * The window's renderer is given the terminal id via the `?detached=<id>`
 * query string so it can mount the DetachedTerminalApp shell.
 *
 * `bounds` restores the frame a detached window had when the app last quit.
 */
export function createDetachedTerminalWindow(
  terminalId: string,
  bounds?: WindowBounds
): BrowserWindow {
  const frame = onScreenBounds(bounds)
  const win = new BrowserWindow({
    width: frame?.width ?? 900,
    height: frame?.height ?? 600,
    ...(frame ? { x: frame.x, y: frame.y } : {}),
    minWidth: 480,
    minHeight: 320,
    show: false,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(win, `detached=${encodeURIComponent(terminalId)}`)
  return win
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#1e1e2e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow!.show())

  // Open external links in the system browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Rebuild the previous run's terminals as stubs *before* the renderer loads,
  // so its first `terminal:sessions` / `session:restored` call already sees them.
  const restored = sessionManager.getRestored()
  let restoredCount = 0
  for (const t of restored.terminals) {
    const profile = profileManager.getById(t.profileId)
    // Silently drop terminals whose profile was deleted between runs — there is
    // nothing left to reconnect them to.
    if (!profile) continue
    terminalManager.restoreStub(profile, t, mainWindow)
    restoredCount++
  }

  loadRenderer(mainWindow)

  const { restoreDetachedWindows } = setupIpcHandlers({
    mainWindow,
    profileManager,
    connectionManager,
    terminalManager,
    containerManager,
    eventLogManager,
    sessionManager,
    createDetachedTerminalWindow
  })

  // Detached windows come back only once the main window exists to re-attach
  // to, and after its renderer has loaded so it doesn't lose the focus race.
  if (restoredCount > 0) {
    mainWindow.webContents.once('did-finish-load', () => {
      restoreDetachedWindows(restored).catch((err) => {
        eventLogManager.warn('App', `Failed to restore detached windows: ${err}`)
      })
    })
  }

  eventLogManager.info('App', 'FaKods Legendary DevContainer Manager started')
  if (restoredCount > 0) {
    eventLogManager.info(
      'App',
      `Restored ${restoredCount} terminal${restoredCount > 1 ? 's' : ''} from the last session`
    )
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Remove the default Electron menu so its built-in zoom accelerators
  // (Ctrl+= / Ctrl+-) don't conflict with the terminal font-size shortcuts.
  Menu.setApplicationMenu(null)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Final write with the freshest window frames. The renderer pushes a snapshot
// on every change (and once more from beforeunload), so this only has to flush
// what is already in hand.
app.on('before-quit', () => {
  try {
    sessionManager.flush()
  } catch (err) {
    eventLogManager.warn('App', `Failed to save session: ${err}`)
  }
})

app.on('window-all-closed', async () => {
  const profiles = profileManager.getAll()
  await Promise.allSettled(
    profiles.map(async (profile) => {
      const conn = connectionManager.getState(profile.id)
      if (!conn || conn.status === 'disconnected') return
      if (!profile.container) return
      const behavior = profile.connectionPolicy.onDisconnectBehavior ?? 'leave'
      try {
        const state = await containerManager.getStatus(profile)
        if (state.status === 'running') {
          if (behavior === 'stop') await containerManager.stop(profile)
          else if (behavior === 'pause') await containerManager.pause(profile)
          // 'leave' → do nothing
        }
      } catch { /* ignore errors on shutdown */ }
    })
  )
  await connectionManager.disconnectAll()
  if (process.platform !== 'darwin') app.quit()
})
