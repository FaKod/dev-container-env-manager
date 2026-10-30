// ─── Port & Network ───────────────────────────────────────────────────────────

export interface PortForward {
  localPort: number   // SSH local port  (also the host port exposed on the remote machine)
  remoteHost: string
  remotePort: number  // SSH remote port (also the host port mapped into the container)
  containerPort?: number // container-side port for docker -p; defaults to remotePort if omitted
}

export interface ContainerPort {
  hostPort: number
  containerPort: number
}

// ─── Profile sub-configs ──────────────────────────────────────────────────────

export interface SSHConfig {
  host: string
  user?: string
  port?: number
  identityFile?: string
  forwards: PortForward[]
  keepalive?: boolean
  extraOptions?: Record<string, string>
}

export interface WorkspaceMount {
  localPath: string
  containerPath: string
}

export interface ContainerConfig {
  name: string
  image: string
  runtime?: string
  shell?: string
  terminalMode?: 'exec' | 'attach' | 'smart'
  ports: ContainerPort[]
  workspaceMount?: WorkspaceMount
  workdir?: string
  interactive?: boolean
  env?: Record<string, string>
  extraArgs?: string[]
}

// ─── OpenShell sandbox backend ────────────────────────────────────────────────
// See Docs/openshell-sandbox-plan.md. Profiles without `backend` are Docker
// profiles; the `openshell` block is only read when backend === 'openshell'.

export type ProfileBackend = 'docker' | 'openshell'

export interface OpenShellForward {
  localPort: number     // listener on this machine
  targetPort: number    // loopback port inside the sandbox
  bindAddress?: string  // default 127.0.0.1
}

export interface OpenShellWorkspaceMount {
  localPath: string   // path on the gateway host; supports ${cwd} / ${projectName}
  targetPath: string  // must be below /sandbox, not /sandbox itself
  readOnly?: boolean  // default false here (OpenShell's own default is true)
}

export interface OpenShellConfig {
  gateway?: string                // registered gateway name; omit = active gateway
  cliPath?: string                // `openshell` on the target (local or remote host); default 'openshell'
  workspace?: string              // OpenShell workspace, default 'default'
  sandboxName: string             // stable, set at profile creation (D10)
  driver?: 'docker' | 'podman' | 'vm' // gateway compute driver, keys the driver config JSON; default 'docker'
  image?: string                  // --from; omit = gateway default image
  template?: string               // --template; excludes image/cpu/memory/gpu/env
  mainCommand?: string[]          // after `--` (D8)
  restartPolicy?: 'never' | 'on-failure' | 'always'
  policyFile?: string             // --policy (D5)
  policyPreset?: string           // D5 presets
  providers?: string[]            // --provider (D6)
  cpu?: string                    // e.g. '2', '500m'
  memory?: string                 // e.g. '4Gi'
  gpu?: number | true             // --gpu [COUNT]
  env?: Record<string, string>    // non-secret only
  labels?: Record<string, string>
  workspaceMount?: OpenShellWorkspaceMount // D2-A; becomes a bind entry in driver config
  uploads?: { localPath: string; sandboxPath?: string; gitIgnore?: boolean }[] // D2-B fallback
  forwards?: OpenShellForward[]   // D7
  driverConfigJson?: string       // advanced; requires gateway opt-in
}

export interface TerminalConfig {
  presentation: 'tab' | 'window' | 'pane'
  defaultContext: TerminalContext
  keepVisibleWhenDisconnected?: boolean
}

export interface ConnectionPolicy {
  autoReconnect?: boolean
  autoConnectOnStart?: boolean
  preventDuplicateConnections?: boolean
  existingContainerBehavior?: 'attach' | 'start' | 'recreate' | 'ask' | 'attach-or-recreate'
  /** Applies only when the app window closes, not on manual disconnect */
  onDisconnectBehavior?: 'stop' | 'pause' | 'leave'
  reconnectDelay?: number
  maxReconnectAttempts?: number
}

export interface WorkspaceConfig {
  localPath?: string
  recentPaths?: string[]
}

// ─── Project ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export interface Profile {
  id: string
  name: string
  color?: string
  icon?: string
  local?: boolean
  ssh: SSHConfig
  container?: ContainerConfig
  backend?: ProfileBackend      // undefined === 'docker'
  openshell?: OpenShellConfig
  terminal: TerminalConfig
  connectionPolicy: ConnectionPolicy
  workspace?: WorkspaceConfig
  projectId?: string
  createdAt: string
  updatedAt: string
}

// ─── Connection ───────────────────────────────────────────────────────────────

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'reconnecting'
  | 'failed'

export interface PortForwardState {
  forward: PortForward
  active: boolean
}

export interface ConnectionState {
  profileId: string
  status: ConnectionStatus
  connectedAt?: string
  error?: string
  portForwards: PortForwardState[]
}

// ─── Container ────────────────────────────────────────────────────────────────

export type ContainerStatus =
  | 'unknown'
  | 'not-found'
  | 'running'
  | 'stopped'
  | 'paused'
  | 'failed'
  | 'starting'
  | 'stopping'

export interface ContainerState {
  profileId: string
  status: ContainerStatus
  containerName?: string
  error?: string
}

// ─── Terminal ─────────────────────────────────────────────────────────────────

export type TerminalContext = 'local' | 'ssh' | 'container'

export interface TerminalSession {
  id: string
  profileId: string
  context: TerminalContext
  title: string
  active: boolean
  hasUnread?: boolean
  /**
   * Set on sessions rebuilt from the previous run: the tab/window exists but no
   * PTY is behind it yet. PTYs die with the app, so a restored session is only
   * a stub until the user reconnects it — see SessionManager / activateStub.
   */
  restored?: boolean
}

// ─── Session persistence ──────────────────────────────────────────────────────

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** One terminal as written to disk. Deliberately free of any PTY handle. */
export interface PersistedTerminal {
  id: string
  profileId: string
  context: TerminalContext
  title: string
  detached?: boolean
  hidden?: boolean
  /** Last known frame of the detached window hosting this terminal. */
  bounds?: WindowBounds
}

export interface PersistedSession {
  terminals: PersistedTerminal[]
  activeTerminalId: string | null
  activeProfileId: string | null
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  source: string
  profileId?: string
  message: string
  details?: unknown
}
