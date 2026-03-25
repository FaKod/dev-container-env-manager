# DevEnv Manager — Application Reference

## What It Is

A desktop application for managing remote development environments consisting of an SSH tunnel, a Docker container, and an integrated terminal. It makes remote development feel like launching a local app: select a profile, click Connect, and get a managed terminal with full lifecycle control.

**Stack:** Electron 41 · electron-vite 2 · React 18 · TypeScript · xterm.js · node-pty · electron-store · Zustand

---

## Core Workflow

1. Create a profile with SSH host, port forwards, and container image
2. Click **Connect** — the app opens the SSH tunnel and starts or attaches to the container
3. A terminal tab opens in the container shell immediately
4. Use the status panel to monitor connection state, port forwards, container status, and service health
5. Click service URLs to open them in the browser
6. Disconnect cleanly — container is stopped, SSH tunnel is closed, terminal tabs dim

---

## Profiles

Each profile represents one remote development target. Profiles are persisted locally via electron-store.

### Fields

| Section | Fields |
|---------|--------|
| **Identity** | `name` (also used as the container name) |
| **SSH** | `host`, `user`, `port`, `identityFile`, `forwards[]`, `keepalive`, `extraOptions` |
| **Container** | `image`, `runtime`, `shell`, `workspaceMount`, `workdir`, `env`, `extraArgs`, `interactive` |
| **Terminal** | `defaultContext` (local / ssh / container), `presentation` (tab), `keepVisibleWhenDisconnected` |
| **Service** | `urls[]`, `healthcheckPath` |
| **Connection Policy** | `autoReconnect`, `preventDuplicateConnections`, `existingContainerBehavior`, `reconnectDelay`, `maxReconnectAttempts` |
| **Workspace** | `localPath`, `recentPaths[]` |

### Container name
The container name always equals the profile name. This is enforced on create and update.

### Profile operations
- Create, edit, clone, delete
- Export single profile as JSON
- Export all profiles as JSON file (via save dialog)
- Import single profile or batch from JSON file
- Original `createdAt` timestamp is preserved on import

---

## Port Forwarding

Each port forward entry has two distinct ports:

- **Host port** — used as both the SSH local port and remote port: `-L hostPort:localhost:hostPort`. Also the Docker host-side port.
- **Container port** — the port inside the container for Docker: `-p hostPort:containerPort`.

Multiple forwards per profile are supported. An **Auto-detect** button SSHes to the remote host and reads `EXPOSE` ports from the container image via `docker image inspect`.

Active forwards are shown in the status panel with live active/inactive indicators.

---

## Connection Management

The SSH tunnel runs as a background `ssh -N` process (no interactive shell, port-forwarding only).

### Connection states

| State | Meaning |
|-------|---------|
| `disconnected` | No active connection |
| `connecting` | SSH process spawned, waiting for confirmation |
| `connected` | Tunnel established and active |
| `degraded` | Connection assumed established (timeout fallback) |
| `reconnecting` | Auto-reconnect in progress |
| `failed` | Max reconnect attempts reached |

### Auto-reconnect
Configurable per profile: delay, max attempts. Reconnect is scheduled on unexpected SSH process exit. Manual disconnect cancels any pending reconnect.

### Launch vs Connect
- **Connect** — opens SSH tunnel only
- **Launch** — opens SSH tunnel AND handles container lifecycle (attach if running, start if stopped, create if not found), then opens a terminal

---

## Container Lifecycle

All container operations run as SSH exec commands on the remote host.

### Operations
- **Start** — `docker start <name>` (or `docker run` if not found)
- **Stop** — `docker stop <name>` (also disconnects SSH)
- **Restart** — `docker restart <name>`, then opens a new terminal
- **Recreate** — removes and re-runs the container, then opens a new terminal
- **Delete** — `docker rm -f <name>` with confirmation dialog
- **Shell** — opens a new terminal tab in the container

### docker run command
Built from profile data:

```
docker run -d --interactive --tty
  [--runtime=<runtime>]
  --name <profileName>
  -p hostPort:containerPort   (one per SSH forward)
  [-v localPath:containerPath]
  [-w workdir]
  [-e KEY=VALUE ...]
  [extraArgs...]
  <image>
```

### Shell auto-detection
If no `shell` is configured, the app SSHes to the host and runs `docker inspect --format '{{json .Config.Cmd}}' <name>` to determine the container's default command. Falls back to `bash`.

### Container logs
Accessible via the status panel (last 100 lines via `docker logs --tail 100`).

---

## Terminals

Terminals are powered by xterm.js with node-pty PTY sessions in the main process.

### Contexts

| Context | What it opens |
|---------|--------------|
| `local` | Local shell (`$SHELL` or `/bin/bash`) |
| `ssh` | Interactive SSH session to the remote host |
| `container` | `docker exec -it <name> <shell>` |

The active context is shown as a breadcrumb overlay (e.g. `CONTAINER › myproject`).

### Tab behaviour
- Multiple tabs per profile, any mix of contexts
- Tabs dim (inactive state) when the process exits
- Blue dot appears on tabs with new unread output
- Context badge on each tab (local / ssh / container), colour-coded

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+C` | Copy selection |
| `Ctrl+Shift+V` | Paste from clipboard |
| `Ctrl+Shift+F` | Open find bar |
| `Ctrl++` / `Ctrl+=` | Increase font size |
| `Ctrl+-` | Decrease font size |
| `Ctrl+0` | Reset font size (13 px) |
| `Ctrl+L` | Clear terminal and scrollback |
| Right-click | Paste from clipboard |
| Select text | Auto-copy to clipboard |

### Find bar
`Ctrl+Shift+F` opens a find overlay. `Enter` = next match, `Shift+Enter` = previous, `Esc` = close. Incremental search highlights as you type.

### Configuration
- Scrollback: 5000 lines
- Overview ruler: 10 px (scrollbar position indicator)
- Font size: 8–28 px range, adjustable at runtime
- Themes: Catppuccin Mocha (dark) and Catppuccin Latte (light), switchable at runtime

---

## Service Health Monitoring

Configured service URLs are polled via HTTP every 15 seconds. In-flight requests are deduplicated (a new check is skipped if the previous one is still pending). Results are shown in the status panel with healthy/unhealthy indicators and HTTP status codes. Clicking a URL opens it in the system browser.

---

## Event Log

A structured event log captures all connection, container, and terminal lifecycle events with timestamps and log levels (`info`, `warn`, `error`, `debug`). The log panel is toggled from the bottom bar. Logs can be filtered by profile and cleared.

---

## UI

### Layout
- **Sidebar** — profile list with status badges, import/export/theme toggle
- **Terminal area** — tab bar + full-height terminal panes
- **Status panel** — SSH state, port forwards, container controls, service health
- **Log panel** — toggleable event log at the bottom

### Notifications
- Non-blocking toast notifications for errors and confirmations
- Confirm modal for destructive actions (auto-focuses Cancel, Escape to dismiss)
- Unsaved-changes warning when closing the profile editor with pending edits

### Themes
Dark (Catppuccin Mocha) and light (Catppuccin Latte) themes. Toggle via the ☀/☾ button in the sidebar footer. Theme is persisted across sessions and applied to all open terminals immediately.

---

## Profile Schema

```json
{
  "id": "uuid",
  "name": "myproject",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "ssh": {
    "host": "myhost.example.com",
    "user": "dev",
    "port": 22,
    "identityFile": "~/.ssh/id_ed25519",
    "forwards": [
      {
        "localPort": 3000,
        "remoteHost": "localhost",
        "remotePort": 3000,
        "containerPort": 8080
      }
    ],
    "keepalive": true,
    "extraOptions": {}
  },
  "container": {
    "name": "myproject",
    "image": "myregistry.example.com/myimage:latest",
    "runtime": "sysbox-runc",
    "shell": "bash",
    "workspaceMount": {
      "localPath": "${cwd}",
      "containerPath": "/workspace"
    },
    "workdir": "/workspace",
    "env": { "MY_VAR": "value" },
    "extraArgs": ["--cap-add=SYS_ADMIN"],
    "interactive": true
  },
  "terminal": {
    "presentation": "tab",
    "defaultContext": "container",
    "keepVisibleWhenDisconnected": true
  },
  "service": {
    "urls": ["http://localhost:3000"],
    "healthcheckPath": "/"
  },
  "connectionPolicy": {
    "autoReconnect": true,
    "preventDuplicateConnections": true,
    "existingContainerBehavior": "attach-or-recreate",
    "reconnectDelay": 3000,
    "maxReconnectAttempts": 5
  },
  "workspace": {
    "localPath": "/home/user/projects/myproject",
    "recentPaths": ["/home/user/projects/myproject"]
  }
}
```

### Template variables in workspace mount paths
- `${cwd}` — resolved to the profile's configured `workspace.localPath`
- `${projectName}` — resolved to the profile name

---

## Architecture

### Process boundary

| Layer | Responsibility |
|-------|---------------|
| **Main process** | SSH spawning, PTY management, Docker exec over SSH, health checks, profile persistence, IPC handlers |
| **Preload** | Type-safe IPC bridge (`window.api`) |
| **Renderer** | React UI, Zustand state, xterm.js terminal rendering |

### Main process managers

| Manager | Responsibility |
|---------|---------------|
| `ProfileManager` | electron-store CRUD, import/export, clone |
| `ConnectionManager` | SSH tunnel process, state machine, reconnect scheduling |
| `TerminalManager` | node-pty sessions, context dispatch, IPC data forwarding |
| `ContainerManager` | docker commands over SSH exec, run command builder, port detection |
| `HealthCheckManager` | HTTP polling, in-flight deduplication, state change emission |
| `EventLogManager` | Circular buffer, EventEmitter, log level filtering |

### IPC channels (selection)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `connection:launch` | invoke | SSH + container start/attach + terminal |
| `connection:connect` / `disconnect` | invoke | SSH tunnel only |
| `terminal:create` / `destroy` / `input` / `resize` | invoke | PTY lifecycle |
| `terminal:data` / `terminal:exited` | push | PTY output and exit events |
| `container:start` / `stop` / `restart` / `remove` / `recreate` | invoke | Container lifecycle |
| `container:detectPorts` | invoke | Read EXPOSE from remote image |
| `connection:stateChanged` / `container:stateChanged` | push | State updates to renderer |
| `service:healthChanged` | push | Health check results |
| `fs:writeText` | invoke | Write exported profile JSON to file |

---

## Security

- SSH keys are never stored — the app references key file paths only (`identityFile`)
- No passwords are stored in profiles
- All remote commands run over SSH using existing system trust (known_hosts, ssh-agent)
- `StrictHostKeyChecking=accept-new` for non-interactive SSH exec commands
- IPC follows Electron contextIsolation — the renderer cannot execute arbitrary main-process code outside the defined API

---

## Not Yet Implemented

- Session restore on app restart (terminal tabs are not persisted across restarts)
- Podman, Docker Compose, Kubernetes port-forward support
- Split terminal panes
- Port conflict detection before connection start
- YAML profile format (JSON only)
- Windows support (Linux and macOS only)
