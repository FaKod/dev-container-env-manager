import { execFile } from 'child_process'
import type { Profile, ContainerStatus } from '../../shared/types'
import type { EventLogManager } from './EventLogManager'
import { sshBatchOptions, sshTarget, remoteCommand } from './sshCommon'

/**
 * The single place that spawns the `openshell` CLI (Docs/openshell-sandbox-plan.md §3.2).
 *
 * Local profiles run the CLI directly; remote profiles run it on the remote host
 * over SSH (D3-C), mirroring ContainerManager.localExec / sshExec. Local calls
 * use argument arrays (no shell); remote calls quote every argument.
 */

/** Oldest OpenShell release this integration is written against (D13). */
export const OPENSHELL_MIN_VERSION = '0.1.0'

export type OpenShellErrorKind = 'cli-missing' | 'not-found' | 'gateway' | 'ssh' | 'failed'

export class OpenShellError extends Error {
  constructor(
    message: string,
    readonly kind: OpenShellErrorKind
  ) {
    super(message)
    this.name = 'OpenShellError'
  }
}

// ─── Pure helpers (kept free of I/O so they can be unit-tested) ───────────────

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g // eslint-disable-line no-control-regex

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

/** `openshell 0.1.4` → [0, 1, 4]; null if no version is found. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** SandboxPhase name as printed by `sandbox get -o json` → our ContainerStatus (§1.4). */
export function phaseToStatus(phase: string | undefined): ContainerStatus {
  switch ((phase ?? '').toLowerCase()) {
    case 'provisioning':
    case 'starting':
      return 'starting'
    case 'ready':
      return 'running'
    case 'stopping':
    case 'deleting':
    case 'suspending':
      return 'stopping'
    case 'stopped':
    case 'completed':
      return 'stopped'
    case 'suspended':
      return 'paused'
    case 'error':
      return 'failed'
    default:
      return 'unknown'
  }
}

export interface SandboxCondition {
  type?: string
  status?: string
  reason?: string
  message?: string
}

export interface SandboxInfo {
  name?: string
  phase?: string
  conditions?: SandboxCondition[]
  exit_code?: number | null
}

/** Human-readable reason for an Error phase, taken from the sandbox conditions. */
export function sandboxErrorReason(info: SandboxInfo): string | undefined {
  const conds = info.conditions ?? []
  const failing = conds.find((c) => c.status !== 'True' && (c.message || c.reason)) ?? conds.find((c) => c.message)
  if (failing) return [failing.reason, failing.message].filter(Boolean).join(': ')
  if (info.exit_code != null) return `main process exited with code ${info.exit_code}`
  return undefined
}

/** Classify a failed CLI call from its exit code and stderr. */
export function classifyFailure(
  stderr: string,
  exitCode: number | string | null | undefined,
  remote: boolean
): OpenShellErrorKind {
  if (exitCode === 'ENOENT') return 'cli-missing' // local: execFile couldn't find the binary
  if (remote && exitCode === 127) return 'cli-missing' // remote shell: command not found
  if (remote && exitCode === 255) return 'ssh' // ssh's own failure code
  if (/sandbox[^\n]*not found|not ?found[^\n]*sandbox|code: NotFound/i.test(stderr)) return 'not-found'
  if (/transport error|connection refused|unavailable|failed to connect|no gateway|not configured|dns error/i.test(stderr)) {
    return 'gateway'
  }
  return 'failed'
}

/** Last meaningful lines of stderr, without colour codes. */
export function errorMessage(stderr: string, fallback: string): string {
  const lines = stripAnsi(stderr)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
  if (lines.length === 0) return fallback
  return lines.slice(-6).join('\n')
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

interface ExecFailure extends Error {
  code?: number | string
  killed?: boolean
  signal?: string
  stderr?: string
}

export class OpenShellCli {
  private logger: EventLogManager

  constructor(logger: EventLogManager) {
    this.logger = logger
  }

  cliPath(profile: Profile): string {
    return profile.openshell?.cliPath?.trim() || 'openshell'
  }

  /** Flags every invocation carries: no colour, plus the profile's gateway/workspace. */
  globalArgs(profile: Profile): string[] {
    const o = profile.openshell
    const args = ['--color', 'never']
    if (o?.gateway) args.push('-g', o.gateway)
    if (o?.workspace && o.workspace !== 'default') args.push('--workspace', o.workspace)
    return args
  }

  /**
   * Command line that runs `openshell <args>` where the profile's sandboxes
   * live. `interactive` adds `-t` for remote terminals (TerminalManager).
   */
  commandFor(
    profile: Profile,
    args: string[],
    sshOpts: string[] = sshBatchOptions(profile),
    interactive = false
  ): { command: string; args: string[] } {
    const full = [...this.globalArgs(profile), ...args]
    if (profile.local) return { command: this.cliPath(profile), args: full }
    return {
      command: 'ssh',
      args: [
        ...sshOpts,
        ...(interactive ? ['-t'] : []),
        sshTarget(profile),
        remoteCommand(this.cliPath(profile), full)
      ]
    }
  }

  /** Run the CLI and return trimmed stdout; throws OpenShellError on failure. */
  run(profile: Profile, args: string[], timeoutMs = 60_000): Promise<string> {
    const { command, args: argv } = this.commandFor(profile, args)
    const remote = !profile.local
    this.logger.debug('OpenShellCli', `exec: ${command} ${argv.join(' ')}`, profile.id)

    return new Promise((resolve, reject) => {
      execFile(
        command,
        argv,
        {
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: '1' }
        },
        (err, stdout, stderr) => {
          if (stderr?.trim()) this.logger.debug('OpenShellCli', `stderr: ${stripAnsi(stderr).trim()}`, profile.id)
          if (!err) {
            resolve(stdout.trim())
            return
          }
          const failure = err as ExecFailure
          if (failure.killed && failure.signal === 'SIGTERM') {
            reject(new OpenShellError(`openshell ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs / 1000}s`, 'failed'))
            return
          }
          const kind = classifyFailure(stderr ?? '', failure.code, remote)
          reject(new OpenShellError(this.describe(profile, kind, stderr ?? '', failure.message), kind))
        }
      )
    })
  }

  /** Run with `-o json` and parse stdout. */
  async json<T>(profile: Profile, args: string[], timeoutMs?: number): Promise<T> {
    const out = await this.run(profile, [...args, '-o', 'json'], timeoutMs)
    try {
      return JSON.parse(out) as T
    } catch {
      throw new OpenShellError(
        `Unexpected output from openshell ${args.slice(0, 2).join(' ')} (expected JSON): ${out.slice(0, 200)}`,
        'failed'
      )
    }
  }

  private describe(profile: Profile, kind: OpenShellErrorKind, stderr: string, fallback: string): string {
    const where = profile.local ? 'on this machine' : `on ${profile.ssh.host}`
    const detail = errorMessage(stderr, fallback)
    switch (kind) {
      case 'cli-missing':
        return (
          `OpenShell CLI "${this.cliPath(profile)}" not found ${where}. ` +
          'Install OpenShell there, or set the full path to the CLI in the profile (openshell.cliPath).'
        )
      case 'ssh':
        return `SSH to ${profile.ssh.host} failed: ${detail}`
      case 'gateway':
        return (
          `OpenShell gateway not reachable ${where}${profile.openshell?.gateway ? ` (gateway "${profile.openshell.gateway}")` : ''}. ` +
          `Check that the gateway runs and is registered for this user (openshell status). ${detail}`
        )
      default:
        return detail
    }
  }
}
