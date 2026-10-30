# OpenShell Sandbox Backend — Implementation Plan

| | |
|---|---|
| **Status** | In progress: Phases 1–2 implemented, Phase 3 terminal part implemented (see [§8](#8-implementation-status)) |
| **Date** | 2026-10-29 |
| **Source analysed** | [NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell) @ `d4e3226` (main, 2026-10-29), OpenShell 0.1.x |
| **App version** | devenv-manager 0.0.73 |

## 0. Goal

Add **OpenShell sandboxes** as a second, optional profile type **next to** the
existing Docker containers. The user gets the same experience as today
(connect, terminals, port forwards, logs, start/stop), and the sandbox also
enforces OpenShell policy. That covers filesystem rules (Landlock),
deny-by-default network egress, and credentials injected via providers.

### 0.1 Guiding principle: OpenShell is an addition, not a replacement

The current way of creating and managing containers stays the primary path,
fully supported:

- `docker run/start/stop/…` executed locally, or on a remote host over SSH
  (`ContainerManager.sshExec`).
- The SSH tunnel with `-L` port forwards (`ConnectionManager`).
- Terminals via `ssh -t … docker exec/attach` (`TerminalManager`).

Every phase must respect these rules:

1. **Docker is the default.** New profiles are Docker profiles unless the user
   explicitly picks "OpenShell sandbox". Stored and imported profiles without a
   `backend` field are Docker profiles. No migration, no conversion prompts.
2. **No behaviour change for Docker profiles.** The local/remote, SSH-tunnel,
   port-forward, terminal-mode (`exec`/`attach`/`smart`), workspace-mount and
   reconnect logic keeps working exactly as today. The Docker code path is not
   rewritten. It only gets a thin interface around it (§3.2).
3. **OpenShell is optional at runtime.** If the `openshell` CLI is not
   installed, or no gateway is running, Docker profiles are unaffected.
   OpenShell checks run only when an OpenShell profile is used. They never
   block app start or Docker profiles.
4. **Both kinds coexist.** Docker and OpenShell profiles can live in the same
   project and be connected at the same time. Port clashes between them are
   reported the same way as between two Docker profiles.
5. **Additive data model.** New fields go into a separate `openshell` block
   (D11-A). Existing `ssh` / `container` fields keep their meaning and
   shape.
6. **Additive UI.** The Docker sections of `ProfileEditor` stay as they are.
   OpenShell fields appear only when the backend selector is set to OpenShell.
7. **Regression gate.** Each phase ends with the Docker/SSH regression
   checklist (§5) before it is considered done.

**Non-goals (for this plan)**

- Replacing, deprecating or changing the Docker/SSH backend. Docker profiles keep working unchanged.
- Automatically converting Docker profiles to OpenShell (an optional, user-triggered "convert" action is at most a later nice-to-have, see Phase 7).
- Installing or operating OpenShell gateways from inside the app (see D4).
- A full policy editor with prover/advisor integration (see D5, later phase).

**Terminology clash.** OpenShell has its own `openshell profile` command
(provider profiles). In this document *profile* always means **our** app
profile (`Profile` in `src/shared/types.ts`). OpenShell's concepts are written
as *gateway*, *sandbox*, *policy*, *provider*, *template* and *workspace*. Use
the same convention in the UI to avoid confusion.

---

## 1. Background

### 1.1 OpenShell in one paragraph

A **gateway** is the control plane. It creates **sandboxes** through a compute
driver: Docker, Podman, Kubernetes or MicroVM. Inside every sandbox a
**supervisor** replaces the image's `CMD`/`ENTRYPOINT` and enforces a
**policy**:

- `filesystem_policy`: Landlock rules, fixed at creation.
- `process`: run-as user, fixed at creation.
- `network_policies`: deny by default, changeable while the sandbox runs.

Secrets are attached as **providers**, so the workload never sees real
credential values. Clients talk to the gateway through the `openshell` CLI or
SDKs (TypeScript, Python, Go, Rust).

### 1.2 Where our app touches containers today

| Concern | File | Current mechanism |
|---|---|---|
| Lifecycle + status | `src/main/managers/ContainerManager.ts` | `docker run/start/stop/pause/rm/inspect`, locally or over `ssh host "docker …"` |
| Connect / launch orchestration | `src/main/ipcHandlers.ts` (`connection:launch`, ~L195–256) | `existingContainerBehavior` decides attach / start / recreate |
| SSH tunnel + port forwards | `src/main/managers/ConnectionManager.ts` | `ssh -N -L …` child process, auto-reconnect |
| Terminals | `src/main/managers/TerminalManager.ts` (`buildCommand`) | node-pty spawning `docker exec -it` / `docker attach` / `ssh -t` |
| File drop / image paste | `TerminalManager.stageFile` / `stageImage` | `docker cp` (or `ssh … cat > … && docker cp`) |
| Container logs | `ContainerManager.getLogs` | `docker logs --tail` |
| Profile model + storage | `src/shared/types.ts`, `ProfileManager.ts` | electron-store JSON |
| Editor UI | `src/renderer/src/components/ProfileEditor.tsx` | Form over `Profile` |

### 1.3 Command mapping (verified against OpenShell CLI source/docs)

| App operation | Docker today | OpenShell |
|---|---|---|
| Create | `docker run -d …` | `openshell sandbox create --name N --from IMG [--policy F] [--provider P]… [--cpu] [--memory] [--gpu] [--env K=V]… [--label K=V]… --detach [-- CMD]` |
| Create from template | — | `openshell sandbox create --template T …` (excludes `--from/--cpu/--memory/--gpu/--env`) |
| Workspace mount (`-v`) | `docker run -v local:target` | `--driver-config-json '{"<driver>":{"mounts":[{"type":"bind","source":"/abs/local","target":"/sandbox/<name>","read_only":false}]}}'` — requires gateway opt-in (see D2) |
| Status | `docker inspect` | `openshell sandbox get N -o json` → phase |
| Start / Stop | `docker start/stop` | `openshell sandbox start/stop N` (stop keeps the persistent workspace) |
| Pause / Unpause | `docker pause/unpause` | `openshell sandbox suspend/resume N` (**only if driver + isolation backend support it**) |
| Remove | `docker rm -f` | `openshell sandbox delete N` |
| Shell | `docker exec -it C sh` | `openshell sandbox connect N` (login shell, PTY) |
| Run command | `docker exec` | `openshell sandbox exec …` |
| Copy file in | `docker cp` | `openshell sandbox upload N SRC [DST]` |
| Logs | `docker logs` | `openshell logs N [--tail] [--since 5m]` |
| Port forward | `ssh -L` / `docker -p` | `openshell forward start PORT N [-d]` (same port both sides) or `openshell forward service N --target-port P --local [addr:]port` (remappable, loopback target) |
| Gateway health | — | `openshell status`, `openshell gateway list -o json` |

### 1.4 Status mapping (`SandboxPhase` → our `ContainerStatus`)

| OpenShell phase | `ContainerStatus` |
|---|---|
| `PROVISIONING`, `STARTING` | `starting` |
| `READY` | `running` |
| `STOPPING`, `DELETING`, `SUSPENDING` | `stopping` |
| `STOPPED`, `COMPLETED` | `stopped` |
| `SUSPENDED` | `paused` |
| `ERROR` | `failed` (surface the condition/reason from JSON in `error`) |
| `UNKNOWN`, `UNSPECIFIED` | `unknown` |
| sandbox not found | `not-found` |

### 1.5 Where the CLI and gateway run (D3 = A + C)

The app never talks to a gateway over the network itself. It always spawns the
`openshell` CLI, either **directly** (local profiles) or **over SSH on the
remote host** (remote profiles). That is the same split as today's
`docker …` vs `ssh host docker …` in `ContainerManager.exec` / `sshExec`.

| Profile | CLI runs on | Gateway runs on | Must be installed locally | Must be installed on the remote host |
|---|---|---|---|---|
| Local (`profile.local`) | User's machine, spawned directly (no SSH) | User's machine | `openshell` CLI + gateway + Docker/Podman | — |
| Remote | Remote host, via `ssh host openshell …` | Remote host | Nothing new: only `ssh`, as today | `openshell` CLI + gateway + Docker |

- **A gateway must run on the machine whose Docker daemon runs the
  sandboxes**, because it drives the Docker socket. It can be installed as a
  package or run as a container (`ghcr.io/nvidia/openshell/gateway` plus the
  supervisor binary extracted to the host; see OpenShell
  `docs/how-it-works/gateways/container-deployment.mdx`).
- **The CLI config is per user** (`~/.config/openshell/`: gateway
  registrations, mTLS bundle, active gateway). For remote profiles, the **SSH
  user** must have the gateway registered and selected on the remote host.
- Non-interactive `ssh host cmd` often does not load the login PATH
  (`~/.local/bin`, Homebrew). Hence the optional `openshell.cliPath` (§3.1).
- Not to be confused: `openshell gateway add --remote user@host` /
  `ssh://user@host:port` does **not** tunnel over SSH. It only resolves the
  hostname via `ssh -G` (OpenShell `crates/openshell-bootstrap/src/metadata.rs`)
  and then connects to the gateway port directly. That is option D3-B, not used
  for now.

---

## 2. Decisions required

Each decision below lists options, a recommendation and its impact. Please
record the outcome in the **Decision** line. Phases in §4 reference these IDs.

### Summary

| ID | Topic | Recommendation | Blocks phase |
|---|---|---|---|
| D1 | Integration mechanism | CLI first, SDK later where it adds value | 1 |
| D2 | Getting the workspace into the sandbox | **Decided:** bind mount (gateway opt-in); upload as fallback | 3 |
| D3 | Remote model | **Decided:** local gateway for local profiles; CLI over SSH for remote profiles | 2–4 |
| D4 | Who installs/runs the gateway | User does; app detects and guides | 2 |
| D5 | Policy authoring | Presets + policy file path; inline editor later | 5 |
| D6 | Secrets / providers | Reference existing providers by name | 5 |
| D7 | Port forwarding mechanism | `openshell forward service` child processes | 4 |
| D8 | Terminal & main process | `sandbox connect`; no attach mode; optional main command | 3 |
| D9 | Pause / disconnect semantics | suspend if supported, else stop | 2 |
| D10 | Sandbox naming | Slug of profile name, stored explicitly | 2 |
| D11 | Profile data model | `backend` discriminator + `openshell` block | 1 |
| D12 | Status updates | Polling `sandbox get -o json` | 2 |
| D13 | Version compatibility | Require OpenShell ≥ 0.1.x, check on first OpenShell use | 2 |

---

### D1 — Integration mechanism

| Option | Pros | Cons |
|---|---|---|
| **A. Shell out to `openshell` CLI** | Same pattern as current `docker`/`ssh` code. `sandbox connect` gives a real PTY that drops into node-pty. The CLI handles gateway auth (mTLS, OIDC, edge login), SSH proxying and `.gitignore`-aware upload. | Parse CLI output (use `-o json`). Requires CLI on PATH. Output format can change between releases. |
| B. TypeScript SDK `@nvidia/openshell-sdk` | Typed, no output parsing. Streaming logs/watch. Programmatic policy edits. | Published on **GitHub Packages** only (token needed to `npm install`). ESM-only. Pre-1.0 API churn. No PTY: `execInteractive` gives raw bytes, so a second terminal backend beside node-pty is needed. No upload. Forwards live only as long as the process. We'd have to handle gateway credentials ourselves. |
| C. Hybrid | CLI for lifecycle/terminal/upload, SDK for status watch + policy | Two integration surfaces to maintain |

**Recommendation:** A now. Re-evaluate C once the SDK is on public npm and we
want live status or in-app policy editing.
**Decision:** ☐ A ☐ B ☐ C — _______

### D2 — Getting the workspace into the sandbox

Today `container.workspaceMount` is a bind mount. OpenShell **does support
mounting a local folder**. There is no `-v`/`--mount` flag; the mount is passed
as driver config on create (or stored in a sandbox template):

```shell
openshell sandbox create --name N --from IMG --detach \
  --driver-config-json '{"docker":{"mounts":[{"type":"bind","source":"/home/me/project","target":"/sandbox/project","read_only":false}]}}'
```

Bind mounts are **off by default**. The gateway operator must opt in per
driver in the gateway TOML (`~/.config/openshell/gateway.toml` for a local
install):

```toml
[openshell.drivers.docker]          # or .podman / .vm
allow_driver_config = true
enable_bind_mounts  = true

[openshell.drivers.docker.resource_admission]
enabled = false
```

Support per compute driver (source: `docs/how-it-works/sandboxes/runtimes.mdx`):

| Driver | Mount types | Notes |
|---|---|---|
| Docker | `bind`, `volume`, `tmpfs` | `bind`: `source` (absolute host path), `target`, `read_only` (**default `true`**), `selinux_label` |
| Podman | same as Docker, plus `image` | Podman `volume` has no `subpath` |
| MicroVM | `bind` (virtiofs) | Directories only, no symlink sources. Max **3** mounts on x86_64 hosts, 32 on arm64. Not with GPU sandboxes. A non-root Linux gateway needs `sandbox_uid`/`sandbox_gid` matching the host user for writes. |
| Kubernetes | PVC only | No host folders |

Constraints that apply everywhere:
- The target **cannot be the workspace root** (`/sandbox`), the container root,
  or OpenShell paths (`/opt/openshell`, `/etc/openshell`, `/run/openshell`).
  Use `/sandbox/<name>`.
- `source` is a path **on the gateway host**. For local profiles that is the
  user's machine. For remote profiles (D3-C) it is a path on the remote
  host, which is exactly how today's remote `docker run -v` behaves. Kubernetes
  gateways have no host paths and need upload.
- **Security cost:** bind-mounted paths bypass workspace isolation and the
  filesystem (Landlock) policy. The agent can read and write the mounted folder
  freely. Network policy and providers still apply.

| Option | Behaviour | Trade-off |
|---|---|---|
| **A. Bind mount** via `--driver-config-json` | Live local folder, same as today | Needs gateway opt-in. Mounted folder is outside filesystem policy. Local gateway only. |
| B. Upload on create (`sandbox upload N <localPath> /sandbox/…`) + "Sync to sandbox" button | One-time copy, `.gitignore`-filtered | Not live. Changes inside the sandbox must be downloaded (`sandbox download`) or pushed via git. |
| C. Named Docker/Podman volume via `--driver-config-json` | Persistent across sandbox recreation | Volume must carry the `openshell.ai/sandbox-attachable` labels. Not the user's host folder. |
| D. Nothing; user clones inside the sandbox (git provider) | Cleanest isolation | Biggest workflow change |

**Decision (2026-10-29): A, bind mount, is the default.**
- The editor shows an isolation warning next to the mount setting.
- B (upload + Sync) is the fallback. It is used automatically for Kubernetes
  gateways, and offered when the gateway (local or remote) hasn't opted in.
- Remote profiles upload in two hops, the same pattern as
  `TerminalManager.stageFile` today:
  `ssh host 'cat > /tmp/x && openshell sandbox upload N /tmp/x <dst> && rm -f /tmp/x'`.
  Directories go as a tar stream instead.
- Upload can't be combined with a main command at create time. In that case,
  create first, upload, then start the main command with `sandbox exec`.
- C and D are documented for advanced users.

### D3 — Remote model

Today a remote profile is "SSH host running Docker". With OpenShell the network
boundary is the gateway.

| Option | How it works | Trade-off |
|---|---|---|
| **A. Local gateway only** (phase 2 scope) | Profile targets a gateway on this machine | Remote hosts not covered yet |
| B. Direct remote gateway | User registers it once (`openshell gateway add https://…`); profile stores the gateway name; commands use `-g <name>`. No SSH config needed. | Gateway must be reachable + authenticated (mTLS certs / OIDC / edge login). Fits Kubernetes/shared gateways. |
| C. CLI over SSH | Reuse `sshExec`: run `openshell …` *on the remote host*, terminal = `ssh -t host openshell sandbox connect N`, forwards = existing `ssh -L` + `openshell forward start P N -d` on the host | Keeps today's SSH-host mental model and code paths. Needs the OpenShell CLI + gateway installed on the remote host. Two hops for forwards. |
| D. SSH tunnel to remote gateway port + `gateway add https://127.0.0.1:<port>` | Reuses `ConnectionManager` tunnel | TLS/SAN and client-cert handling across the tunnel — **unverified**, needs a spike |

**Decision (2026-10-29): A + C.**
- Local profiles use a gateway on the user's machine.
- Remote profiles run the CLI on the remote host over SSH, reusing the
  existing SSH settings (`profile.ssh`), tunnel and reconnect logic.
- See §1.5 for what is installed where.
- B (direct remote/shared gateway) and D (local CLI through a tunnel) stay
  possible later additions. Nothing in the design should block them: the
  `OpenShellCli` runner abstraction (§3.2) is the extension point.

### D4 — Who installs and runs the gateway

| Option | Trade-off |
|---|---|
| **A. User installs** (`curl …/install.sh \| sh`, Homebrew, snap); app detects `openshell` on PATH and checks `openshell status`, then shows setup hints | Simple, no privileged actions from the app |
| B. App offers a one-click installer | Runs a remote script with elevated rights from a GUI. Security and support burden. |
| C. App bundles the CLI binary | Version pinning, but multiplies AppImage/dmg size and platform matrix (ARM64 + x64) |

For remote profiles (D3-C) the user installs the CLI **and** the gateway on the
remote host, and registers/selects the gateway as the SSH user. The bind-mount
opt-in (D2) then lives in the **remote** gateway's TOML. The app's checks run
over SSH (`ssh host openshell --version`, `ssh host openshell status`). An
optional per-profile `openshell.cliPath` covers hosts where `openshell` is not
on the non-interactive SSH PATH.

Because bind mounts are the default workspace mode (D2), the OpenShell (lazy) and
create checks must also tell the user when the gateway has **not** opted in to
bind mounts. In that case, show the TOML snippet from D2 and offer to fall back
to upload. Phase 0 settles how to detect the opt-in: possibly via `openshell
status` or the gateway config; otherwise by recognising the create error.

**Recommendation:** A.
**Decision:** ☐ A ☐ B ☐ C — _______

### D5 — Policy authoring

The default policy **denies all outbound network**. So package installs, git
clones and agent API calls all fail until a policy allows them.

| Option | Trade-off |
|---|---|
| **A. Presets + file path**: ship 2–3 YAML presets (e.g. *Offline*, *Dev: package registries + GitHub*, *Agent: + model provider*), or let the user pick a policy file | Quick, reviewable, versionable next to the project |
| B. Inline YAML editor in ProfileEditor, stored in the profile | Profile becomes self-contained (good for export/import). We need validation (no schema check client-side unless we vendor the JSON schema). |
| C. Structured UI (hosts/binaries table) | Best UX, largest effort; duplicates OpenShell's advisor |

Also decide: show denied connections (`openshell logs N --level warn`, look for
`action=deny`) in the LogViewer so users can see why something is blocked?
**Recommendation:** A in phase 5, B later. Yes to surfacing denies.
**Decision:** ☐ A ☐ B ☐ C; denies in LogViewer ☐ yes ☐ no — _______

### D6 — Secrets / providers

`--env` is for **non-secret** values only. The CLI warns on names like
`*_TOKEN` or `*_API_KEY`, and the agent can read plain env vars. Secrets belong
in providers (`openshell provider …`). The repo ships provider definitions for
`claude-code`, `anthropic`, `github`, `openai` and others.

| Option | Trade-off |
|---|---|
| **A. Reference existing provider names** (multi-select populated from `openshell provider list -o json`) | No secret handling in our app |
| B. Create providers from the app | We'd collect and forward secrets. More UI, more risk. |

Also decide: when converting a Docker profile, do we **block**, **warn**, or
**silently allow** env keys that look like secrets?
**Recommendation:** A. Warn on migration.
**Decision:** ☐ A ☐ B; secret-looking env: ☐ block ☐ warn ☐ allow — _______

### D7 — Port forwarding mechanism

| Option | Trade-off |
|---|---|
| **A. `openshell forward service N --target-port P --local [addr:]L`** spawned as a child process per forward, owned by `ConnectionManager` (like the `ssh -N` process today) | Supports local≠remote port (matches `PortForward.localPort/remotePort`). Lifecycle tied to the app. Auto-reconnect logic reusable. Target must be loopback inside the sandbox. |
| B. `openshell forward start P N -d` (background, tracked by CLI) | Same port on both sides only. Forwards outlive the app; must reconcile via `forward list -o json`. |
| C. `ssh -F <generated ssh-config> -N -L …` using `openshell sandbox ssh-config N` | Reuses `buildSSHArgs` almost verbatim. Writes a temp SSH config. |

Also decide: do we show `openshell service expose` browser URLs
(`http://<ws>--<sandbox>.openshell.localhost:<port>/`) as an alternative to port
forwards for HTTP services?
**Remote profiles (D3-C):** two hops, both owned by `ConnectionManager`:
1. The existing tunnel `ssh -N -L localPort:localhost:remotePort host`,
   unchanged.
2. Per forward, a long-lived child
   `ssh host openshell forward service N --target-port P --local 127.0.0.1:remotePort`
   that bridges the remote host's loopback port into the sandbox. It is killed
   on disconnect and restarted by the existing reconnect logic.

The spike must confirm that killing the local `ssh` also ends the remote
`openshell` process, i.e. no orphans. If needed, use `ssh -tt` or a remote
`exec` wrapper.

**Recommendation:** A, keep C as fallback if A misbehaves in the spike. Service
URLs later.

**Decision (2026-10-30, implemented): A.** Service URLs: later.
- Local profiles: one `openshell forward service N --target-port P --local
  <bind>:<localPort>` child process per forward.
- Remote profiles: instead of reusing the profile's `ssh -N` tunnel, **one
  `ssh -tt -L <bind>:<localPort>:127.0.0.1:<remotePort> host 'openshell
  forward service … --local 127.0.0.1:<remotePort>'` per forward** carries both
  hops. `-tt` makes `sshd` send SIGHUP to the remote command when the
  connection drops. `remotePort` (default `localPort`) is the loopback port on
  the SSH host.
- `forward service` exits when the sandbox is no longer Ready (it checks every
  2 s). Exited forwards are retried with backoff (2 s → 30 s). Start, Unpause,
  Restart and Recreate restart them at once; Stop, Pause, Delete and
  Disconnect end them.

### D8 — Terminal and main process

The supervisor replaces the image's `CMD`/`ENTRYPOINT`. That means:

- `terminalMode: 'attach' | 'smart'` and `detectContainerCmd*` do not apply.
- The workload's start command is passed after `--` at create time.
- A foreground create attaches to that command. The app must create with `--detach`.

| Option | Trade-off |
|---|---|
| **A. Terminals = `openshell sandbox connect N`**; profile has an optional *main command* (e.g. `claude`, `npm run dev`) launched via `--detach -- CMD`; restart behaviour via `--restart-policy never/on-failure/always` | Clean mapping |
| B. Terminals = `openshell sandbox exec N --tty -- <shell>` | Allows a custom shell per profile (`container.shell`) — **flag names unverified** |

Also decide: the "ssh" terminal context has no meaning for local OpenShell
profiles. Hide it, or map it to the host shell?
**Remote profiles (D3-C):** terminal = `ssh -t host openshell sandbox connect N`,
built with the existing `TerminalManager.buildCommonSSHOpts`. The `ssh`
terminal context keeps its current meaning for remote OpenShell profiles (a
shell on the remote host).

**Recommendation:** A. Map custom `shell` to B only if a user needs it. Hide the
`ssh` context for **local** OpenShell profiles; keep it for remote ones (D3-C).

**Decision (2026-10-30, after Phase 0): A + B, like Docker's `smart` mode.**
Phase 0 showed that `sandbox connect` **attaches to the main process**, and
exiting it ends the sandbox (§8.4). So:

- Terminals use `sandbox exec N --tty -- <shell>` (B). `exit` there never
  affects the sandbox.
- Only the first terminal of a profile **with a main command** uses `connect`
  (A), to attach to that command.
- Default shell: `bash`, falling back to `sh`. It can be overridden with
  `openshell.shell`.
- Sandboxes without a main command are created with `--restart-policy always`,
  so an accidental attach + `exit` restarts the shell instead of ending the
  sandbox.
- ssh context: unchanged (local profiles: host shell; remote: the SSH host).

### D9 — Pause / disconnect semantics

`onDisconnectBehavior: 'pause'` and `existingContainerBehavior` must map to
OpenShell:

| Our setting | Proposed OpenShell action |
|---|---|
| `pause` | `sandbox suspend` if supported; else **fallback** (choose: `stop` or `leave`) |
| `stop` | `sandbox stop` (workspace preserved) |
| `leave` | nothing |
| `recreate` | `sandbox delete` → wait → `create` (**destroys uploaded workspace** — warn in UI) |
| `attach` / `attach-or-recreate` | `start` if stopped / `resume` if suspended, else connect |

How do we detect suspend support? Options: try and fall back on error, or a
per-profile checkbox.
**Recommendation:** try-then-fallback to `stop`, logged as a warning.
**Decision:** fallback ☐ stop ☐ leave; detection ☐ try/fallback ☐ checkbox — _______

### D10 — Sandbox naming

Today `container.name` is forced to equal the profile name (`ProfileManager.create`).
Profile names can contain spaces/uppercase, and sandbox names are scoped per
OpenShell *workspace*.

| Option | Trade-off |
|---|---|
| **A. Store `openshell.sandboxName` = slug(profile name) at creation; keep it stable on rename** | Rename doesn't orphan the sandbox |
| B. Derive on every call | Rename silently points to a different/non-existent sandbox |

Also: which OpenShell workspace? Default `default`, optional field.
**Recommendation:** A, optional `workspace` field defaulting to `default`.
**Decision:** ☐ A ☐ B — _______

### D11 — Profile data model

| Option | Trade-off |
|---|---|
| **A. `backend?: 'docker' \| 'openshell'` (default `docker`) + optional `openshell?: OpenShellConfig` block; leave `container` untouched** | Backwards compatible with stored profiles and exports. No migration needed. |
| B. Discriminated union `Profile = DockerProfile \| OpenShellProfile` | Stronger typing, but every consumer of `Profile` changes and stored JSON needs migration |

**Recommendation:** A.
**Decision:** ☐ A ☐ B — _______

### D12 — Status updates

| Option | Trade-off |
|---|---|
| **A. Poll `openshell sandbox get N -o json`** (same cadence as current Docker status), faster while a transition is in progress | Simple |
| B. Stream via SDK `watchLogs` / raw watch RPC | Real-time; requires D1-C |

**Recommendation:** A.
**Decision:** ☐ A ☐ B — _______

### D13 — Version compatibility

OpenShell is pre-1.0 and had breaking changes in 0.1.0 (e.g. `--from ./Dockerfile`
removed). CLI JSON output and flags may move.
**Recommendation:** On first use of an OpenShell profile run `openshell --version`, require ≥ the version
we test against (pin in a constant). Show a banner if it's older or newer than
tested. Document the tested version in README.
**Decision:** minimum version ______; behaviour on newer ☐ warn ☐ allow silently

---

## 3. Target design

### 3.1 Data model (assuming D11-A)

```ts
// src/shared/types.ts
export type ProfileBackend = 'docker' | 'openshell'

export interface OpenShellForward {
  localPort: number        // listener on this machine
  targetPort: number       // loopback port inside the sandbox
  bindAddress?: string     // default 127.0.0.1
}

export interface OpenShellConfig {
  gateway?: string                 // registered gateway name; omit = active gateway
  cliPath?: string                 // path to `openshell` on the target (local or remote host); default 'openshell'
  workspace?: string               // OpenShell workspace, default 'default'
  sandboxName: string              // stable, set at profile creation (D10); DNS-1123 label, max 19 chars
  driver?: 'docker' | 'podman' | 'vm' // gateway compute driver; keys the driver config JSON (default 'docker')
  image?: string                   // --from; omit = gateway default image
  template?: string                // --template; mutually exclusive with image/cpu/memory/gpu/env
  mainCommand?: string[]           // after `--` (D8)
  restartPolicy?: 'never' | 'on-failure' | 'always'
  policyFile?: string              // --policy (D5)
  policyPreset?: string            // D5 presets
  providers?: string[]             // --provider (D6)
  cpu?: string                     // e.g. '2', '500m'
  memory?: string                  // e.g. '4Gi'
  gpu?: number | true              // --gpu [COUNT]
  env?: Record<string, string>     // non-secret only
  labels?: Record<string, string>
  workspaceMount?: {               // D2-A default; becomes a bind entry in driver config
    localPath: string              // supports ${cwd} / ${projectName} like container.workspaceMount
    targetPath: string             // must be below /sandbox, not /sandbox itself
    readOnly?: boolean             // default false here (OpenShell's own default is true)
  }
  uploads?: { localPath: string; sandboxPath?: string; gitIgnore?: boolean }[]  // D2-B fallback
  forwards?: OpenShellForward[]    // D7
  driverConfigJson?: string        // advanced; requires gateway opt-in
}

export interface Profile {
  // …existing fields…
  backend?: ProfileBackend          // undefined === 'docker'
  openshell?: OpenShellConfig
}
```

### 3.2 Backend abstraction

```
ipcHandlers ──► ContainerBackend (interface)
                 ├── ContainerManager  (today's Docker/SSH code, stays in place;
                 │                      only gains `implements ContainerBackend`)
                 └── OpenShellBackend  (new, wraps OpenShellCli)

OpenShellCli  — single place that spawns `openshell`, adds `-g <gateway>`,
                `--color never`, `-o json`, timeouts, and parses JSON/errors.
```

```ts
interface ContainerBackend {
  getStatus(p: Profile): Promise<ContainerState>
  start(p: Profile): Promise<void>       // create if not-found
  stop(p: Profile): Promise<void>
  pause(p: Profile): Promise<void>
  unpause(p: Profile): Promise<void>
  restart(p: Profile): Promise<void>
  remove(p: Profile): Promise<void>
  recreate(p: Profile): Promise<void>
  getLogs(p: Profile, lines?: number): Promise<string>
}
```

`TerminalManager.buildCommand`, `stageFile/stageImage` and
`ConnectionManager.connect` get an **early-return** `if (profile.backend ===
'openshell')` branch at the top. The existing Docker/SSH code below it stays
byte-for-byte unchanged. That mirrors how `profile.local` is handled today,
so the code stays consistent with the existing style and the Docker path cannot
regress through the new code.

`workspaceMount` is turned into a `bind` entry under the active driver's key
(`docker` / `podman` / `vm`) and merged with any user `driverConfigJson`.
Path substitution reuses the `${cwd}` / `${projectName}` logic already in
`ContainerManager.buildDockerRunCommand`. Extract that logic into a shared
helper instead of duplicating it.

`OpenShellCli` runs commands through a **runner** chosen per profile. The two
runners mirror `ContainerManager.exec` → `localExec` / `sshExec`:

- **Local runner** (`profile.local`): `execFile(cliPath, args)`.
- **SSH runner** (remote profiles, D3-C): `ssh <opts> host <quoted cliPath + args>`.
  The SSH option building (`-i`, `-p`, `BatchMode`, `ConnectTimeout`,
  `extraOptions`) is today duplicated across `ContainerManager.sshExec`,
  `ContainerManager.detectImagePorts` and `TerminalManager.buildCommonSSHOpts`.
  Extract it into one shared helper and reuse it, rather than adding a fourth
  copy. Arguments for the remote side are shell-quoted with the same approach as
  `TerminalManager.shq`.

All local invocations use `execFile`/`spawn` with **argument arrays** (no shell
string interpolation). Remote invocations quote every argument. Profile
fields such as image, env and paths are user-controlled.

---

## 4. Phased implementation

### Phase 0 — Spike (½–1 day, no product code)

Verify the assumptions this plan depends on, on a local Docker-driver gateway:

- [x] `openshell sandbox create --detach` **without** a main command keeps the sandbox `READY` (retained shell) and returns. *(0.1.6: returns in ~5 s with the sandbox Ready; see §8.4)*
- [x] `openshell sandbox get N -o json` shape: where phase, conditions/error reason and host-key fingerprint live; exit code when the sandbox doesn't exist.
- [x] `openshell sandbox connect N`: exit behaviour. **It attaches to the main process**; see §8.4. *(resize inside node-pty and concurrent connects: still open)*
- [ ] `openshell forward service … --local` stays in the foreground, survives idle, and exits cleanly on SIGTERM (D7-A).
- [x] Bind mount on a Docker gateway with the D2 opt-in: read/write works, live changes visible both ways. *(DGX Spark, see §8.4)*
- [x] File ownership in the mounted folder as seen from the sandbox (UID 1000 vs host user) and on the host after the sandbox writes.
- [ ] How to learn the gateway's compute driver (to pick the `docker`/`podman`/`vm` JSON key), and whether bind-mount opt-in is detectable before create.
- [x] Exact error text when creating with a bind mount on a gateway that has **not** opted in.
- [ ] `sandbox upload` speed/behaviour for a typical repo; download path (D2 fallback).
- [x] `sandbox suspend` support on Docker driver (D9): **not supported** (see §8.4).
- [x] Exact `sandbox exec` TTY flags (D8-B): `sandbox exec N --tty -- <cmd>` gives an independent shell.
- [ ] Remote (D3-C): `ssh host openshell --version` and `… -o json` with a non-login shell (PATH, clean stdout, exit codes over SSH).
- [ ] Remote (D3-C): `ssh -t host openshell sandbox connect N` in node-pty: resize, Ctrl-C, exit.
- [ ] Remote (D3-C): `ssh host openshell forward service …` ends on the remote host when the local `ssh` is killed (no orphans).
- [ ] Remote (D3-C): two-hop upload (`cat > /tmp/x && openshell sandbox upload …`) for a file and a directory.

**Exit:** short findings note appended to this file; decisions D1–D13 recorded.

### Phase 1 — Seams for a second backend, no behaviour change

- Add optional `backend`/`openshell` types (D11). Absent `backend` means `'docker'`.
- Add the `ContainerBackend` interface. `ContainerManager` keeps its file, class name and code, and only declares `implements ContainerBackend`.
- `ipcHandlers` picks the backend by `profile.backend ?? 'docker'`. For Docker this resolves to the same `ContainerManager` instance as today.
- **Acceptance:** `npm run typecheck` + `npm run lint` clean, and the full Docker/SSH regression checklist (§5) passes.

### Phase 2 — OpenShell lifecycle + status (local and remote via SSH)

- `OpenShellCli` helper (local + SSH runner per §3.2, JSON parse, error mapping, `-g`, version check D13).
- `OpenShellBackend`: create (with policy/providers/resources/env/labels/template/main command), start/stop/suspend/resume/delete/recreate, status mapping (§1.4), logs via `openshell logs`.
- Wire `connection:launch` behaviours per D9. `ConnectionManager.connect`: local OpenShell profiles need no SSH tunnel; remote OpenShell profiles open the existing SSH tunnel exactly as Docker profiles do. Both get a gateway reachability check (D4), run locally or over SSH.
- OpenShell check (CLI present, version OK, gateway reachable) runs **lazily**, only when an OpenShell profile is opened/connected. A failure shows a toast with a setup hint on that profile only and never affects Docker profiles or app start (§0.1 rule 3).
- **Acceptance:** an OpenShell profile can be created, started, stopped, suspended/resumed (or falls back), deleted, recreated. The status badge reflects phases, including `failed` with reason.

### Phase 3 — Terminals, workspace, file staging

- `TerminalManager.buildCommand`: local `openshell [-g G] sandbox connect N`; remote `ssh -t host openshell [-g G] sandbox connect N` (D8). Hide `attach`/`smart` and container-cmd detection for OpenShell profiles.
- Workspace per D2:
  - Default: bind mount from `openshell.workspaceMount` via driver config.
  - Fallback (Kubernetes gateway, or no opt-in): run uploads (two-hop for remote, see D2) after create, before the main command, which is then started via `sandbox exec` if needed. Add a "Sync to sandbox" action.
- `stageFile`/`stageImage` → local: `openshell sandbox upload N <tmpfile> <targetPath> --no-git-ignore`; remote: same command after `cat > /tmp/…` over SSH, mirroring today's remote `docker cp` branch.
- **Acceptance:** multiple terminals per sandbox; image paste and file drop land in the sandbox; workspace is present under `/sandbox/…`.

### Phase 4 — Port forwards  *(implemented 2026-10-30, see D7 and §8.1)*

- Per D7: `ConnectionManager` spawns one forward process per `openshell.forwards[]` entry (remote: via `ssh host`, behind the existing `-L` tunnel), reports per-forward `active` state through the existing `PortForwardState`, and reuses the reconnect/backoff logic.
- Image `EXPOSE` detection (`detectImagePorts`) can stay for local Docker/Podman gateways to pre-fill forwards.
- **Acceptance:** forwards come up after `READY`, stop on disconnect/stop, and auto-reconnect after a gateway restart.

### Phase 5 — Editor UI, policy and providers

- `ProfileEditor.tsx`: backend switch "Docker container / OpenShell sandbox", **defaulting to Docker**; the existing Docker/SSH sections are unchanged and shown only for Docker. The OpenShell section has: gateway (dropdown from `gateway list -o json`), image or template (template list from `sandbox template list -o json`), main command, restart policy, CPU/memory/GPU, env (with secret-name warning, D6), providers (multi-select from `provider list -o json`), policy preset/file (D5), uploads, forwards, advanced driver JSON.
- Ship policy presets under `resources/policies/` (or wherever D5 decides).
- LogViewer: optional filter for denied connections (D5).
- Profile export/import: include `openshell` block; policy *file paths* are machine-specific (warn on import).
- **Acceptance:** a non-technical user can create a working sandbox profile from a preset without touching YAML.

### Phase 6 — Remote hardening (D3-C)

Remote support itself lands in Phases 2–4, because D3-C reuses the existing SSH
plumbing. This phase covers what's left:

- Clear diagnostics for remote setup problems:
  - CLI not found on the remote PATH (suggest `cliPath`);
  - gateway not registered/selected for the SSH user;
  - gateway down;
  - bind mounts not enabled in the remote gateway TOML.
- Editor: gateway dropdown and provider/template lists fetched over SSH for remote profiles.
- README section "Remote OpenShell host setup": install CLI + gateway (or gateway container), register the gateway as the SSH user, optional bind-mount opt-in.
- **Acceptance:** phases 2–4 scenarios pass against a remote host, and the remote Docker/SSH regression checklist (§5.1) still passes.

### Phase 7 — Docs and polish

- README: prerequisites, tested OpenShell version, gateway setup, security notes (bind mounts, env vs providers).
- Update `ARCHITECTURE.md` with the backend diagram.
- Optional: "Convert Docker profile to OpenShell" action (maps image/env/ports/workspace; flags secrets).

---

## 5. Testing

The repo currently has no automated test runner (`package.json` has
`typecheck`/`lint` only). Proposal:

- Keep the `OpenShellCli` JSON parsing and the phase→status mapping as pure functions. These are the first candidates if a runner (e.g. Vitest) is added. **Decision:** add Vitest now? ☐ yes ☐ no
- Manual smoke checklist per phase (acceptance bullets above) against a local Docker-driver gateway on Linux (ARM64 dev container per `CLAUDE.md`) and macOS.

### 5.1 Docker/SSH regression checklist (run at the end of every phase)

Run with the `openshell` CLI **uninstalled or not on PATH** at least once, to
prove Docker profiles never depend on it (§0.1 rule 3).

- [ ] App starts with no OpenShell-related errors or toasts when only Docker profiles exist.
- [ ] Existing stored profiles (no `backend` field) load and open as Docker profiles; editor shows the same fields as before.
- [ ] **Local** Docker profile: create/run, `existingContainerBehavior` variants (attach, start, recreate, ask, attach-or-recreate), port mappings, workspace mount with `${cwd}`/`${projectName}`.
- [ ] **Remote** Docker profile over SSH: tunnel connects, `-L` forwards active, auto-reconnect after killing the `ssh` process, `docker` commands executed over SSH.
- [ ] Terminals: `local`, `ssh` and `container` contexts; `exec`, `attach`, `smart` modes; detach/attach window; session restore after app restart.
- [ ] File drop / image paste into a container terminal (local and remote).
- [ ] Stop / pause / unpause / restart / remove; `onDisconnectBehavior` on window close.
- [ ] Profile export → import round-trip; clone; move to project.
- [ ] One Docker and one OpenShell profile connected at the same time (from Phase 2 on).
- [ ] Remote Docker profile and remote OpenShell profile on the **same** SSH host connected at the same time; disconnecting one leaves the other's tunnel and forwards intact.

## 6. Risks

| Risk | Mitigation |
|---|---|
| OpenShell pre-1.0: CLI flags / JSON output change | Version gate (D13), all parsing in `OpenShellCli`, pin tested version |
| Bind-mounted workspace is outside the filesystem policy (agent can modify host files there) | Warning in editor (D2). Mount only the project folder, never `$HOME`. Offer read-only mode. |
| Gateway has not opted in to bind mounts | Detect and show the TOML snippet (D4); fall back to upload |
| Bind mount unavailable on Kubernetes gateways; VM limited to 3 mounts on x86_64 | Automatic upload fallback (D2) |
| Remote host: `openshell` not on non-interactive SSH PATH | `openshell.cliPath` per profile; diagnostic in Phase 6 |
| Remote host: gateway not registered/selected for the SSH user | Check via `ssh host openshell status`; setup hint (D4) |
| Orphaned remote `openshell forward service` processes after a dropped SSH connection | Verified in Phase 0; `ssh -tt` / remote `exec` wrapper; reconcile on reconnect |
| Deny-by-default network breaks first run ("npm install hangs") | Presets (D5), surface `action=deny` log lines |
| `recreate` silently destroys uploaded/edited files | Confirm dialog naming what is lost (existing `ConfirmModal`) |
| Secrets passed as `env` | Warning/block (D6), provider picker |
| Gateway not installed/running | Lazy check on OpenShell profiles only + setup hint (D4); Docker profiles unaffected |
| Image incompatibility (root `USER`, distroless, scratch) | Surface create error verbatim; document image requirements; policy `process.run_as_user` |
| Remote gateway auth complexity | Avoided by D3-C: the CLI runs on the gateway host as the SSH user. Only relevant if D3-B is added later. |

## 7. Image requirements to document for users

- Standard Linux base (no distroless / `FROM scratch`).
- Non-root `USER`, or it runs as UID/GID 1000. Root images are rejected unless the policy sets `run_as_user`.
- Workspace is `/sandbox`, or the image `WORKDIR` if it is something other than `/`/`/sandbox` (must be writable).
- `CMD`/`ENTRYPOINT` do not run. Put the start command in the profile's *main command*.
- `--from` does not build Dockerfiles. Build with the gateway's engine (`docker build` / `podman build`) or push to a registry the gateway can pull from.

## 8. Implementation status

### 8.1 Done (2026-10-30, branch `feature/openshell-sandbox`)

**Phase 1: seams, no behaviour change for Docker**

- `Profile.backend` / `Profile.openshell` and the OpenShell config types (`src/shared/types.ts`).
- `src/shared/backend.ts` holds the helpers. A profile counts as OpenShell only
  when `backend === 'openshell'` **and** the `openshell` block exists;
  everything else is Docker.
- `ContainerBackend` interface plus `selectBackend()` (`src/main/managers/ContainerBackend.ts`).
  `ContainerManager` only gained `implements ContainerBackend`.
- `ipcHandlers` (launch + `container:*`) and the window-close handler in
  `index.ts` resolve the backend per profile. For Docker profiles that is the
  same `containerManager` instance as before.

**Phase 2: OpenShell lifecycle + status, local and remote via SSH**

- `OpenShellCli` (`src/main/managers/OpenShellCli.ts`):
  - local runner: `execFile`, no shell;
  - SSH runner: `ssh <batch opts> host '<quoted cli + args>'`, with a leading `~/` in `cliPath` kept expandable;
  - JSON parsing, error classification (CLI missing / sandbox not found / gateway / ssh) with setup hints;
  - phase→status mapping;
  - `--color never`, `-g`, `--workspace`.
- `OpenShellBackend` (`src/main/managers/OpenShellBackend.ts`):
  - lazy preflight: `--version` ≥ 0.1.0, then `status -o json`. It is cached per target after it succeeds and runs before the tunnel opens on launch.
  - `create` with image/template, resources, env, providers, policy file, labels, restart policy and main command;
  - workspace bind mount merged into `--driver-config-json`;
  - start (create if missing, resume if suspended);
  - stop; suspend with fallback to stop (D9);
  - restart (stop + start); delete (waits until gone); recreate; logs.
  - `start` waits for a `Stopping`/`Deleting`/`Suspending` phase to settle first.
- `ProfileManager` assigns a unique `sandboxName` (slug, max 19 chars) on
  create when it is missing. It is kept on rename, and a clone gets its own.
- Shared SSH helpers for new code: `src/main/managers/sshCommon.ts`. The three
  existing Docker copies are deliberately left untouched for now (§0.1 rule 2).
  Migrating them is a separate, regression-tested change.

**Phase 3 (part): terminals** (revised after Phase 0, see D8)

- `TerminalManager.buildCommand` has an early-return branch for OpenShell
  `container` terminals:
  - normally: `openshell sandbox exec N --tty -- <shell>`;
  - only the first terminal of a profile with a main command: `openshell sandbox connect N`;
  - remote profiles: the same command wrapped in `ssh -t host '…'`.
- The `local`/`ssh` contexts use the existing code.
- File drop / image paste into a sandbox terminal returns "not staged" for now
  (no upload yet).

**After Phase 0: phase-aware lifecycle**

- `start()`:
  - infrastructure Error → stop, then start;
  - Completed or main-process Error (the main process ended) → start; if that fails into an infrastructure Error, stop then start; otherwise an error suggesting Recreate;
  - Stopping / Suspending / Deleting → wait, then decide;
  - in all cases it waits until the sandbox is Ready, with an error that suggests Recreate if it stays in Starting.
- `stop()` skips Stopped, Completed and main-process Error (the gateway counts them as stopped), and refuses Starting with a clear message.
- Sandboxes without a main command are created with `--restart-policy always`.

**Phase 4: port forwards** (D7)

- `OpenShellForwards` (`src/main/managers/OpenShellForwards.ts`), owned by
  `ConnectionManager`: one process per `openshell.forwards[]` entry (see D7
  for the command lines), readiness from the "✓ Forwarding" line, retry with
  backoff, a warning in the event log once per new failure reason.
- `ConnectionManager` merges the sandbox forwards into the profile's
  `portForwards` (unchanged object for profiles without any). `disconnect()`
  stops them. `ipcHandlers` starts them after launch and after
  Start/Unpause/Restart/Recreate, and stops them before Stop/Pause/Delete.
- Status panel: the "Port Forwards" section also shows for local OpenShell
  profiles, e.g. `localhost:8080 → os-spark:3000`. "Open in browser" on the
  profile tile uses the first sandbox forward.
- Profile JSON: `"forwards": [{ "localPort": 8080, "targetPort": 3000, "remotePort": 18080 }]`
  inside `openshell` (`remotePort` and `bindAddress` optional).

**Renderer (minimal, ahead of Phase 5)**

- Connect / auto-connect open a `container` terminal for OpenShell profiles.
- The status strip and status panel show the sandbox name, image/template and
  status.
- The section title reads "OpenShell sandbox".
- Delete **and Recreate** ask for confirmation for sandboxes, because both lose
  any files in the sandbox that aren't in a mounted folder.

There is no editor UI yet. OpenShell profiles can only be created by importing
JSON, for example:

```json
{
  "name": "agent-sandbox",
  "local": true,
  "ssh": { "host": "", "forwards": [] },
  "backend": "openshell",
  "openshell": {
    "sandboxName": "agent-sandbox",
    "image": "ghcr.io/example/agent:latest",
    "providers": ["github"],
    "workspaceMount": { "localPath": "${cwd}", "targetPath": "/sandbox/project" }
  }
}
```

**Verification so far**

- `npm run typecheck` and `npm run build` pass.
- `npm run lint` cannot run: `eslint` is not installed in `node_modules`.
- The new modules were exercised with a throwaway script against a **fake**
  `openshell` shim and a fake `ssh` that runs the remote string through `sh -c`.
  Covered:
  - argument building, driver-config merge and mount validation;
  - full lifecycle, including the suspend→stop fallback and waiting on transitional phases;
  - `Error` phase reasons;
  - missing CLI, locally and remotely;
  - remote quoting of hostile env values and main commands;
  - backend selection.
- **Not yet verified against a real OpenShell gateway.** Phase 0 is still open.
- The Docker/SSH regression checklist (§5.1) has **not** been run in the GUI yet.

### 8.2 Decisions taken provisionally for the implementation

These follow the recommendations in §2. They are still open for the user to
confirm or change.

| ID | Used |
|---|---|
| D1 | A: CLI |
| D9 | `suspend`, falling back to `stop` on a plain CLI failure (logged as a warning) |
| D10 | A: stored slug, stable on rename |
| D11 | A: `backend` field + `openshell` block |
| D12 | A: polling. The renderer's existing 30 s status poll is reused; no faster polling during transitions yet. |
| D13 | Minimum 0.1.0. Older is a hard error; newer is allowed silently. |

### 8.3 Findings from the OpenShell source (replace Phase 0 guesses)

- **Sandbox names** are DNS-1123 labels with a **maximum of 19 characters**
  (`openshell-server` `MAX_ROUTABLE_NAME_LEN`).
- **`sandbox get -o json`:**
  - top-level `phase` is title case (`"Ready"`, `"Suspended"`, …);
  - `conditions[]` carries `{type, status, reason, message}`;
  - `exit_code` is also present;
  - a missing sandbox is a gRPC `NotFound` error ("sandbox not found") with a non-zero exit code.
- **`status -o json`:** `status` is one of `connected`, `connected_http`,
  `disconnected`, `not_configured`.
- **`sandbox create`:**
  - without a TTY and without a command, it detaches on its own;
  - with `--detach` it never attaches;
  - an empty command makes the supervisor start the image's login shell;
  - missing required providers make non-interactive create **fail** instead of prompting (we pass `--no-auto-providers` to be explicit).
- **`--template` conflicts** with `--from`, `--cpu`, `--memory`, `--gpu`,
  `--env`, `--env-from` and `--driver-config-json`. A workspace mount therefore
  can't be combined with a template; the backend reports that clearly.
- **`--restart-policy`** accepts `never | on-failure | always`.
- **Stop/start/suspend/resume** have no `--wait`. They return before the phase
  settles, hence the waits in the backend.
- **`logs`** takes `-n <lines>` (default 200), `--tail`, `--since`, `--source` and `--level`.
- **Global flags:** `-g/--gateway`, `--workspace` (env `OPENSHELL_WORKSPACE`), `--color auto|always|never`.

### 8.4 Phase 0 results (OpenShell 0.1.6, local Docker-driver gateway, 2026-10-30)

| Check | Result | Consequence in the app |
|---|---|---|
| `status -o json` | `{"status":"connected", "version":"0.1.6", "gateway":"openshell", …}` | Preflight check matches |
| Compute driver | Not shown by `status` or `gateway list` | Profile field `openshell.driver` (default `docker`) stays |
| `create --detach --no-auto-providers` | Returns after ~5 s, phase already `Ready` | ✓ |
| `get -o json` | As read from the source: `phase`, `conditions[]`, `exit_code`, `restart_count`, `restart_policy` | ✓ |
| `get` of a missing sandbox | `× code: 'Some requested entity was not found', message: "sandbox not found"`, exit 1 | Classified as not-found ✓ |
| `suspend` / `resume` | `compute driver does not support sandbox suspend`, exit 1 | Pause falls back to stop; Unpause starts ✓ |
| `stop` / `start` from Ready | Synchronous: the phase is `Stopped` / `Ready` when the command returns | ✓ |
| **`connect`** | **Attaches to the main process** (the login shell when there is no main command). Ctrl-D / Ctrl-P Ctrl-Q detach. `exit` ends the main process: exit 0 → `Completed`, non-zero → `Error` (`restart_policy: never`). | Terminals use `exec` (D8 decision) |
| `exec N --tty -- bash` | Independent shell; `exit` leaves the sandbox `Ready` | Default terminal command |
| `--restart-policy always` + `exit` in `connect` | Shell restarts, phase stays `Ready`, `restart_count` 1 | Default when there is no main command |
| Open `exec` terminals during a main-process restart | Closed: *"exec relay closed before the command reported an exit status"*. The sandbox stays `Ready`; a new terminal works immediately. | Acceptable. The app itself never attaches to the main shell, so this only happens through an external `connect` + `exit`. |
| `start` on `Error` | Refused (*"stop the sandbox before retrying start"*). Once it also left the sandbox **stuck in `Starting`** (*"Docker sandbox is already running generation …"*). | `start()` stops first |
| **Two kinds of `Error`** (from the gateway source, `quiesce_sandbox` / `start_sandbox_with_intent`) | *Main-process Error*: the main process exited non-zero (condition `MainProcessFailed`, `exit_code` set). The gateway treats it like `Completed`, i.e. already stopped: `stop` changes nothing, but the CLI then waits for `Stopped` and fails with *"MainProcessFailed: … while waiting for Stopped"* (or hangs, for `Completed`). `start` is allowed directly. *Infrastructure Error*: anything else; `start` requires `stop` first. | `phase()` reports `main-process-error` separately. `stop()` skips it. `start()` tries `start` directly (`restartEnded()`). |
| `start` on a main-process Error / `Completed` (Docker driver) | In the app (0.0.80, `os-err`, `exit 1`): direct `start` → `Ready`. Earlier, by hand, it either failed into an infrastructure Error (then `stop` → `start` works), or leaves the sandbox stuck in `Starting` (*"already running generation"*). Probably the settled `stop` never stops the old container. | `restartEnded()`: on failure, if the sandbox is now in an infrastructure Error, `stop` → `start`; otherwise an error pointing to **Recreate**. Only reachable with `restartPolicy` `never`/`on-failure`, since the app's default is `always`. |
| `stop` on `Starting` | Refused (*"must be Ready, Suspended, Error, or in an automatic restart to stop"*) | Clear error, suggests Recreate |
| `start` on `Completed` | Allowed, but **failed** (*"supervisor authentication bundle does not match runtime session"*) and went to `Error`. Then `stop` → `start` → `Ready` worked. Likely an OpenShell bug. | `start()` retries via stop |
| `stop` on `Completed` | **Does not return** | `stop()` skips Completed / Stopped |
| `delete` while stuck in `Starting` | Works: *"deletion accepted; cleanup is pending"*, gone within 3 s | Recreate is the way out of a stuck sandbox |
| Bind mount without the opt-in | *"caller driver config is disabled; a gateway administrator must enable allow_driver_config"*, exit 1 | `create()` turns it into a hint with the `gateway.toml` settings, the host and the restart command |
| Opt-in on an Ubuntu package install | `~/.config/openshell/gateway.toml` did not exist (built-in defaults). A new file with `[openshell] version = 2` plus the D2 tables passed `openshell-gateway config preflight`; then `systemctl --user restart openshell-gateway`. All sandboxes survived the restart. | Documented in the hint; Phase 6 README section |
| Bind mount with the opt-in | `--driver-config-json '{"docker":{"mounts":[{"type":"bind",…,"target":"/sandbox/project","read_only":false}]}}'` works. Read and write in both directions, changes visible immediately. | ✓ |
| Ownership | Sandbox user is `uid=1000(ubuntu)`; files it creates are owned by 1000:1000 on the host. That matched the host user here (1000); a host user with another uid gets files owned by 1000. | Mention in the editor's mount warning (Phase 5) |

Still open from Phase 0:
- two concurrent `connect`s, and closing the window while connected (only matters for profiles with a main command; all other terminals use `exec`);
- upload (and the two-hop remote upload);
- logs;
- remote `forward service` over `ssh -tt` when the **network** drops (Disconnect and app quit are verified clean, §8.4.1).

Worth reporting upstream: `start` on `Error` wedging the sandbox in `Starting`;
`start` on `Completed` failing with the auth-bundle error; `stop` on
`Completed` / a main-process `Error` hanging or failing (the CLI waits for a
`Stopped` the gateway never sets).

### 8.4.1 App tests against a remote host (D3-C), 0.0.77–0.0.81, 2026-10-30

Setup: AppImage on an x64 laptop with `--config-dir`; OpenShell 0.1.6 CLI and
gateway on an NVIDIA DGX Spark (arm64), reached by SSH (Tailscale name).
`cliPath` was not needed (`/usr/bin/openshell`).

| Test | Result |
|---|---|
| Connect creates the sandbox on the remote host; terminal opens in the sandbox | ✅ |
| Second terminal via "+" opens in the sandbox (after the `defaultContext` fix, 0.0.77) | ✅ |
| `exit` in a terminal leaves the sandbox `Ready`, `restart_count` 0 | ✅ |
| Resize (`stty size` follows the window), Ctrl-C | ✅ |
| Reconnect reuses the existing sandbox | ✅ |
| Main-shell restart (`restart-policy always`) keeps the sandbox; open terminals close | ✅ (expected) |
| Start on a main-process Error (`restartPolicy: never`, `exit 1`) | ✅ (0.0.80) |
| Pause (= stop on the Docker driver), Unpause; badge shows the real state (0.0.81) | ✅ |
| Stop, Start, Restart, Recreate, Delete | ✅ |
| Missing CLI (`cliPath: /nope`) → clear message, no hang | ✅ |
| Local Docker profile (sysbox runtime, workspace mount) in the same instance | ✅ unchanged |
| Session restore + Reconnect for a sandbox terminal (`hostname` shows the sandbox) | ✅ |
| Workspace mount from the remote host (`workspaceMount`, gateway opt-in enabled) | ✅ Files of `/home/<user>/ostest` visible at `/sandbox/project` |
| Port forward `localhost:8080 → host 127.0.0.1:18080 → sandbox :3000` (0.0.83) | ✅ `curl localhost:8080` on the laptop reaches a server in the sandbox |
| Forward after Stop → Connect, sandbox starts in < 5 s (0.0.84 fix: start forwards while the tunnel is still `connecting`) | ✅ |
| No leftover `forward service` processes on laptop or remote host after Disconnect and after quitting the app (`ssh -tt`) | ✅ |

### 8.5 Next steps

1. Finish Phase 0 (open items in §8.4): bind mounts, terminals in the app,
   then a remote host.
2. Run the §5.1 Docker/SSH regression checklist in the app.
3. Phase 3 remainder: upload fallback + "Sync", and file staging via `sandbox upload`.
4. Phase 4: forwards.
5. Phase 5: editor UI.
