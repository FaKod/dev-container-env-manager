# FaKods Legendary DevContainer Manager

> **The ultimate desktop app for managing remote development containers — SSH tunnels, live status, split terminals, and full container control, all in one beautiful interface.**

![FaKods Legendary DevContainer Manager](dev-container-manager.png)

---

## What is it?

FaKods Legendary DevContainer Manager is a **native Electron desktop application** that puts you in full command of your remote development environments. Whether you're spinning up AI agents inside Docker containers on a remote server, juggling multiple SSH-connected projects, or monitoring port forwards across environments — this app does it all from a single, gorgeous window.

No more juggling terminal windows. No more forgetting which container is running where. No more squinting at `docker ps` output over SSH. Just connect, work, and ship.

---

## Features

### Profile Management
- Define named **connection profiles** — each with SSH credentials, container config, port forwards, and connection policies
- Color-coded **avatar tiles** per profile for instant visual recognition
- Import/export profiles as JSON — share your setup with teammates in seconds
- One-click **Clone** to duplicate a profile and tweak it

### SSH + Container Lifecycle
- Full **SSH tunnel management** with keepalive, identity file, custom options, and reconnect policies
- **Docker container control** directly from the UI — Start, Stop, Restart, Recreate, Delete
- Auto-detects the container's default shell from its image `CMD`
- **Port forward monitoring** with live active/inactive status per tunnel

### Terminal
- Full **xterm.js** terminal with Catppuccin-themed colors (dark and light)
- **Split panes** — vertical or horizontal — each running an independent PTY session into the container
- Multiple **tabbed terminals** per session, all independently closeable
- Find bar (`Ctrl+Shift+F`), font resize (`Ctrl+=/−`), copy/paste (`Ctrl+Shift+C/V`), right-click paste
- Scrollback of 5000 lines, web link detection
- **Dynamic tab + window titles** — tab title and Electron window title update automatically when the shell emits an OSC title sequence

### Live Status Panel
- **At-a-glance status strip** always visible — profile name, SSH badge (connected/connecting/failed), container status, active port count
- Expandable detail panel with SSH connection info, port forward list, container image, and action buttons
- **Event log** with per-level color coding, search, profile filter, copy to clipboard

### Polished UI
- **Glassmorphism** sidebar and status cards — frosted glass panels with backdrop blur
- **Catppuccin Mocha** dark theme + **Catppuccin Latte** light theme, switchable at any time
- Gradient button fills with shimmer hover effects
- Animated ping dot for unread terminal activity
- Green glow on connected profiles, spinning ring on connecting avatars
- Spring-animated toast notifications with countdown progress bar
- Danger-pulse confirm dialog so you never accidentally nuke a container

---

## Getting Started

### Prerequisites

- Node.js 20+
- `openssh-client` (for the SSH tunnels)
- Docker running on your remote host

### Install & Run

```bash
npm install
npm run dev
```

### Build AppImage (Linux x64)

```bash
npm run dist
# Output: dist/FaKods Legendary DevContainer Manager-1.0.0.AppImage
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Renderer (React + TypeScript + Vite)               │
│  ├── Sidebar       — profile cards + actions        │
│  ├── TerminalView  — xterm.js panes + split layout  │
│  ├── StatusPanel   — SSH / ports / container info   │
│  └── LogViewer     — live event log                 │
├─────────────────────────────────────────────────────┤
│  Main Process (Electron + Node.js)                  │
│  ├── TerminalManager  — node-pty PTY sessions       │
│  ├── SSHTunnelManager — SSH port forward tunnels    │
│  ├── ProfileManager   — JSON profile persistence    │
│  └── EventLogManager  — structured event logging   │
└─────────────────────────────────────────────────────┘
```

State management: **Zustand**
Terminal emulation: **xterm.js** (FitAddon, SearchAddon, WebLinksAddon)
IPC: Electron contextBridge with typed API surface
Theme: **Catppuccin** Mocha / Latte

---

## Keyboard Shortcuts (Terminal)

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+F` | Open find bar |
| `Ctrl+Shift+C` | Copy selection |
| `Ctrl+Shift+V` | Paste |
| `Ctrl+=` / `Ctrl++` | Increase font size |
| `Ctrl+-` | Decrease font size |
| `Ctrl+0` | Reset font size |
| `Ctrl+L` | Clear scrollback |
| Right-click | Paste from clipboard |

---

## Dynamic Terminal Titles

Tab titles and the Electron window title update automatically when the shell emits an OSC title escape sequence. To enable this, add the appropriate snippet to your shell config on the remote host:

**Bash** (`~/.bashrc`):
```bash
PROMPT_COMMAND='echo -ne "\033]0;${USER}@${HOSTNAME}:${PWD/#$HOME/~}\007"'
```

**Zsh** (`~/.zshrc`):
```zsh
precmd() { print -Pn "\e]0;%n@%m:%~\a" }
```

**Fish** (`~/.config/fish/config.fish`):
```fish
function fish_title
    echo (whoami)@(hostname):(prompt_pwd)
end
```

You can also set the title manually from any shell at any time:
```bash
echo -ne "\033]0;my custom title\007"
```

The window title format is `{tab title} — DevEnv Manager`, falling back to just `DevEnv Manager` when no terminal is open.

---

## License

MIT
