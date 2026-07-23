import { EventEmitter } from 'events'
import { exec } from 'child_process'
import { writeFileSync, unlink } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { promisify } from 'util'
import * as pty from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import { BrowserWindow } from 'electron'
import type { Profile, TerminalContext, TerminalSession } from '../../shared/types'
import type { EventLogManager } from './EventLogManager'

const execAsync = promisify(exec)

interface TerminalEntry {
  session: TerminalSession
  pty: pty.IPty
  // Profile the terminal was created from — captured so stageImage knows where
  // the terminal's process actually runs (host / local docker / ssh / remote docker).
  profile: Profile
  // Window that currently receives this terminal's data/exit events.
  // Swapped by setTargetWindow when a terminal is detached/attached.
  targetWindow: BrowserWindow
}

export class TerminalManager extends EventEmitter {
  private terminals = new Map<string, TerminalEntry>()
  private logger: EventLogManager
  private suppressAutoDisconnect = new Set<string>()
  private imgCounter = 0

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

    const entry: TerminalEntry = { session, pty: ptyProcess, profile, targetWindow: mainWindow }
    this.terminals.set(id, entry)

    const safeSend = (channel: string, ...args: unknown[]): void => {
      // Read target window per-call so detach/attach retargeting takes effect
      // immediately for any in-flight or future PTY output.
      const win = this.terminals.get(id)?.targetWindow
      if (!win) return
      try {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, ...args)
        }
      } catch {
        // window was destroyed between check and send — ignore
      }
    }

    // Exit events must reach every window: while the terminal is detached, the
    // main window otherwise wouldn't learn that the PTY died and would still
    // show the tab as active after re-attaching.
    const broadcastSend = (channel: string, ...args: unknown[]): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) win.webContents.send(channel, ...args)
        } catch { /* destroyed mid-iteration */ }
      }
    }

    ptyProcess.onData((data) => {
      if (!this.terminals.has(id)) return
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
        broadcastSend('terminal:exited', id)
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

  /** POSIX single-quote a string so it can be safely interpolated into a shell command. */
  private shq(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
  }

  /** Reduce a dropped file's name to a shell-safe basename for the target /tmp path. */
  private safeName(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
    return cleaned || `drop-${Date.now()}-${this.imgCounter++}`
  }

  /**
   * Copy a host file into the environment where this terminal actually runs and
   * return the path its process will see, so the renderer can inject it at the
   * prompt like a real terminal's paste / drag-drop. Mirrors buildCommand's
   * branching (host / local docker / ssh / remote docker). `targetPath` must be
   * a shell-safe absolute path (callers sanitize it). Never deletes `hostPath`.
   * Returns null on failure.
   */
  private async placeInEnvironment(
    entry: TerminalEntry,
    hostPath: string,
    targetPath: string
  ): Promise<{ path: string } | null> {
    const { profile, session } = entry
    // A terminal targets a container only when it was opened in 'container' context.
    const hasContainer = !!profile.container && session.context === 'container'

    try {
      // Local shell (host) — the file is already reachable at its own path.
      if ((profile.local && !hasContainer) || (!profile.local && session.context === 'local')) {
        return { path: hostPath }
      }

      // Local container — copy the host file straight in.
      if (profile.local && hasContainer) {
        const dest = `${profile.container!.name}:${targetPath}`
        await execAsync(`docker cp ${this.shq(hostPath)} ${this.shq(dest)}`, { timeout: 15000 })
        return { path: targetPath }
      }

      // Remote — pipe the bytes over ssh (reusing the same opts buildCommand uses).
      const sshTarget = profile.ssh.user ? `${profile.ssh.user}@${profile.ssh.host}` : profile.ssh.host
      const opts = this.buildCommonSSHOpts(profile).join(' ')
      const remote = hasContainer
        ? // Remote container: land in remote /tmp, docker cp in, drop the remote temp.
          `cat > ${targetPath} && docker cp ${targetPath} ${profile.container!.name}:${targetPath} && rm -f ${targetPath}`
        : `cat > ${targetPath}`
      await execAsync(
        `ssh ${opts} ${this.shq(sshTarget)} ${this.shq(remote)} < ${this.shq(hostPath)}`,
        { timeout: 30000 }
      )
      return { path: targetPath }
    } catch (err) {
      this.logger.warn('TerminalManager', `Failed to stage file for terminal: ${String(err)}`, profile.id)
      return null
    }
  }

  /**
   * Stage a clipboard image (raw PNG bytes) into the terminal's environment and
   * return the path its process will see. Returns null if the terminal is gone
   * or staging fails (renderer then falls back to a text paste).
   */
  async stageImage(terminalId: string, png: Buffer): Promise<{ path: string } | null> {
    const entry = this.terminals.get(terminalId)
    if (!entry) return null

    const file = `devenv-paste-${Date.now()}-${this.imgCounter++}.png`
    const hostPath = join(tmpdir(), file)
    try {
      writeFileSync(hostPath, png)
    } catch (err) {
      this.logger.warn('TerminalManager', `Failed to write clipboard image: ${String(err)}`, entry.profile.id)
      return null
    }

    const result = await this.placeInEnvironment(entry, hostPath, `/tmp/${file}`)
    // If the file was copied into a container/remote, drop our host temp copy;
    // for a local shell the injected path IS hostPath, so keep it.
    if (result && result.path !== hostPath) unlink(hostPath, () => {})
    return result
  }

  /**
   * Stage a dropped host file into the terminal's environment (preserving a
   * sanitized basename) and return the path its process will see. The host file
   * is the user's own and is never deleted.
   */
  async stageFile(terminalId: string, hostPath: string): Promise<{ path: string } | null> {
    const entry = this.terminals.get(terminalId)
    if (!entry) return null
    return this.placeInEnvironment(entry, hostPath, `/tmp/${this.safeName(basename(hostPath))}`)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.terminals.get(terminalId)?.pty.resize(cols, rows)
  }

  destroy(terminalId: string): void {
    const entry = this.terminals.get(terminalId)
    if (!entry) return
    const profileId = entry.session.profileId
    this.terminals.delete(terminalId)
    this.logger.info('TerminalManager', `Destroyed terminal ${terminalId}`)

    // Notify every renderer immediately so it can update UI — both the
    // detached host (if any) and the main window need to know.
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send('terminal:exited', terminalId)
      } catch { /* window destroyed */ }
    }

    // SIGHUP via pty.kill() — propagates through ssh / docker exec without
    // writing a visible "exit" command to the user's terminal first.
    try { entry.pty.kill() } catch { /* already dead */ }

    this.checkAutoDisconnect(profileId)
  }

  destroyForProfile(profileId: string): void {
    this.suppressAutoDisconnect.add(profileId)
    for (const [id, entry] of this.terminals.entries()) {
      if (entry.session.profileId === profileId) {
        this.destroy(id)
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

  /**
   * Route a terminal's data/exit events to a different BrowserWindow.
   * Used when detaching a terminal into its own window or re-attaching it
   * to the main window.
   */
  setTargetWindow(terminalId: string, win: BrowserWindow): void {
    const entry = this.terminals.get(terminalId)
    if (!entry) return
    entry.targetWindow = win
  }
}
