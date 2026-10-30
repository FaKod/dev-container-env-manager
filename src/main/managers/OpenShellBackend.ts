import type { Profile, ContainerState, OpenShellConfig } from '../../shared/types'
import { expandWorkspacePath } from '../../shared/backend'
import type { ContainerBackend } from './ContainerBackend'
import type { EventLogManager } from './EventLogManager'
import {
  OpenShellCli,
  OpenShellError,
  OPENSHELL_MIN_VERSION,
  compareVersions,
  parseVersion,
  phaseToStatus,
  sandboxErrorReason,
  type SandboxInfo
} from './OpenShellCli'
import { sshTarget } from './sshCommon'

/** Creating a sandbox may pull an image first. */
const CREATE_TIMEOUT_MS = 10 * 60_000
const TRANSITION_TIMEOUT_MS = 2 * 60_000
const STOP_SETTLE_TIMEOUT_MS = 20_000

/**
 * OpenShell sandboxes as a container backend (Docs/openshell-sandbox-plan.md, Phase 2).
 * Every call goes through OpenShellCli, locally or over SSH (D3 = A + C).
 */
export class OpenShellBackend implements ContainerBackend {
  private logger: EventLogManager
  readonly cli: OpenShellCli
  /** Targets (machine + CLI + gateway) that already passed the preflight check. */
  private verified = new Set<string>()

  constructor(logger: EventLogManager) {
    this.logger = logger
    this.cli = new OpenShellCli(logger)
  }

  private config(profile: Profile): OpenShellConfig {
    if (!profile.openshell?.sandboxName) throw new Error('No OpenShell sandbox configured')
    return profile.openshell
  }

  // ─── Preflight (lazy: only runs when an OpenShell profile is used) ──────────

  /**
   * Check that the CLI is present and recent enough and that the gateway is
   * reachable, on whichever machine this profile runs the CLI. Successful
   * checks are cached per target for the app's lifetime; failures are not.
   */
  async ensureReady(profile: Profile): Promise<void> {
    const o = this.config(profile)
    const key = [profile.local ? 'local' : sshTarget(profile), this.cli.cliPath(profile), o.gateway ?? ''].join('|')
    if (this.verified.has(key)) return

    const versionOut = await this.cli.run(profile, ['--version'], 20_000)
    const version = parseVersion(versionOut)
    const min = parseVersion(OPENSHELL_MIN_VERSION)!
    if (!version) {
      this.logger.warn('OpenShell', `Could not parse CLI version from "${versionOut}"`, profile.id)
    } else if (compareVersions(version, min) < 0) {
      throw new OpenShellError(
        `OpenShell ${version.join('.')} is too old; ${OPENSHELL_MIN_VERSION} or newer is required.`,
        'failed'
      )
    } else {
      this.logger.info('OpenShell', `OpenShell CLI ${version.join('.')}`, profile.id)
    }

    const status = await this.cli.json<{ status?: string }>(profile, ['status'], 20_000)
    if (!status.status?.startsWith('connected')) {
      const where = profile.local ? 'on this machine' : `on ${profile.ssh.host}`
      throw new OpenShellError(
        status.status === 'not_configured'
          ? `No OpenShell gateway is registered ${where}. Register one with "openshell gateway add" and select it.`
          : `OpenShell gateway ${o.gateway ? `"${o.gateway}" ` : ''}is not reachable ${where} (status: ${status.status ?? 'unknown'}).`,
        'gateway'
      )
    }
    this.verified.add(key)
  }

  // ─── Status ─────────────────────────────────────────────────────────────────

  private async getInfo(profile: Profile): Promise<SandboxInfo | null> {
    try {
      return await this.cli.json<SandboxInfo>(profile, ['sandbox', 'get', this.config(profile).sandboxName], 30_000)
    } catch (err) {
      if (err instanceof OpenShellError && err.kind === 'not-found') return null
      throw err
    }
  }

  async getStatus(profile: Profile): Promise<ContainerState> {
    if (!profile.openshell) return { profileId: profile.id, status: 'unknown' }
    const name = profile.openshell.sandboxName
    try {
      const info = await this.getInfo(profile)
      if (!info) return { profileId: profile.id, status: 'not-found', containerName: name }
      const status = phaseToStatus(info.phase)
      return {
        profileId: profile.id,
        status,
        containerName: name,
        error: status === 'failed' ? sandboxErrorReason(info) : undefined
      }
    } catch (err) {
      this.logger.warn('OpenShell', `Status check failed: ${errText(err)}`, profile.id)
      return { profileId: profile.id, status: 'unknown', containerName: name, error: errText(err) }
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** Raw sandbox phase in lowercase (`ready`, `error`, …), or `not-found`. */
  private async phase(profile: Profile): Promise<string> {
    const info = await this.getInfo(profile)
    return info ? (info.phase ?? 'unknown').toLowerCase() : 'not-found'
  }

  /**
   * Bring the sandbox to Ready, creating it if needed. The phase handling
   * follows what the gateway accepts (OpenShell 0.1.6, plan §8.3):
   * - Error: `start` is refused, or wedges the sandbox in Starting; stop first.
   * - Completed: `start` is allowed but can fail and leave it in Error; then stop + start.
   * - Stopping/Suspending/Deleting: let the transition finish, then decide.
   */
  async start(profile: Profile): Promise<void> {
    const name = this.config(profile).sandboxName
    await this.ensureReady(profile)
    let phase = await this.phase(profile)
    if (phase === 'stopping' || phase === 'suspending' || phase === 'deleting') {
      await this.waitFor(profile, (s) => s !== 'stopping')
      phase = await this.phase(profile)
    }

    switch (phase) {
      case 'not-found':
        await this.create(profile)
        break
      case 'ready':
        return
      case 'provisioning':
      case 'starting':
        break // already on its way; wait below
      case 'suspended':
        this.logger.info('OpenShell', `Resuming sandbox ${name}`, profile.id)
        await this.cli.run(profile, ['sandbox', 'resume', name])
        break
      case 'error':
        this.logger.info('OpenShell', `Sandbox ${name} is in Error; stopping before start`, profile.id)
        await this.stopSandbox(profile)
        await this.startStopped(profile)
        break
      case 'completed':
        try {
          await this.startStopped(profile)
        } catch (err) {
          if ((await this.phase(profile)) !== 'error') throw err
          this.logger.warn('OpenShell', `Start after Completed failed, retrying via stop: ${errText(err)}`, profile.id)
          await this.stopSandbox(profile)
          await this.startStopped(profile)
        }
        break
      default: // stopped, unknown
        await this.startStopped(profile)
    }
    await this.waitUntilReady(profile)
  }

  private async startStopped(profile: Profile): Promise<void> {
    const name = this.config(profile).sandboxName
    this.logger.info('OpenShell', `Starting sandbox ${name}`, profile.id)
    await this.cli.run(profile, ['sandbox', 'start', name])
  }

  /** Terminals can only `exec` into a Ready sandbox, so start() returns only once it is. */
  private async waitUntilReady(profile: Profile): Promise<void> {
    const name = this.config(profile).sandboxName
    try {
      await this.waitFor(profile, (s) => s === 'running' || s === 'failed' || s === 'stopped' || s === 'not-found')
    } catch {
      throw new Error(`Sandbox ${name} did not become ready in time. If it stays in Starting, use Recreate.`)
    }
    const state = await this.getStatus(profile)
    if (state.status !== 'running') {
      throw new Error(`Sandbox ${name} did not start (status: ${state.status}${state.error ? `, ${state.error}` : ''})`)
    }
  }

  async stop(profile: Profile): Promise<void> {
    const name = this.config(profile).sandboxName
    const phase = await this.phase(profile)
    // Nothing to stop. `stop` on Completed doesn't return, so it must be skipped.
    if (phase === 'not-found' || phase === 'stopped' || phase === 'completed') return
    if (phase === 'provisioning' || phase === 'starting') {
      throw new Error(`Sandbox ${name} is still starting and can't be stopped yet. If it stays stuck, use Recreate.`)
    }
    this.logger.info('OpenShell', `Stopping sandbox ${name}`, profile.id)
    await this.stopSandbox(profile)
  }

  /**
   * `sandbox stop`, tolerating a CLI quirk (OpenShell 0.1.6): stopping a sandbox
   * whose main process failed makes the CLI exit with "MainProcessFailed: …
   * while waiting for Stopped", because its first status read still shows
   * Error, although the gateway accepted the stop. So on failure, give the
   * sandbox a moment to reach Stopped and only rethrow if it doesn't.
   */
  private async stopSandbox(profile: Profile): Promise<void> {
    const name = this.config(profile).sandboxName
    try {
      await this.cli.run(profile, ['sandbox', 'stop', name])
    } catch (err) {
      try {
        await this.waitFor(profile, (s) => s === 'stopped' || s === 'not-found', STOP_SETTLE_TIMEOUT_MS)
      } catch {
        throw err
      }
      this.logger.debug('OpenShell', `stop reported "${errText(err)}" but sandbox ${name} stopped`, profile.id)
    }
  }

  /** D9: suspend if the driver supports it (the Docker driver doesn't), otherwise stop. */
  async pause(profile: Profile): Promise<void> {
    const name = this.config(profile).sandboxName
    this.logger.info('OpenShell', `Suspending sandbox ${name}`, profile.id)
    try {
      await this.cli.run(profile, ['sandbox', 'suspend', name])
    } catch (err) {
      if (err instanceof OpenShellError && err.kind !== 'failed') throw err
      this.logger.warn('OpenShell', `Suspend failed, stopping instead: ${errText(err)}`, profile.id)
      await this.stop(profile)
    }
  }

  async unpause(profile: Profile): Promise<void> {
    // start() resumes a suspended sandbox and starts one that pause() stopped
    await this.start(profile)
  }

  async restart(profile: Profile): Promise<void> {
    this.logger.info('OpenShell', `Restarting sandbox ${this.config(profile).sandboxName}`, profile.id)
    await this.stop(profile)
    await this.start(profile)
  }

  async remove(profile: Profile): Promise<void> {
    const name = this.config(profile).sandboxName
    this.logger.info('OpenShell', `Deleting sandbox ${name}`, profile.id)
    try {
      await this.cli.run(profile, ['sandbox', 'delete', name])
    } catch (err) {
      if (err instanceof OpenShellError && err.kind === 'not-found') return
      throw err
    }
    // Deletion is asynchronous; wait so a following create doesn't hit the old sandbox.
    await this.waitFor(profile, (s) => s === 'not-found')
  }

  async recreate(profile: Profile): Promise<void> {
    await this.ensureReady(profile)
    const { status } = await this.getStatus(profile)
    if (status !== 'not-found') await this.remove(profile)
    await this.create(profile)
    await this.waitUntilReady(profile)
  }

  async getLogs(profile: Profile, lines = 100): Promise<string> {
    if (!profile.openshell) return ''
    try {
      return await this.cli.run(profile, ['logs', profile.openshell.sandboxName, '-n', String(lines)], 30_000)
    } catch (err) {
      return `Error fetching logs: ${errText(err)}`
    }
  }

  private async create(profile: Profile): Promise<void> {
    const args = this.buildCreateArgs(profile)
    this.logger.info('OpenShell', `Creating sandbox: openshell ${args.join(' ')}`, profile.id)
    await this.cli.run(profile, args, CREATE_TIMEOUT_MS)
  }

  /** Poll status until `done` holds, or give up after `timeoutMs`. */
  private async waitFor(
    profile: Profile,
    done: (status: ContainerState['status']) => boolean,
    timeoutMs = TRANSITION_TIMEOUT_MS
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { status } = await this.getStatus(profile)
      if (done(status)) return
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for sandbox ${profile.openshell?.sandboxName} (status: ${status})`)
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  // ─── Command builder ────────────────────────────────────────────────────────

  buildCreateArgs(profile: Profile): string[] {
    const o = this.config(profile)
    const args = ['sandbox', 'create', '--name', o.sandboxName, '--detach', '--no-auto-providers']

    if (o.template) {
      // --template excludes --from/--cpu/--memory/--gpu/--env/--driver-config-json
      args.push('--template', o.template)
    } else {
      if (o.image) args.push('--from', o.image)
      if (o.cpu) args.push('--cpu', o.cpu)
      if (o.memory) args.push('--memory', o.memory)
      if (o.gpu === true) args.push('--gpu')
      else if (typeof o.gpu === 'number') args.push('--gpu', String(o.gpu))
      for (const [k, v] of Object.entries(o.env ?? {})) args.push('--env', `${k}=${v}`)
    }

    const driverConfig = this.buildDriverConfig(profile)
    if (driverConfig) {
      if (o.template) {
        throw new Error(
          'A workspace mount or driver config cannot be combined with an OpenShell template. ' +
            'Put the mount into the template, or use an image instead.'
        )
      }
      args.push('--driver-config-json', driverConfig)
    }

    if (o.policyFile) args.push('--policy', expandWorkspacePath(profile, o.policyFile))
    for (const p of o.providers ?? []) args.push('--provider', p)
    for (const [k, v] of Object.entries(o.labels ?? {})) args.push('--label', `${k}=${v}`)
    // Without a main command the main process is a login shell; `always` brings
    // it back if someone attaches and exits it, instead of ending the sandbox.
    const restartPolicy = o.restartPolicy ?? (o.mainCommand?.length ? undefined : 'always')
    if (restartPolicy) args.push('--restart-policy', restartPolicy)

    if (o.mainCommand?.length) args.push('--', ...o.mainCommand)
    return args
  }

  /**
   * Merge the workspace bind mount (D2-A) into the user's driver config JSON,
   * under the gateway driver's key. Returns undefined when there is neither.
   */
  buildDriverConfig(profile: Profile): string | undefined {
    const o = this.config(profile)
    const driver = o.driver ?? 'docker'

    let config: Record<string, unknown> = {}
    if (o.driverConfigJson?.trim()) {
      try {
        config = JSON.parse(o.driverConfigJson)
      } catch (err) {
        throw new Error(`Invalid OpenShell driver config JSON: ${errText(err)}`)
      }
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new Error('OpenShell driver config JSON must be an object')
      }
    }

    if (o.workspaceMount) {
      const source = expandWorkspacePath(profile, o.workspaceMount.localPath)
      const target = o.workspaceMount.targetPath.replace(/\/+$/, '')
      if (!source.startsWith('/')) {
        throw new Error(`Workspace mount source must be an absolute path on the gateway host (got "${source}")`)
      }
      if (!target.startsWith('/sandbox/')) {
        throw new Error(`Workspace mount target must be below /sandbox, e.g. /sandbox/project (got "${o.workspaceMount.targetPath}")`)
      }
      const section = (config[driver] ?? {}) as { mounts?: unknown[] }
      const mounts = Array.isArray(section.mounts) ? section.mounts : []
      config[driver] = {
        ...section,
        mounts: [...mounts, { type: 'bind', source, target, read_only: o.workspaceMount.readOnly ?? false }]
      }
    }

    return Object.keys(config).length > 0 ? JSON.stringify(config) : undefined
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
