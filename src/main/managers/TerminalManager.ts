import { EventEmitter } from 'events'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as pty from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import type { BrowserWindow } from 'electron'
import type { Profile, TerminalContext, TerminalSession } from '../../shared/types'
import type { EventLogManager } from './EventLogManager'

const execAsync = promisify(exec)

interface TerminalEntry {
  session: TerminalSession
  pty: pty.IPty
  mainWindow: BrowserWindow
}

export class TerminalManager extends EventEmitter {
  private terminals = new Map<string, TerminalEntry>()
  private logger: EventLogManager
  private suppressAutoDisconnect = new Set<string>()

  constructor(logger: EventLogManager) {
    super()
    this.logger = logger
  }

  async createTerminal(
    profile: Profile,
    context: TerminalContext,
    mainWindow: BrowserWindow,
    cols = 80,
    rows = 24
  ): Promise<TerminalSession> {
    const id = uuidv4()

    const { command, args } = await this.buildCommand(profile, context)
    this.logger.debug(
      'TerminalManager',
      `Spawning terminal [mode=${profile.container?.terminalMode ?? 'smart'}]: ${command} ${args.join(' ')}`,
      profile.id
    )

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME ?? '/',
      env: { ...process.env } as Record<string, string>
    })

    const session: TerminalSession = {
      id,
      profileId: profile.id,
      context,
      title: this.buildTitle(profile, context),
      active: true
    }

    const entry: TerminalEntry = { session, pty: ptyProcess, mainWindow }
    this.terminals.set(id, entry)

    const safeSend = (channel: string, ...args: unknown[]): void => {
      try {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channel, ...args)
        }
      } catch {
        // window was destroyed between check and send — ignore
      }
    }

    ptyProcess.onData((data) => {
      safeSend('terminal:data', id, data)
    })

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.logger.info(
        'TerminalManager',
        `Terminal ${id} exited (code=${exitCode}, signal=${signal})`,
        profile.id
      )
      const e = this.terminals.get(id)
      if (e) {
        e.session.active = false
        safeSend('terminal:exited', id)
        this.checkAutoDisconnect(e.session.profileId)
      }
    })

    this.logger.info('TerminalManager', `Created terminal ${id} (${context})`, profile.id)
    return session
  }

  private async buildCommand(
    profile: Profile,
    context: TerminalContext
  ): Promise<{ command: string; args: string[] }> {
    // Local profiles run everything on this machine — no SSH wrapper
    if (profile.local) {
      if (context === 'local' || context === 'ssh' || !profile.container) {
        const shell = process.env.SHELL ?? '/bin/bash'
        return { command: shell, args: [] }
      }

      const containerName = profile.container.name
      const mode = profile.container.terminalMode ?? 'smart'

      if (mode === 'attach' || mode === 'smart') {
        const activeForProfile = Array.from(this.terminals.values()).filter(
          (e) => e.session.profileId === profile.id && e.session.active
        ).length

        if (activeForProfile === 0) {
          return {
            command: 'docker',
            args: ['attach', '--sig-proxy=false', '--detach-keys=', containerName]
          }
        }
      }

      let shellArgs: string[]
      if (profile.container.shell) {
        shellArgs = profile.container.shell.split(/\s+/).filter(Boolean)
      } else {
        shellArgs = await this.detectContainerCmdLocal(profile, containerName)
      }

      return { command: 'docker', args: ['exec', '-it', containerName, ...shellArgs] }
    }

    const sshTarget = profile.ssh.user
      ? `${profile.ssh.user}@${profile.ssh.host}`
      : profile.ssh.host

    const commonSSHOpts = this.buildCommonSSHOpts(profile)

    if (context === 'local') {
      const shell = process.env.SHELL ?? '/bin/bash'
      return { command: shell, args: [] }
    }

    if (context === 'ssh') {
      return {
        command: 'ssh',
        args: [...commonSSHOpts, '-t', sshTarget]
      }
    }

    // container context
    if (!profile.container) {
      return { command: 'ssh', args: [...commonSSHOpts, '-t', sshTarget] }
    }

    const containerName = profile.container.name
    const mode = profile.container.terminalMode ?? 'smart'

    if (mode === 'attach' || mode === 'smart') {
      const activeForProfile = Array.from(this.terminals.values()).filter(
        (e) => e.session.profileId === profile.id && e.session.active
      ).length

      if (activeForProfile === 0) {
        return {
          command: 'ssh',
          args: [
            ...commonSSHOpts,
            '-t',
            sshTarget,
            'docker', 'attach',
            '--sig-proxy=false',
            '--detach-keys=',
            containerName
          ]
        }
      }
      // >0 active terminals already open — fall through to docker exec
    }

    // exec (default): spawn a new shell inside the container
    let shellArgs: string[]
    if (profile.container.shell) {
      shellArgs = profile.container.shell.split(/\s+/).filter(Boolean)
    } else {
      shellArgs = await this.detectContainerCmd(profile, sshTarget, commonSSHOpts, containerName)
    }

    return {
      command: 'ssh',
      args: [
        ...commonSSHOpts,
        '-t',
        sshTarget,
        'docker', 'exec', '-it',
        containerName,
        ...shellArgs
      ]
    }
  }

  private async detectContainerCmdLocal(
    profile: Profile,
    containerName: string
  ): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        `docker inspect --format '{{json .Config.Cmd}}' ${containerName}`,
        { timeout: 8000 }
      )
      const raw = stdout.trim()
      if (raw && raw !== 'null') {
        const parts: string[] = JSON.parse(raw)
        if (parts.length > 0) {
          this.logger.info('TerminalManager', `Detected CMD: ${parts.join(' ')}`, profile.id)
          return parts
        }
      }
    } catch {
      // fall back
    }
    return ['bash']
  }

  private async detectContainerCmd(
    profile: Profile,
    sshTarget: string,
    sshOpts: string[],
    containerName: string
  ): Promise<string[]> {
    try {
      const sshCmd = `ssh ${sshOpts.join(' ')} ${sshTarget} "docker inspect --format '{{json .Config.Cmd}}' ${containerName}"`
      const { stdout } = await execAsync(sshCmd, { timeout: 8000 })
      const raw = stdout.trim()
      if (raw && raw !== 'null') {
        const parts: string[] = JSON.parse(raw)
        if (parts.length > 0) {
          this.logger.info('TerminalManager', `Detected CMD: ${parts.join(' ')}`, profile.id)
          return parts
        }
      }
    } catch {
      // detection failed, fall back
    }
    return ['bash']
  }

  private buildCommonSSHOpts(profile: Profile): string[] {
    const opts: string[] = []

    if (profile.ssh.identityFile) {
      opts.push('-i', profile.ssh.identityFile)
    }

    if (profile.ssh.port) {
      opts.push('-p', String(profile.ssh.port))
    }

    if (profile.ssh.keepalive !== false) {
      opts.push('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3')
    }

    for (const [k, v] of Object.entries(profile.ssh.extraOptions ?? {})) {
      opts.push('-o', `${k}=${v}`)
    }

    return opts
  }

  private buildTitle(profile: Profile, _context: TerminalContext): string {
    return profile.name
  }

  write(terminalId: string, data: string): void {
    this.terminals.get(terminalId)?.pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.terminals.get(terminalId)?.pty.resize(cols, rows)
  }

  destroy(terminalId: string, hard = false): void {
    const entry = this.terminals.get(terminalId)
    if (!entry) return
    const profileId = entry.session.profileId
    this.terminals.delete(terminalId)
    this.logger.info('TerminalManager', `Destroyed terminal ${terminalId}`)

    // Notify the renderer immediately so it can update UI
    try {
      if (!entry.mainWindow.isDestroyed()) {
        entry.mainWindow.webContents.send('terminal:exited', terminalId)
      }
    } catch { /* window destroyed */ }

    if (!hard) {
      // Send 'exit' so the remote shell (and docker exec) exits cleanly
      try { entry.pty.write('exit\n') } catch { /* already dead */ }
      // Force-kill after 300 ms in case exit didn't propagate in time
      setTimeout(() => {
        try { entry.pty.kill() } catch { /* already dead */ }
      }, 300)
    } else {
      // Hard kill — skip exit\n so no buffered command reaches the remote on resume
      try { entry.pty.kill() } catch { /* already dead */ }
    }

    this.checkAutoDisconnect(profileId)
  }

  destroyForProfile(profileId: string, hard = false): void {
    this.suppressAutoDisconnect.add(profileId)
    for (const [id, entry] of this.terminals.entries()) {
      if (entry.session.profileId === profileId) {
        this.destroy(id, hard)
      }
    }
    this.suppressAutoDisconnect.delete(profileId)
  }

  private checkAutoDisconnect(profileId: string): void {
    if (this.suppressAutoDisconnect.has(profileId)) return
    const hasActive = Array.from(this.terminals.values()).some(
      (e) => e.session.profileId === profileId && e.session.active
    )
    if (!hasActive) this.emit('profileTerminalsEmpty', profileId)
  }

  getSessions(): TerminalSession[] {
    return Array.from(this.terminals.values()).map((e) => e.session)
  }

  getSession(terminalId: string): TerminalSession | undefined {
    return this.terminals.get(terminalId)?.session
  }
}
