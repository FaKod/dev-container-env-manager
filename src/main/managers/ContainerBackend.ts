import type { Profile, ContainerState } from '../../shared/types'
import { isOpenShell } from '../../shared/backend'

/**
 * Lifecycle operations shared by the Docker backend (ContainerManager) and the
 * OpenShell backend (OpenShellBackend). ipcHandlers picks one per profile via
 * `profile.backend`; profiles without it are Docker profiles.
 */
export interface ContainerBackend {
  getStatus(profile: Profile): Promise<ContainerState>
  /** Start, creating the container/sandbox first if it doesn't exist. */
  start(profile: Profile): Promise<void>
  stop(profile: Profile): Promise<void>
  pause(profile: Profile): Promise<void>
  unpause(profile: Profile): Promise<void>
  restart(profile: Profile): Promise<void>
  remove(profile: Profile): Promise<void>
  recreate(profile: Profile): Promise<void>
  getLogs(profile: Profile, lines?: number): Promise<string>
}

/** Backend for a profile: OpenShell only when the profile asks for it, Docker otherwise. */
export function selectBackend(
  profile: Profile,
  docker: ContainerBackend,
  openshell: ContainerBackend
): ContainerBackend {
  return isOpenShell(profile) ? openshell : docker
}
