import type { Profile } from '../../shared/types'

// SSH helpers for non-interactive remote commands. The Docker code paths
// (ContainerManager.sshExec / detectImagePorts, TerminalManager.buildCommonSSHOpts)
// still carry their own copies; they are left untouched so the Docker/SSH
// behaviour can't change, and new code uses these instead.

export function sshTarget(profile: Profile): string {
  return profile.ssh.user ? `${profile.ssh.user}@${profile.ssh.host}` : profile.ssh.host
}

/** Options for one-shot `ssh host cmd` calls: no prompts, fail fast. */
export function sshBatchOptions(profile: Profile): string[] {
  const opts: string[] = []
  if (profile.ssh.identityFile) opts.push('-i', profile.ssh.identityFile)
  if (profile.ssh.port) opts.push('-p', String(profile.ssh.port))
  opts.push('-o', 'StrictHostKeyChecking=accept-new')
  opts.push('-o', 'BatchMode=yes')
  opts.push('-o', 'ConnectTimeout=10')
  for (const [k, v] of Object.entries(profile.ssh.extraOptions ?? {})) {
    opts.push('-o', `${k}=${v}`)
  }
  return opts
}

/** Options for interactive `ssh -t host cmd` sessions (terminals). */
export function sshInteractiveOptions(profile: Profile): string[] {
  const opts: string[] = []
  if (profile.ssh.identityFile) opts.push('-i', profile.ssh.identityFile)
  if (profile.ssh.port) opts.push('-p', String(profile.ssh.port))
  if (profile.ssh.keepalive !== false) {
    opts.push('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3')
  }
  for (const [k, v] of Object.entries(profile.ssh.extraOptions ?? {})) {
    opts.push('-o', `${k}=${v}`)
  }
  return opts
}

/** POSIX single-quote a string so it can be safely interpolated into a shell command. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Quote a program path for the remote shell. A leading `~/` is kept expandable
 * (as "$HOME"/…) since cliPath values like `~/.local/bin/openshell` are common.
 */
export function shqPath(path: string): string {
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) return `"$HOME"/${shq(path.slice(2))}`
  return shq(path)
}

/** Build the single remote command string `ssh` sends to the remote shell. */
export function remoteCommand(program: string, args: string[]): string {
  return [shqPath(program), ...args.map(shq)].join(' ')
}
