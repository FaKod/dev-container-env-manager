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
    │ (Docker)    │  │ (SSH Tunnel)   │
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
