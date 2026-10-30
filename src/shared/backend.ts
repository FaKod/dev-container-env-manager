import type { Profile } from './types'

// Backend helpers shared by main and renderer. A profile is a Docker profile
// unless it explicitly says otherwise, so stored and imported profiles without
// a `backend` field keep behaving exactly as before.

export function isOpenShell(profile: Profile): boolean {
  return profile.backend === 'openshell' && !!profile.openshell
}

/** True when the profile manages a container or sandbox (not just an SSH host). */
export function hasEnvironment(profile: Profile): boolean {
  return isOpenShell(profile) || !!profile.container
}

/** Container name (Docker) or sandbox name (OpenShell). */
export function environmentName(profile: Profile): string | undefined {
  return isOpenShell(profile) ? profile.openshell!.sandboxName : profile.container?.name
}

/** Image or template the environment is created from, for display. */
export function environmentImage(profile: Profile): string | undefined {
  if (!isOpenShell(profile)) return profile.container?.image
  const o = profile.openshell!
  if (o.template) return `template: ${o.template}`
  return o.image ?? 'gateway default image'
}

/**
 * Substitute ${cwd} / ${projectName} in a workspace path, with the same rules
 * as the Docker `-v` mount in ContainerManager.buildDockerRunCommand.
 */
export function expandWorkspacePath(profile: Profile, path: string): string {
  return path
    .replace('${cwd}', profile.workspace?.localPath ?? '.')
    .replace('${projectName}', profile.name)
}

/** OpenShell gateways reject sandbox names longer than this (openshell-server MAX_ROUTABLE_NAME_LEN). */
export const SANDBOX_NAME_MAX_LEN = 19

/** Sandbox names are DNS-1123 labels: lowercase letters, digits and dashes (D10). */
export function sandboxSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SANDBOX_NAME_MAX_LEN)
    .replace(/-+$/, '')
  return slug || 'sandbox'
}
