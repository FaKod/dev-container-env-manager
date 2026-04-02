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
  local?: boolean
  ssh: SSHConfig
  container?: ContainerConfig
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
