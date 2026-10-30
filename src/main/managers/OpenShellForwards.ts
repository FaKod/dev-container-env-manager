import { spawn, type ChildProcess } from 'child_process'
import type { Profile, PortForward, PortForwardState } from '../../shared/types'
import type { EventLogManager } from './EventLogManager'
import { OpenShellCli, stripAnsi } from './OpenShellCli'
import { remoteCommand, sshBatchOptions, sshTarget } from './sshCommon'

/**
 * Port forwards into OpenShell sandboxes (Docs/openshell-sandbox-plan.md, Phase 4, D7-A).
 *
 * One long-lived `openshell forward service` process per forward:
 * - local profiles: spawned directly, listening on localPort;
 * - remote profiles (D3-C): `ssh -tt -L localPort:127.0.0.1:remotePort host
 *   'openshell forward service … --local 127.0.0.1:remotePort'`, so one ssh
 *   process carries both hops. `-tt` gives the remote command a pty, so it gets
 *   SIGHUP and ends when the connection drops instead of lingering on the host.
 *
 * `forward service` exits as soon as the sandbox is no longer Ready (it checks
 * every 2 s), so exited forwards are retried with backoff until stop() is
 * called. ConnectionManager owns this and merges the states into the profile's
 * connection state.
 */

/** Printed by `forward service` once its listener is bound. */
const READY_LINE = /Forwarding\s+\S+\s+->/
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 30_000

interface ForwardProc {
  display: PortForward
  command: string
  args: string[]
  child: ChildProcess | null
  active: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
  retryDelay: number
  lastOutput: string
  lastReason: string
}

export class OpenShellForwards {
  private logger: EventLogManager
  private cli: OpenShellCli
  private onChange: (profileId: string) => void
  private profiles = new Map<string, ForwardProc[]>()

  constructor(logger: EventLogManager, onChange: (profileId: string) => void) {
    this.logger = logger
    this.cli = new OpenShellCli(logger)
    this.onChange = onChange
  }

  states(profileId: string): PortForwardState[] {
    return (this.profiles.get(profileId) ?? []).map((f) => ({ forward: f.display, active: f.active }))
  }

  /**
   * (Re)start the profile's forwards. Running ones are left alone; exited ones
   * waiting for a retry start now. Forward settings changed since the last
   * start take effect after stop().
   */
  start(profile: Profile): void {
    const o = profile.openshell
    if (!o?.forwards?.length) return

    let procs = this.profiles.get(profile.id)
    if (!procs) {
      procs = this.buildProcs(profile)
      this.profiles.set(profile.id, procs)
      this.onChange(profile.id)
    }
    for (const f of procs) {
      if (f.child) continue
      if (f.retryTimer) clearTimeout(f.retryTimer)
      f.retryTimer = null
      f.retryDelay = RETRY_MIN_MS
      this.spawnForward(profile.id, f)
    }
  }

  stop(profileId: string): void {
    const procs = this.profiles.get(profileId)
    if (!procs) return
    this.profiles.delete(profileId)
    for (const f of procs) {
      if (f.retryTimer) clearTimeout(f.retryTimer)
      f.retryTimer = null
      const child = f.child
      f.child = null
      try { child?.kill('SIGTERM') } catch { /* already gone */ }
    }
    this.logger.info('OpenShellForwards', 'Stopped sandbox port forwards', profileId)
    this.onChange(profileId)
  }

  stopAll(): void {
    for (const profileId of [...this.profiles.keys()]) this.stop(profileId)
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private buildProcs(profile: Profile): ForwardProc[] {
    const o = profile.openshell!
    const seen = new Set<number>()
    const procs: ForwardProc[] = []
    for (const fwd of o.forwards ?? []) {
      if (!validPort(fwd.localPort) || !validPort(fwd.targetPort) || seen.has(fwd.localPort)) {
        this.logger.warn('OpenShellForwards', `Skipping invalid or duplicate forward ${JSON.stringify(fwd)}`, profile.id)
        continue
      }
      seen.add(fwd.localPort)
      const { command, args } = this.commandFor(profile, fwd)
      procs.push({
        display: { localPort: fwd.localPort, remoteHost: o.sandboxName, remotePort: fwd.targetPort },
        command,
        args,
        child: null,
        active: false,
        retryTimer: null,
        retryDelay: RETRY_MIN_MS,
        lastOutput: '',
        lastReason: ''
      })
    }
    return procs
  }

  /** Command line for one forward. Exposed for tests. */
  commandFor(
    profile: Profile,
    fwd: { localPort: number; targetPort: number; bindAddress?: string; remotePort?: number }
  ): { command: string; args: string[] } {
    const name = profile.openshell!.sandboxName
    const bind = fwd.bindAddress || '127.0.0.1'
    const service = (listen: string): string[] => [
      'forward', 'service', name, '--target-port', String(fwd.targetPort), '--local', listen
    ]

    if (profile.local) return this.cli.commandFor(profile, service(`${bind}:${fwd.localPort}`))

    const remotePort = fwd.remotePort && validPort(fwd.remotePort) ? fwd.remotePort : fwd.localPort
    return {
      command: 'ssh',
      args: [
        ...sshBatchOptions(profile),
        '-tt',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-L', `${bind}:${fwd.localPort}:127.0.0.1:${remotePort}`,
        sshTarget(profile),
        remoteCommand(this.cli.cliPath(profile), [
          ...this.cli.globalArgs(profile),
          ...service(`127.0.0.1:${remotePort}`)
        ])
      ]
    }
  }

  private spawnForward(profileId: string, f: ForwardProc): void {
    const label = `localhost:${f.display.localPort} -> ${f.display.remoteHost}:${f.display.remotePort}`
    this.logger.debug('OpenShellForwards', `exec: ${f.command} ${f.args.join(' ')}`, profileId)

    // stdin stays an open pipe: with -tt an EOF would be passed to the remote pty.
    const child = spawn(f.command, f.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' }
    })
    f.child = child
    f.lastOutput = ''

    const onOutput = (data: Buffer): void => {
      const text = stripAnsi(data.toString())
      const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
      if (line) f.lastOutput = line
      if (!f.active && READY_LINE.test(text)) {
        f.active = true
        f.retryDelay = RETRY_MIN_MS
        this.logger.info('OpenShellForwards', `Forward up: ${label}`, profileId)
        this.onChange(profileId)
      }
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)

    child.on('error', (err) => {
      f.lastOutput = err.message
    })

    child.on('exit', (code, signal) => {
      if (f.child !== child) return // stopped or replaced
      f.child = null
      const wasActive = f.active
      f.active = false
      if (!this.profiles.has(profileId)) return
      const reason = f.lastOutput || `exit code ${code ?? signal}`
      const msg = `Forward ${label} ${wasActive ? 'closed' : 'failed'}: ${reason}; retrying in ${f.retryDelay / 1000}s`
      // Warn on a new reason; repeats while the sandbox stays down go to debug.
      if (wasActive || reason !== f.lastReason) this.logger.warn('OpenShellForwards', msg, profileId)
      else this.logger.debug('OpenShellForwards', msg, profileId)
      f.lastReason = reason
      this.onChange(profileId)
      f.retryTimer = setTimeout(() => {
        f.retryTimer = null
        if (this.profiles.get(profileId)?.includes(f)) this.spawnForward(profileId, f)
      }, f.retryDelay)
      f.retryDelay = Math.min(f.retryDelay * 2, RETRY_MAX_MS)
    })
  }
}

function validPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536
}
