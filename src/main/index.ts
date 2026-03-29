import { app, BrowserWindow, shell, Menu } from 'electron'
import { join } from 'path'
import { ProfileManager } from './managers/ProfileManager'
import { ConnectionManager } from './managers/ConnectionManager'
import { TerminalManager } from './managers/TerminalManager'
import { ContainerManager } from './managers/ContainerManager'
import { EventLogManager } from './managers/EventLogManager'
import { setupIpcHandlers } from './ipcHandlers'

// ─── Manager initialization ───────────────────────────────────────────────────

const eventLogManager = new EventLogManager()
const profileManager = new ProfileManager()
const connectionManager = new ConnectionManager(eventLogManager)
const terminalManager = new TerminalManager(eventLogManager)
const containerManager = new ContainerManager(eventLogManager)

// ─── Window creation ──────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null

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

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setupIpcHandlers({
    mainWindow,
    profileManager,
    connectionManager,
    terminalManager,
    containerManager,
    eventLogManager
  })

  eventLogManager.info('App', 'FaKods Legendary DevContainer Manager started')
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

app.on('window-all-closed', async () => {
  await connectionManager.disconnectAll()
  if (process.platform !== 'darwin') app.quit()
})
