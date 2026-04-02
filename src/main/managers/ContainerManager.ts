import { exec } from 'child_process'
import { promisify } from 'util'
import type { Profile, ContainerState, ContainerStatus } from '../../shared/types'
import type { EventLogManager } from './EventLogManager'

const execAsync = promisify(exec)

export class ContainerManager {
  private logger: EventLogManager

  constructor(logger: EventLogManager) {
    this.logger = logger
  }

  // ─── Exec helpers ────────────────────────────────────────────────────────────

  private async localExec(command: string): Promise<string> {
    this.logger.debug('ContainerManager', `local exec: ${command}`)
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 })
    if (stderr) this.logger.debug('ContainerManager', `stderr: ${stderr.trim()}`)
    return stdout.trim()
  }

  private async exec(profile: Profile, command: string): Promise<string> {
    if (profile.local) return this.localExec(command)
    return this.sshExec(profile, command)
  }

  private async sshExec(profile: Profile, remoteCommand: string): Promise<string> {
    const sshTarget = profile.ssh.user
      ? `${profile.ssh.user}@${profile.ssh.host}`
      : profile.ssh.host

    const opts: string[] = []
    if (profile.ssh.identityFile) opts.push('-i', profile.ssh.identityFile)
    if (profile.ssh.port) opts.push('-p', String(profile.ssh.port))
    opts.push('-o', 'StrictHostKeyChecking=accept-new')
    opts.push('-o', 'BatchMode=yes')
    opts.push('-o', 'ConnectTimeout=10')

    const sshCmd = `ssh ${opts.join(' ')} ${sshTarget} ${JSON.stringify(remoteCommand)}`
    this.logger.debug('ContainerManager', `exec: ${sshCmd}`, profile.id)

    const { stdout, stderr } = await execAsync(sshCmd, { timeout: 30000 })
    if (stderr) this.logger.debug('ContainerManager', `stderr: ${stderr.trim()}`, profile.id)
    return stdout.trim()
  }

  // ─── Status ─────────────────────────────────────────────────────────────────

  async getStatus(profile: Profile): Promise<ContainerState> {
    if (!profile.container) {
      return { profileId: profile.id, status: 'unknown' }
    }

    const name = profile.container.name

    try {
      const out = await this.exec(
        profile,
        `docker inspect --format '{{.State.Status}}' ${name} 2>/dev/null || echo 'not-found'`
      )

      const raw = out.trim().toLowerCase()
      let status: ContainerStatus = 'unknown'

      if (raw === 'not-found' || raw === '') status = 'not-found'
      else if (raw === 'running') status = 'running'
      else if (raw === 'paused') status = 'paused'
      else if (raw === 'exited' || raw === 'dead') status = 'stopped'
      else if (raw === 'created') status = 'stopped'
      else status = 'unknown'

      return { profileId: profile.id, status, containerName: name }
    } catch (err) {
      this.logger.warn('ContainerManager', `Status check failed: ${err}`, profile.id)
      return { profileId: profile.id, status: 'unknown', error: String(err) }
    }
  }

  // ─── Lifecycle operations ────────────────────────────────────────────────────

  async start(profile: Profile): Promise<void> {
    if (!profile.container) throw new Error('No container configured')
    const { name } = profile.container

    this.logger.info('ContainerManager', `Starting container ${name}`, profile.id)
    const status = await this.getStatus(profile)

    if (status.status === 'not-found') {
      await this.run(profile)
    } else {
      await this.exec(profile, `docker start ${name}`)
    }
  }

  async stop(profile: Profile): Promise<void> {
    if (!profile.container) throw new Error('No container configured')
    const { name } = profile.container

    this.logger.info('ContainerManager', `Stopping container ${name}`, profile.id)
    await this.exec(profile, `docker stop ${name}`)
  }

  async pause(profile: Profile): Promise<void> {
    if (!profile.container) throw new Error('No container configured')
    const { name } = profile.container
    this.logger.info('ContainerManager', `Pausing container ${name}`, profile.id)
    await this.exec(profile, `docker pause ${name}`)
  }

  async unpause(profile: Profile): Promise<void> {
    if (!profile.container) throw new Error('No container configured')
    const { name } = profile.container
    this.logger.info('ContainerManager', `Unpausing container ${name}`, profile.id)
    await this.exec(profile, `docker unpause ${name}`)
  }

  async restart(profile: Profile): Promise<void> {
    if (!profile.container) throw new Error('No container configured')
    const { name } = profile.container

    this.logger.info('ContainerManager', `Restarting container ${name}`, profile.id)
    await this.exec(profile, `docker restart ${name}`)
  }

  async remove(profile: Profile): Promise<void> {
    if (!profile.container) throw new Error('No container configured')
    const { name } = profile.container

    this.logger.info('ContainerManager', `Removing container ${name}`, profile.id)
    await this.exec(profile, `docker rm -f ${name}`)
  }

  async recreate(profile: Profile): Promise<void> {
    const status = await this.getStatus(profile)
    if (status.status !== 'not-found') {
      await this.remove(profile)
    }
    await this.run(profile)
  }

  private async run(profile: Profile): Promise<void> {
    if (!profile.container) throw new Error('No container configured')
    const cmd = this.buildDockerRunCommand(profile)
    this.logger.info('ContainerManager', `Running: ${cmd}`, profile.id)
    await this.exec(profile, cmd)
  }

  // ─── Command builder ─────────────────────────────────────────────────────────

  buildDockerRunCommand(profile: Profile): string {
    if (!profile.container) throw new Error('No container configured')

    const c = profile.container
    const parts: string[] = ['docker', 'run', '-d', '--interactive', '--tty']

    if (c.runtime) parts.push(`--runtime=${c.runtime}`)

    parts.push('--name', c.name)

    if (profile.local) {
      // Local profiles: port mappings come directly from container.ports
      for (const port of c.ports) {
        parts.push('-p', `${port.hostPort}:${port.containerPort}`)
      }
    } else {
      // Remote profiles: derive port mappings from SSH forwards
      // SSH:    -L localPort:localhost:remotePort
      // Docker: -p remotePort:containerPort  (containerPort defaults to remotePort)
      const forwards = (profile.ssh.forwards ?? [])
        .filter((f) => f.remoteHost === 'localhost' || f.remoteHost === '127.0.0.1')

      for (const fwd of forwards) {
        const containerPort = fwd.containerPort ?? fwd.remotePort
        parts.push('-p', `${fwd.remotePort}:${containerPort}`)
      }
    }

    if (c.workspaceMount) {
      const local = c.workspaceMount.localPath
        .replace('${cwd}', profile.workspace?.localPath ?? '.')
        .replace('${projectName}', profile.name)
      parts.push('-v', `${local}:${c.workspaceMount.containerPath}`)
    }

    if (c.workdir) {
      parts.push('-w', c.workdir)
    }

    for (const [k, v] of Object.entries(c.env ?? {})) {
      parts.push('-e', `${k}=${v}`)
    }

    for (const extra of c.extraArgs ?? []) {
      parts.push(extra)
    }

    parts.push(c.image)

    return parts.join(' ')
  }

  // ─── Image port detection ────────────────────────────────────────────────────

  async detectImagePorts(
    sshHost: string,
    sshUser: string | undefined,
    sshPort: number | undefined,
    sshIdentityFile: string | undefined,
    image: string,
    local = false
  ): Promise<number[]> {
    let stdout: string

    if (local) {
      const result = await execAsync(
        `docker image inspect --format '{{json .Config.ExposedPorts}}' ${image}`,
        { timeout: 15000 }
      )
      stdout = result.stdout
    } else {
      const target = sshUser ? `${sshUser}@${sshHost}` : sshHost
      const opts: string[] = []
      if (sshIdentityFile) opts.push('-i', sshIdentityFile)
      if (sshPort) opts.push('-p', String(sshPort))
      opts.push('-o', 'StrictHostKeyChecking=accept-new')
      opts.push('-o', 'BatchMode=yes')
      opts.push('-o', 'ConnectTimeout=10')

      const sshCmd = `ssh ${opts.join(' ')} ${target} ${JSON.stringify(`docker image inspect --format '{{json .Config.ExposedPorts}}' ${image}`)}`
      const result = await execAsync(sshCmd, { timeout: 15000 })
      stdout = result.stdout
    }

    const raw = stdout.trim()
    if (!raw || raw === 'null') return []

    // ExposedPorts format: {"3000/tcp":{},"8080/tcp":{}}
    const parsed: Record<string, unknown> = JSON.parse(raw)
    return Object.keys(parsed)
      .map((k) => parseInt(k))
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b)
  }

  // ─── Log streaming ───────────────────────────────────────────────────────────

  async getLogs(profile: Profile, lines = 100): Promise<string> {
    if (!profile.container) return ''
    const name = profile.container.name
    try {
      return await this.sshExec(profile, `docker logs --tail ${lines} ${name} 2>&1`)
    } catch (err) {
      return `Error fetching logs: ${err}`
    }
  }
}
