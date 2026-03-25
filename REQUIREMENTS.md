# Agentic Dev Environment Manager - Requirements

## Goal

A desktop app that lets you manage development targets made of:

- an SSH connection to a remote Linux box
- one or more port forwards
- a container startup command tied to a project
- quick access to the exposed web service
- an integrated terminal-based view per connected profile

The tool should make remote development feel like launching a local app: select a project, connect, and work immediately with full visibility and control.

---

## Core User Story

As a developer, I want to select a project like `aiact-anthropic`, click one button, and have the app:

1. establish the SSH tunnel
2. verify the remote host is reachable
3. start, attach to, or recreate the project container as configured
4. present the connected profile as its own terminal window or terminal tab
5. expose the right local URL
6. show logs, status, and controls
7. manage the lifecycle of the connection cleanly

---

## Functional Requirements

### 1. Project Profiles

The application shall support reusable project profiles. Each profile shall contain at least:

- profile name
- SSH host or alias
- SSH options and port forwards
- container runtime settings
- container name
- container image
- workspace mount settings
- working directory
- service URLs
- connection and terminal preferences

Each profile should be editable, clonable, exportable, and importable.

---

### 2. Terminal-Centric Profile Presentation

Each connected profile shall be presented as a terminal window, terminal pane, or terminal tab within the application.

Requirements:

- every active profile must have a visible terminal session
- the terminal must show the live interactive shell for the associated connection or container context
- users must be able to type directly into the terminal
- users must be able to open multiple profile terminals at the same time
- disconnected profiles may remain visible in an inactive state, but connected profiles must always have a terminal representation
- terminal sessions should support copy/paste, scrolling, resizing, and search
- terminal sessions should clearly indicate whether the user is currently on the remote host, inside the container, or both through UI labeling or breadcrumbs

The terminal is not just a log viewer. It is a primary interaction surface.

---

### 3. Connection Management

The application shall explicitly manage connections as first-class objects.

Requirements:

- create, start, stop, restart, and reconnect SSH connections
- monitor connection health continuously
- detect broken tunnels and dropped sessions
- reconnect automatically according to profile policy
- prevent duplicate or conflicting connection instances for the same profile unless explicitly allowed
- show connection state clearly, such as:
  - disconnected
  - connecting
  - connected
  - degraded
  - reconnecting
  - failed
- allow manual disconnect without leaving orphan processes
- clean up related subprocesses, tunnels, and terminal resources when a connection is closed
- support multiple concurrent managed connections

The application shall maintain a consistent internal state model so the UI always reflects the actual connection state.

---

### 4. SSH Session Management

The app shall support:

- launching SSH sessions from the UI
- support for SSH config aliases from `~/.ssh/config`
- support for local port forwards
- support for multiple forwards per profile
- stdout and stderr capture
- optional keepalive behavior
- known_hosts and host key verification handling using the operating system and SSH tooling
- integration with existing SSH keys and `ssh-agent`

Example command pattern:

```bash
ssh -L 3000:localhost:3000 spark-7406.tail845a53.ts.net
```

The application should build and execute such commands safely from structured configuration rather than raw unsanitized strings.

---

### 5. Port Forwarding Management

The app shall support:

- one or more local-to-remote forwards per profile
- conflict detection for local ports before connection start
- visibility into which local ports are active
- restart of individual port forwards where technically feasible
- display of mappings such as:
  - `localhost:3000 -> remote localhost:3000`
- opening forwarded services in the browser from the UI

---

### 6. Container Lifecycle Management

The app shall support container workflows associated with a profile.

Requirements:

- start a container
- stop a container
- restart a container
- remove a container
- recreate a container
- attach to a running container
- open a shell directly in the container
- stream container logs
- detect whether a named container already exists
- determine whether the container is running, stopped, failed, or misconfigured
- define policy for existing containers:
  - attach to existing
  - start existing
  - remove and recreate
  - ask according to configuration or policy

Example command pattern:

```bash
docker run --runtime=sysbox-runc \
  -it --name aiact-anthropic -p 3006:3006 \
  -v "${PWD}:/workspace" \
  -w /workspace \
  quay.io/innoq/claude-dind:latest
```

The application shall support structured generation of this command from profile data.

---

### 7. Terminal Context Switching

The terminal attached to a profile shall support clear transitions between:

- local orchestration context
- remote SSH shell
- container shell

Requirements:

- users must be able to see which context is active
- the app should support launching directly into a preferred context
- users should be able to open additional terminals for the same profile if needed
- the UI should distinguish between:
  - connection terminal
  - container terminal
  - log terminal or output view

---

### 8. Workspace Awareness

The application shall support association between a local workspace and a project profile.

Requirements:

- pick a local folder
- persist workspace path
- mount workspace into container
- validate that the path exists before launch
- track recent workspaces
- optionally derive defaults from the current workspace name

---

### 9. Service Access and Health Monitoring

The app shall provide:

- one-click opening of local service URLs
- support for multiple service endpoints per profile
- configurable health checks
- visibility into service readiness
- retry or polling after startup
- status display for service reachability

Examples:

- `http://localhost:3000`
- additional internal service URLs if configured

---

### 10. Logs and Observability

The application shall provide observability for the full workflow.

Requirements:

- SSH logs
- container logs
- connection lifecycle events
- timestamps for actions and failures
- searchable logs
- export or copy logs
- separation between interactive terminal content and system event logs

---

### 11. Command Templating and Configuration

The application shall support safe templating of commands and parameters.

Supported variable examples:

- `${projectName}`
- `${cwd}`
- `${sshHost}`
- `${localPort}`
- `${remotePort}`
- `${containerName}`

Requirements:

- validation before execution
- preview of resolved commands when needed
- safe escaping and argument handling
- schema validation for profile definitions

---

### 12. Secrets and Credential Handling

The app shall not store secrets insecurely.

Requirements:

- prefer system SSH keys
- integrate with `ssh-agent`
- store only non-sensitive configuration by default
- use system keychain or credential store if secret persistence is required
- do not store plaintext passwords in profile definitions
- clearly separate secrets from exported profile configuration where possible

---

### 13. Profile and Session Persistence

The app shall persist user configuration and session metadata.

Requirements:

- save project profiles locally
- restore known profiles on app startup
- optionally restore disconnected terminal tabs or windows
- remember last connection state and recent actions
- import and export profile sets as JSON or YAML

---

## Non-Functional Requirements

### Reliability

The system shall:

- recover gracefully from dropped SSH sessions
- avoid orphaned SSH or Docker processes
- handle slow starts and partial failures
- provide actionable error messages
- keep internal state synchronized with actual process state

### Security

The system shall:

- avoid plaintext secret storage
- sanitize all command execution paths
- clearly distinguish local execution from remote execution
- rely on existing SSH trust mechanisms where possible
- prevent renderer-driven arbitrary command execution in the desktop UI architecture

### Usability

The system shall:

- provide one-click or low-friction startup for each profile
- make terminal windows central to the experience
- show clear status indicators for connection, tunnel, container, and service health
- support efficient keyboard-driven workflows
- minimize manual terminal setup steps

### Portability

If implemented as an Electron app, it should run on:

- Linux
- macOS

Windows support may be considered later, but is not a primary requirement.

### Extensibility

The design should allow future support for:

- Podman
- Docker Compose
- Kubernetes port-forwarding
- devcontainer workflows
- multiple services per project
- richer terminal layouts such as splits and tabs

---

## Product Structure

A useful domain model is:

- **Projects**: for example `aiact-anthropic`
- **Profiles**: configuration for a specific remote target and runtime setup
- **Connections**: managed SSH/tunnel sessions
- **Terminals**: interactive windows or tabs bound to profiles and contexts
- **Containers**: runtime instances associated with profiles
- **Services**: locally exposed URLs
- **Policies**: reconnection, reuse, recreate, cleanup behavior

---

## Technical Architecture Requirements

If implemented in Electron, the app should require:

- process and connection management in the main process
- renderer limited to UI responsibilities
- strict IPC boundaries
- structured state management for profiles, connections, terminals, and containers
- integrated terminal emulation for interactive shells
- safe command construction and spawning
- profile schema validation
- event-driven updates from process managers to the UI

Recommended internal components:

- Profile Manager
- Connection Manager
- SSH Manager
- Port Forward Manager
- Container Manager
- Terminal Manager
- Health Check Manager
- Configuration Manager
- Event Log Manager

---

## Example Profile Model

```json
{
  "profiles": [
    {
      "name": "aiact-anthropic",
      "ssh": {
        "host": "spark-7406.tail845a53.ts.net",
        "forwards": [
          {
            "localPort": 3000,
            "remoteHost": "localhost",
            "remotePort": 3000
          }
        ]
      },
      "terminal": {
        "presentation": "tab",
        "defaultContext": "container",
        "keepVisibleWhenDisconnected": true
      },
      "container": {
        "name": "aiact-anthropic",
        "image": "quay.io/innoq/claude-dind:latest",
        "runtime": "sysbox-runc",
        "ports": [
          {
            "hostPort": 3006,
            "containerPort": 3006
          }
        ],
        "workspaceMount": {
          "localPath": "${cwd}",
          "containerPath": "/workspace"
        },
        "workdir": "/workspace",
        "interactive": true
      },
      "service": {
        "urls": [
          "http://localhost:3000"
        ],
        "healthcheckPath": "/"
      },
      "connectionPolicy": {
        "autoReconnect": true,
        "preventDuplicateConnections": true,
        "existingContainerBehavior": "attach-or-recreate"
      }
    }
  ]
}
```

---

## Vision

The application should make remote development feel operationally simple while preserving the power of terminal-driven workflows:

**Select profile → Connect → Get a managed terminal window → Access services → Control the full session lifecycle**