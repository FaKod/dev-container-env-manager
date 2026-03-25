import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import type { Profile, ConnectionState, ConnectionStatus, PortForwardState } from '../../shared/types'
import type { EventLogManager } from './EventLogManager'

interface ConnectionEntry {
  profileId: string
  process: ChildProcess | null
  state: ConnectionState
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempts: number
  mainWindow: BrowserWindow | null
}

export class ConnectionManager extends EventEmitter {
  private connections = new Map<string, ConnectionEntry>()
  private logger: EventLogManager

  constructor(logger: EventLogManager) {
    super()
    this.logger = logger
  }

  getState(profileId: string): ConnectionState | null {
    return this.connections.get(profileId)?.state ?? null
  }

  getAllStates(): ConnectionState[] {
    return Array.from(this.connections.values()).map((c) => c.state)
  }

  async connect(profile: Profile, mainWindow: BrowserWindow): Promise<void> {
    const existing = this.connections.get(profile.id)

    if (existing && profile.connectionPolicy.preventDuplicateConnections) {
      if (
        existing.state.status === 'connected' ||
        existing.state.status === 'connecting'
      ) {
        throw new Error(`Profile ${profile.name} is already connected or connecting`)
      }
    }

    // Cancel any pending reconnect
    if (existing?.reconnectTimer) {
      clearTimeout(existing.reconnectTimer)
    }

    const portForwards: PortForwardState[] = (profile.ssh.forwards ?? []).map((f) => ({
      forward: f,
      active: false
    }))

    const entry: ConnectionEntry = {
      profileId: profile.id,
      process: null,
      state: {
        profileId: profile.id,
        status: 'connecting',
        portForwards
      },
      reconnectTimer: null,
      reconnectAttempts: 0,
      mainWindow
    }

    this.connections.set(profile.id, entry)
    this.emitStateChange(profile.id)
    this.logger.info('ConnectionManager', `Connecting to ${profile.ssh.host}`, profile.id)

    try {
      await this.spawnSSHTunnel(profile, entry)
    } catch (err) {
      this.setStatus(profile.id, 'failed', String(err))
      this.logger.error('ConnectionManager', `Failed to connect: ${err}`, profile.id)
    }
  }

  private async spawnSSHTunnel(profile: Profile, entry: ConnectionEntry): Promise<void> {
    const args = this.buildSSHArgs(profile)
    this.logger.debug('ConnectionManager', `SSH args: ssh ${args.join(' ')}`, profile.id)

    const sshProcess = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    })

    entry.process = sshProcess

    let connectTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (entry.state.status === 'connecting') {
        this.logger.warn('ConnectionManager', 'SSH connect timeout', profile.id)
        this.setStatus(profile.id, 'connected') // assume connected if no error
        entry.state.portForwards = entry.state.portForwards.map((pf) => ({
          ...pf,
          active: true
        }))
        this.emitStateChange(profile.id)
      }
    }, 5000)

    sshProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      this.logger.debug('ConnectionManager', `SSH stdout: ${text.trim()}`, profile.id)
    })

    sshProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      this.logger.debug('ConnectionManager', `SSH stderr: ${text.trim()}`, profile.id)

      // Detect successful connection
      if (
        text.includes('Entering interactive session') ||
        text.includes('forwarding') ||
        text.includes('debug1: channel')
      ) {
        if (entry.state.status === 'connecting') {
          if (connectTimeout) {
            clearTimeout(connectTimeout)
            connectTimeout = null
          }
          this.setStatus(profile.id, 'connected')
          entry.state.portForwards = entry.state.portForwards.map((pf) => ({
            ...pf,
            active: true
          }))
          this.logger.info('ConnectionManager', `Connected to ${profile.ssh.host}`, profile.id)
          this.emitStateChange(profile.id)
        }
      }
    })

    sshProcess.on('error', (err: Error) => {
      if (connectTimeout) {
        clearTimeout(connectTimeout)
        connectTimeout = null
      }
      this.logger.error('ConnectionManager', `SSH process error: ${err.message}`, profile.id)
      this.setStatus(profile.id, 'failed', err.message)
      this.scheduleReconnect(profile)
    })

    sshProcess.on('exit', (code, signal) => {
      if (connectTimeout) {
        clearTimeout(connectTimeout)
        connectTimeout = null
      }
      const wasConnected = entry.state.status === 'connected'
      this.logger.warn(
        'ConnectionManager',
        `SSH process exited (code=${code}, signal=${signal})`,
        profile.id
      )
      entry.process = null
      entry.state.portForwards = entry.state.portForwards.map((pf) => ({
        ...pf,
        active: false
      }))

      if (wasConnected && code !== 0 && signal !== 'SIGTERM') {
        this.setStatus(profile.id, 'degraded')
        this.scheduleReconnect(profile)
      } else {
        this.setStatus(profile.id, 'disconnected')
      }
    })
  }

  private buildSSHArgs(profile: Profile): string[] {
    const args: string[] = []

    // Control options
    args.push('-N') // Don't execute a remote command – tunnel only

    // Keepalive
    if (profile.ssh.keepalive !== false) {
      args.push('-o', 'ServerAliveInterval=30')
      args.push('-o', 'ServerAliveCountMax=3')
    }

    // Identity file
    if (profile.ssh.identityFile) {
      args.push('-i', profile.ssh.identityFile)
    }

    // SSH port
    if (profile.ssh.port) {
      args.push('-p', String(profile.ssh.port))
    }

    // Port forwards
    for (const fwd of profile.ssh.forwards ?? []) {
      args.push('-L', `${fwd.localPort}:${fwd.remoteHost}:${fwd.remotePort}`)
    }

    // Extra options
    for (const [key, value] of Object.entries(profile.ssh.extraOptions ?? {})) {
      args.push('-o', `${key}=${value}`)
    }

    // User@host
    const userHost = profile.ssh.user
      ? `${profile.ssh.user}@${profile.ssh.host}`
      : profile.ssh.host
    args.push(userHost)

    return args
  }

  async disconnect(profileId: string): Promise<void> {
    const entry = this.connections.get(profileId)
    if (!entry) return

    // Cancel any pending reconnect
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
    }

    if (entry.process) {
      entry.process.kill('SIGTERM')
      entry.process = null
    }

    this.setStatus(profileId, 'disconnected')
    this.logger.info('ConnectionManager', 'Disconnected', profileId)
  }

  async disconnectAll(): Promise<void> {
    for (const profileId of this.connections.keys()) {
      await this.disconnect(profileId)
    }
  }

  private scheduleReconnect(profile: Profile): void {
    const entry = this.connections.get(profile.id)
    if (!entry) return

    const policy = profile.connectionPolicy
    if (!policy.autoReconnect) return

    const maxAttempts = policy.maxReconnectAttempts ?? 5
    if (entry.reconnectAttempts >= maxAttempts) {
      this.setStatus(profile.id, 'failed', 'Max reconnect attempts reached')
      this.logger.error(
        'ConnectionManager',
        'Max reconnect attempts reached',
        profile.id
      )
      return
    }

    const delay = policy.reconnectDelay ?? 3000
    entry.reconnectAttempts++
    this.setStatus(profile.id, 'reconnecting')
    this.logger.info(
      'ConnectionManager',
      `Reconnecting in ${delay}ms (attempt ${entry.reconnectAttempts}/${maxAttempts})`,
      profile.id
    )

    entry.reconnectTimer = setTimeout(async () => {
      if (entry.mainWindow) {
        await this.spawnSSHTunnel(profile, entry)
      }
    }, delay)
  }

  private setStatus(profileId: string, status: ConnectionStatus, error?: string): void {
    const entry = this.connections.get(profileId)
    if (!entry) return
    entry.state = { ...entry.state, status, error }
    this.emitStateChange(profileId)
  }

  private emitStateChange(profileId: string): void {
    const entry = this.connections.get(profileId)
    if (!entry) return
    this.emit('stateChanged', profileId, entry.state)
    try {
      if (entry.mainWindow && !entry.mainWindow.isDestroyed()) {
        entry.mainWindow.webContents.send('connection:stateChanged', profileId, entry.state)
      }
    } catch { /* window destroyed between check and send */ }
  }
}
