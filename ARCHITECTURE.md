# FaKods Legendary DevContainer Manager - Architecture Diagram

## System Overview

```
┌─────────────────────────────────────────┐
│  🖥️  FaKods DevContainer Manager        │
│      (Electron Desktop App)             │
└──────────────┬────────┬─────────────────┘
               │        │
    ┌──────────▼──┐  ┌──▼─────────────┐
    │ LOCAL SETUP │  │ REMOTE SETUP   │
    │ (Docker or  │  │ (SSH Tunnel)   │
    │  OpenShell) │  │                │
    └──────┬──────┘  └──┬─────────────┘
           │            │
           │       ┌────▼────────┐
           │       │ SSH Tunnel  │
           │       │ -N -L -i -p │
           │       └────┬────────┘
           │            │
      ┌────┴────────────┘
      │
┌─────▼──────────────────────┬───────────┐
│   dev machine              │           │
│   docker daemon            │   docker  │
│   (local/remote)           │   daemon  │
│                            │  (remote) │
└─────┬──────────────────────┬───────────┘
      │                      │
   ┌──┴────┐  ┌───────┐   ┌──┴────┐
   │ :3000 │  │ :8080 │   │ :5432 │
   └───────┘  └───────┘   └───────┘
```

## Connection Flow

### **LOCAL Setup**
```
┌────────────────────────────────────┐
│   FaKods App                       │
│   (No SSH tunnel needed)           │
└──────────────┬─────────────────────┘
               │
               ▼
        ┌──────────────┐
        │ Docker Daemon│
        │ (localhost)  │
        └──────────────┘
```

### **REMOTE Setup with SSH Tunnel**
```
┌────────────────────────┐       SSH Tunnel                  ┌──────────────────────┐
│  FaKods App            │                                   │  Remote Server       │
│  (Your Machine)        │──────────────────────────────────▶│  (user@host:22)      │
│                        │  ssh -N -i key -p port            │                      │
│ Port Forwards:         │    -L 3000:localhost:3000 \       │ Docker Daemon        │
│ ┌──────────────────┐   │    -L 8080:localhost:8080 \       │                      │
│ │ Local │ Remote   │   │    user@host                      │ Containers:          │
│ │ Port  │ Host:Port│   │                                   │  - 3000 (app)        │
│ ├───────┼──────────┤   │──Port Forwarding────────────────▶ │  - 8080 (web)        │
│ │ 3000  │ :3000    │   │                                   │  - 5432 (db)         │
│ │ 8080  │ :8080    │   │◀──Status (active/inactive)─────── │                      │
│ │ 5432  │ :5432    │   │                                   │                      │
│ └──────────────────┘   │                                   │                      │
└────────────────────────┘                                   └──────────────────────┘
         │                                                             │
         │                                                             │
         ▼                                                             ▼
      Browser                 (SSH Tunnel)                  Docker Container
      localhost:3000 ◀──────────────────────────────────────▶ listening on 3000
```

## Port Forwarding Flow

### Profile Configuration
```yaml
Profile:
  id: "dev-env"
  name: "Backend Dev"
  local: false
  
  ssh:
    host: "dev.example.com"
    user: "devuser"
    port: 22
    identityFile: "/home/user/.ssh/id_rsa"
    keepalive: true
    
    forwards:  # SSH port forwarding config (-L flag)
      - localPort: 3000
        remoteHost: "localhost"
        remotePort: 3000
        containerPort: 3000  # Maps to container port
      
      - localPort: 8080
        remoteHost: "localhost"
        remotePort: 8080
        containerPort: 8080
  
  container:
    name: "dev-backend"
    image: "node:20"
    ports:  # (ignored for remote, uses SSH forwards)
      - hostPort: 3000
        containerPort: 3000
```

### SSH Tunnel Execution
```
ssh -N \
  -i /home/user/.ssh/id_rsa \
  -p 22 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 3000:localhost:3000 \        ◄─ Traffic from localhost:3000 
  -L 8080:localhost:8080 \        ◄─ gets forwarded to remote
  -L 5432:localhost:5432 \        ◄─ localhost:PORT
  devuser@dev.example.com
```


## OpenShell Sandbox Backend

Profiles with `backend: "openshell"` run in an NVIDIA OpenShell sandbox instead
of a Docker container. Everything else (tiles, status panel, terminals, session
restore) is shared. Profiles without `backend` are Docker profiles, so the
Docker path is unchanged. Details and decisions: `Docs/openshell-sandbox-plan.md`.

### Backend selection
```
ipcHandlers / index.ts
        │  selectBackend(profile)
        ▼
┌───────────────────────┐        ┌─────────────────────────────────────┐
│ ContainerManager      │        │ OpenShellBackend                    │
│ (Docker, unchanged)   │        │  lifecycle, status, logs, preflight │
│ docker … / ssh docker │        │  └─ OpenShellCli: one place that    │
└───────────────────────┘        │     spawns `openshell` (local or    │
   both implement                │     over SSH), JSON, error hints    │
   ContainerBackend              └─────────────────────────────────────┘
```

`TerminalManager` and `ConnectionManager` handle sandboxes in early-return
branches (`if isOpenShell(profile)`), above the untouched Docker code.

### Remote sandbox profile (CLI over SSH)
```
 Laptop (FaKods App)                      Remote host
 ───────────────────                      ──────────────────────────────────────────
 lifecycle / status   ── ssh host ──────▶ openshell sandbox create|get|stop|delete …
 terminal (node-pty)  ── ssh -t host ───▶ openshell sandbox exec N --tty -- sh
 port forward         ── ssh -tt -L 8080:127.0.0.1:18080 host
   localhost:8080                       ▶ openshell forward service N
                                            --target-port 3000 --local 127.0.0.1:18080
 file drop / paste    ── ssh host ──────▶ cat > $t; openshell sandbox upload N $t /tmp/x
                                                          │
                                                          ▼
                                          OpenShell gateway (systemd user service, :17670)
                                                          │
                                                          ▼
                                          Docker ── sandbox N
                                                    /sandbox/project ◀── bind mount of a
                                                                         folder on the host
```

Local sandbox profiles run the same `openshell …` commands directly, without SSH.

### Lifecycle notes (OpenShell 0.1.6)

- **Terminals** use `sandbox exec --tty`, never `connect`: `connect` attaches
  to the sandbox's main process, and exiting it ends the sandbox. Only the
  first terminal of a profile with a *main command* attaches.
- Sandboxes without a main command are created with `--restart-policy always`.
- **Start** handles each phase: infrastructure `Error` → stop + start;
  `Completed` / main-process `Error` → start (stop is a no-op there), with a
  fallback to stop + start and finally a "use Recreate" message.
- **Forwards** (`OpenShellForwards`, owned by `ConnectionManager`) exit when
  the sandbox stops; they are retried with backoff and restarted at once after
  Start / Unpause / Restart / Recreate.

## Key Features Summary

| Feature | Type | How It Works |
|---------|------|--------------|
| **Local Profiles** | Dev Setup | Direct Docker access, no SSH needed |
| **Remote Profiles** | Dev Setup | SSH tunnel with port forwarding |
| **Port Forwarding** | Networking | SSH `-L localhost:local → remote:port` |
| **Container Management** | Operations | Execute docker commands via SSH or locally |
| **Terminal Access** | Sessions | Interactive shell in container (attach/exec) |
| **Auto Reconnect** | Resilience | Automatic SSH reconnect on disconnection |
| **Container Discovery** | Smart Config | Detect exposed ports from Docker image |
| **Profile Storage** | Persistence | JSON-based configuration for saved profiles |
| **OpenShell Sandboxes** | Dev Setup | Policy-enforced sandboxes via the `openshell` CLI, locally or over SSH |
| **Sandbox Port Forwards** | Networking | `openshell forward service`; remote: one `ssh -tt -L` process per forward |
| **Sandbox File Staging** | Sessions | Drop/paste via `openshell sandbox upload` (remote: two hops) |
