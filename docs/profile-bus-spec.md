# Profile Bus — Design Specification

**Status:** Draft (approved for implementation) · **Scope (MVP):** local Docker profiles ·
**Last updated:** 2026-07-15

*Amended 2026-07-15 after validation against HEAD `5ec9f63`: socket moved to a space-free runtime
dir and the **directory** (not the socket file) is bind-mounted; tokens persisted + redacted from the
EventLog; shim install switched to base64 (no stdin path exists); recreate-to-apply semantics and
sentinel/quiescence caveats documented. Architecture unchanged.*

> This document is self-contained: it captures the problem, the decisions and their rationale, the full
> design, a codebase-orientation appendix, an ordered implementation checklist, open questions, and how
> to verify. A future session should be able to implement from this doc alone.

---

## 1. One-paragraph summary

Let a `claude` (Claude Code CLI) running inside one Profile's container send a prompt to **another
Profile's live interactive `claude` session** and get that session's answer back. The source calls a
small HTTP endpoint the app serves over a **bind-mounted Unix domain socket**; the app **types the
prompt into the target's live terminal and scrapes the answer** from its PTY output. Exchange is
authorized by **Project membership** (same Project + Project bus enabled), and callers are identified by
a **per-profile token**. MVP is **local Docker containers**; remote/SSH is a documented follow-up.

## 2. Problem & background

The app runs `claude` inside dev containers, one per Profile. A process inside a container is **fully
isolated** from the Electron app and every other Profile:

- The app only reaches *into* a profile via `ContainerManager.exec` (`docker exec` locally, or
  `ssh … docker exec` remotely) or by writing to a terminal's PTY (`TerminalManager.write`). There is
  **no server, socket, or callback surface** a container process can use to reach back out.
- PTY output is streamed straight to the renderer (`webContents.send('terminal:data', …)`) and is **not
  buffered anywhere in the main process** — only xterm in the renderer holds scrollback.

So the feature needs three things: (a) a channel *from* the source container back to the app, (b) a way
to deliver the prompt to the target and capture its answer, and (c) an authorization model for **which**
profiles may exchange.

## 3. Goals / non-goals

**Goals**
- A `claude` in Profile A can send a prompt to Profile B's **running** `claude` and get B's answer.
- The prompt joins **B's live conversation** (shared context/history); a user watching B's tab sees it.
- Exchange is authorized by **Project membership**.
- Strictly opt-in; **zero behavior change** for existing/non-participating profiles.

**Non-goals (MVP)**
- Remote / SSH profiles (§13 future work).
- Cross-project exchange (the Project is the trust boundary, by design).
- Guaranteed-clean answer extraction — capture from a live TUI is **best-effort** (§8.3).
- Starting B's `claude` for it — B must already have a live session (precondition, §8.3).

## 4. Decisions log (with rationale)

These were settled during design review; do not relitigate without reason.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | **Receiver execution** | Inject the prompt into B's **live interactive `claude`** via PTY write, then capture/de-render B's TUI output | User requirement: the answer must come from B's live session with shared context/history — not a fresh headless run. Accepted trade-off: extraction is heuristic (mitigated in §8.3). |
| D2 | **Authorization** | **Project-scoped**: two profiles may exchange iff same `projectId` and that Project has `busEnabled` | Reuses the existing Projects grouping; near-zero new UI; simplest mental model. |
| D3 | **Caller identity** | **Per-profile bearer token** (`token → profileId` map in the manager) | Container env vars can't be trusted to name the caller; the token is the identity anchor that makes D2 enforceable. |
| D4 | **Transport** | HTTP over a **bind-mounted Unix domain socket** | No network port on any interface; sidesteps the Linux `127.0.0.1`-vs-docker-bridge problem (§7); access gated by the mount + token. |
| D5 | **Source interface** | A `devenv-ask` **CLI shim** invoked via claude's Bash tool | Simplest to build and deliver into the container (no image rebuild). MCP tool deferred (§13). |
| D6 | **Scope** | **Local Docker containers** only for MVP | The socket bind-mount requires the container on the app's host; remote needs `ssh -R` (§13). |

**Rejected alternatives:** fresh headless `claude -p` on the receiver (rejected per D1 — loses live
context); loopback TCP + host-gateway (rejected per D4/§7 — LAN exposure + bind-address problem); a
shared global token (rejected per D3 — can't identify the caller); shared-file mailbox transport
(polling, correlation, stale-file races — kept only as a possible remote fallback).

## 5. Architecture

```
┌ Profile A container ─────────────┐        ┌ Electron main (host) ───────────────────┐
│ claude ─Bash─▶ devenv-ask B      │        │ PromptBusManager                         │
│                 │ curl           │  bind- │  http.Server.listen('…/bus.sock')        │
│      --unix-socket /run/…sock ───┼──mount▶│  POST /ask {profile,prompt} + token      │
│      DEVENV_BUS_TOKEN (A's)      │        │   token→A · target=B · same project? ✓   │
└──────────────────────────────────┘        │        ▼ resolve B's live terminal       │
                                            │  TerminalManager.write(B_pty, prompt)     │
┌ Profile B container ─────────────┐        │  + attachCapture(B_pty) ─┐                │
│ (live) claude  ◀── types prompt ─┼────────┤                          ▼                │
│         answer ── PTY output ────┼───────▶│  headless VT emulator → extract answer     │
└──────────────────────────────────┘        │        ▼ returns { result, … }            │
   (A and B share a bus-enabled Project)     └───────────────────────────────────────────┘
```

**Request flow:** source `claude` runs `devenv-ask B "…"` → shim `curl`s the UDS → `/ask` authenticates
by token (→ source profile), authorizes by Project, resolves B's live terminal, acquires B's
single-flight lock, injects the prompt, captures + de-renders the answer, returns JSON, shim prints
`.result`.

## 6. Authorization model

- **The Project is the trust boundary.** `Project.busEnabled` turns the bus on for its member profiles.
- A profile **participates** iff: it has a `projectId`, that Project's `busEnabled === true`, and it
  hasn't opted out (`profile.bus?.participate !== false`).
- Participating profiles can both **send to** and **receive from** other participating profiles **in the
  same Project**. Orphaned profiles (no Project) and profiles in other Projects cannot exchange.
- Enforced **server-side on every `/ask`**: derive source from token → require source & target share a
  non-empty `projectId` → require that Project `busEnabled` → require target participates. Else `403`.
- `devenv-ask "B"` resolves the target **by name within the caller's Project** (names need only be
  unique per project; can't accidentally hit a same-named profile elsewhere).

## 7. Why a Unix socket, not a loopback TCP port

A container's `127.0.0.1` is its own loopback, not the host's. On Linux, reaching a host TCP service
from a container requires `--add-host=host.docker.internal:host-gateway`, which routes over the docker
**bridge** (e.g. `172.17.0.1`) — and a server bound to `127.0.0.1` **rejects** connections arriving on
the bridge IP. To use host-gateway you'd have to bind `0.0.0.0`/the bridge IP, exposing a port to the
LAN. A **Unix domain socket bind-mounted into the container** avoids all of it: no network port, access
gated by the mount (only opted-in containers get it) plus the per-profile token, works regardless of
bridge IP. `curl --unix-socket` and Node's `http.Server.listen(path)` both support it directly.

## 8. Detailed design

### 8.1 Shared types — `src/shared/types.ts`
```ts
export interface Project {                 // EXTENDED (add busEnabled)
  id: string; name: string
  busEnabled?: boolean                     // authorization switch for this project's profiles
  createdAt: string; updatedAt: string
}

export interface ProfileBusConfig {        // NEW — per-profile tuning / opt-out only
  participate?: boolean                    // opt out of the project bus (default: true when project bus on)
  quietMs?: number                         // silence window marking a response complete (default ~4000)
  maxMs?: number                           // hard cap per request (default ~120000)
  useEndMarker?: boolean                   // sentinel-based completion (default true)
}

export interface PromptResult {            // NEW
  result: string; complete: boolean; truncated?: boolean; error?: string
}
export interface BusInfo { socketPath: string; running: boolean }   // NEW (token fetched per-profile)
```
Add `bus?: ProfileBusConfig` to `Profile`. Participation is governed by the **Project**, not this object.

### 8.2 `PromptBusManager` — `src/main/managers/PromptBusManager.ts` (new)
Responsibilities: own the HTTP-over-UDS server, issue/track per-profile tokens, authorize requests, and
orchestrate the inject+capture cycle.

- `start()`: choose `busDir = join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'devenv-bus')` and
  `socketPath = join(busDir, 'bus.sock')`. **Do not use `userData`**: this app's `productName`
  (`package.json:23`) puts spaces in the userData path, and `buildDockerRunCommand` joins args
  unquoted (`ContainerManager.ts:201`) — a spacey `-v` value breaks the docker command. The runtime
  dir is space-free and short (UDS paths cap at ~108 bytes).
  `fs.mkdir(busDir, { recursive: true, mode: 0o755 })`; `fs.unlink` any stale socket;
  `http.createServer(handler).listen(socketPath)`; `fs.chmod(socketPath, 0o666)` (see §8.4 note).
- `stop()` / on app quit: close the server and `fs.unlink` the socket.
- **Tokens:** `issueToken(profileId): string` — 32-byte hex (`crypto.randomBytes`), get-or-create and
  **persisted per profile in `electron-store`** (same trust level as the rest of the profile config)
  so tokens survive app restarts; revoke on profile delete. Index the lookup map by `sha256(token)` —
  a raw-token `Map` lookup is not timing-safe. `getTokenFor(profileId)`. Called by container injection
  (§8.4). Persistence + the directory mount (§8.4) mean containers launched in a previous app run keep
  working after a restart — no relaunch requirement.
- `getInfo(): BusInfo`.
- **`POST /ask` handler:**
  1. Read `Authorization: Bearer <token>` → look up **source profileId** by `sha256(token)` (see
     Tokens above); unknown → `401`.
  2. Parse body `{ profile, prompt, quietMs?, maxMs? }`; enforce a prompt **size cap** (e.g. 32 KB).
  3. Resolve **target** by name within the source's Project (fallback: by id, then verify same project).
  4. **Authorize** (§6): same non-empty `projectId`, Project `busEnabled`, target participates → else `403`.
  5. Resolve target's live terminal via `TerminalManager.getActiveTerminalForProfile` (§8.3); none →
     `409`/error `"target has no live claude session"`.
  6. Acquire the **per-target single-flight lock**; run the inject+capture cycle (§8.3); release.
  7. Respond `PromptResult` as JSON.
- Constructor: `(profileManager, terminalManager)`.

### 8.3 Receiver: inject into B's live session + capture (the hard part)

**Preconditions**
- B must have a **live terminal running interactive `claude`** (not a bare shell). If it's a shell, the
  injected text runs as shell commands — documented precondition; optionally guard later.
- **Single-flight per target**: one bus request per B at a time; others queue. (Note: this does not
  guard against the *human* also typing into B mid-request — that can corrupt capture; acceptable, doc it.)

**Terminal selection** — add `TerminalManager.getActiveTerminalForProfile(profileId)`: the profile's
active terminal; if several, most-recently-active. (MVP: single active terminal; multi-terminal
selection is a refinement.)

**Cycle ordering (important):** attach capture **before** writing, so no early output is missed.
1. `detach = terminalManager.attachCapture(terminalId, onData)`.
2. Create a headless VT emulator instance; on each `onData` chunk, `term.write(chunk)` and update
   `lastDataAt`; scan for the end-marker.
3. Inject via **bracketed paste** so multi-line prompts don't submit early, then Enter:
   `terminalManager.write(id, "\x1b[200~" + effectivePrompt + "\x1b[201~\r")`.
4. Wait for completion (below).
5. Extract the answer from the emulator buffer; `detach()`; dispose the emulator; return.

**Capture tap** — add to `TerminalManager` alongside the existing `pty.onData → safeSend`
(`TerminalManager.ts:90-93`):
```ts
attachCapture(terminalId: string, cb: (data: string) => void): () => void  // returns a detach fn
```
It tees raw PTY bytes to the bus **without** disturbing the renderer stream (the user's tab keeps
working). Implement with an internal `Map<terminalId, Set<cb>>` invoked from the same `onData`.

**De-rendering** — feed captured bytes into a **headless terminal emulator** (`@xterm/headless`, §8.7)
with large scrollback. `claude` redraws its TUI (cursor-up / clear-line), so a naive ANSI-strip would
concatenate every intermediate frame into duplicated garbage; replaying the escape sequences yields the
final rendered text.

**Completion detection** (most reliable → fallback):
1. **End-marker** (`useEndMarker`, default on): set `effectivePrompt = prompt + "\n\nWhen fully finished,
   output this exact line on its own: @@BUS_END:<nonce>@@"`. Complete when the sentinel is rendered as
   an **exact whole line** in the region *after* the injected prompt was submitted. Do **not** count
   occurrences ("skip the first, act on the second"): the echoed instruction may be line-wrapped by the
   composer, so the echo may never match as a whole line and occurrence-counting misfires. Most
   reliable, but depends on `claude` complying — hence the fallbacks.
2. **Quiescence**: complete after `quietMs` with no new output following at least one chunk. Unreliable
   in **both** directions — thinking/tool pauses can trip it early, and spinner/status-line animations
   redraw continuously so the stream may never go quiet; treat as a tunable fallback only.
3. **Hard timeout** (`maxMs`): absolute cap → return what was captured with `truncated: true`.

**Answer extraction** — read the emulator buffer (viewport + scrollback) for the region rendered *after*
the submitted prompt, minus the trailing input-composer box / status line. Bound the region using the
sentinel (if used) or by locating the echoed prompt text. Best-effort; **document as heuristic**.

**Side effects (by design):** the prompt enters B's real session and history and is visible in B's tab —
that shared context is the point of D1.

### 8.4 Container injection — `buildDockerRunCommand` (`ContainerManager.ts:152-202`)
When the profile **participates**, append (before `parts.push(c.image)`, reusing the existing arg-append
path next to the `-e`/`extraArgs` loops at `:191-197`):
```
-v <busDir>:/run/devenv-bus
-e DEVENV_BUS_SOCK=/run/devenv-bus/bus.sock
-e DEVENV_BUS_TOKEN=<promptBusManager.issueToken(profile.id)>
```
Mount the **directory**, not the socket file: a file bind-mount pins the inode, so the socket the app
re-creates on its next start would be a dead file inside already-running containers. With the dir
mount (plus persisted tokens, §8.2) containers keep working across app restarts.

**Quoting hazard:** `buildDockerRunCommand` joins parts with plain spaces and no shell quoting
(`ContainerManager.ts:201`), so every injected value must be shell-safe — `busDir` is space-free by
construction (§8.2) and the token is hex. The formerly proposed `-e DEVENV_SELF_PROFILE=<profile.name>`
is **dropped**: profile names are free text (spaces would break the command) and it was informational
only — the token is the identity anchor.

**Redact the token in logs:** `ContainerManager.run` logs the full docker run command to the EventLog
(`ContainerManager.ts:146`), which is forwarded to the renderer UI — scrub before logging
(`cmd.replace(/(DEVENV_BUS_TOKEN=)\S+/, '$1<redacted>')`). Inside the container the token is visible to
all processes by design (the container is the principal); `docker inspect` exposure is equivalent to
docker-socket access, i.e. root.

**Recreate to apply:** the mount + env are fixed at `docker run` time. Enabling the bus (or changing
participation) for an existing container takes effect on container **recreate** — surface this in the
UI. Disabling is effective immediately for authorization (§6 is checked live on every `/ask`); the
stale mount merely lets the container reach the socket and receive `403`.

`ContainerManager` needs a reference to `PromptBusManager` (inject it, or pass a getter for
`busDir`/`issueToken`).

**Local profiles only (MVP).** The bind-mount requires the container on the app's host, i.e.
`profile.local === true` (`buildDockerRunCommand` runs via `localExec`, `ContainerManager.ts:25`). The
bus directory and socket exist before `docker run` (created in `start()`), and the socket's mode is
`0666` so the container's uid can connect — exposure is controlled by *which* containers get the mount plus the per-profile token, not
by the socket's file mode. Remote/SSH profiles need `ssh -R` socket forwarding (§13) and are out of MVP
scope. Both roles work locally: a local profile is a valid **source** (gets the mount + shim) and a valid
**target** (receiver only writes to / taps its live PTY, which is transport-agnostic).

### 8.5 `devenv-ask` CLI shim
A tiny POSIX `sh` script (requires `curl` + `jq` in the image):
```sh
#!/bin/sh
# usage: devenv-ask "<target-profile-name>" "<prompt>"
curl -s --unix-socket "$DEVENV_BUS_SOCK" \
     -H "Authorization: Bearer $DEVENV_BUS_TOKEN" \
     -H 'Content-Type: application/json' \
     -d "$(jq -nc --arg p "$1" --arg q "$2" '{profile:$p, prompt:$q}')" \
     http://bus/ask | jq -r '.result'
```
Delivered **without an image rebuild**: after container start (and only when the profile participates),
install via a plain command string — `ContainerManager.exec` uses promisified `child_process.exec`
(`ContainerManager.ts:17-22`), so there is **no stdin to pipe a script through**. Embed it
base64-encoded instead:
`docker exec <name> sh -c 'printf %s <base64> | base64 -d > /usr/local/bin/devenv-ask && chmod +x /usr/local/bin/devenv-ask'`.
Hook into the `connection:launch` path (`ipcHandlers.ts:114-175`; the natural point is after the final
status check at `:172`). **Neither `curl` nor `jq` is guaranteed** in target images — probe at install
time and fall back to a `node -e`/`python3` variant covering the whole request (transport + JSON), not
just the JSON encoding; document that at least one of curl/node/python3 must exist in the image.

### 8.6 Wiring
- **`src/main/index.ts`** (managers init `:12-16`, `createWindow`/`setupIpcHandlers` `:93-101`, quit
  `:120-140`): instantiate `PromptBusManager(profileManager, terminalManager)`, `await start()` after
  `app.whenReady()`, pass into `setupIpcHandlers`, and `stop()`/unlink on `window-all-closed`.
- **`src/main/managers/ProfileManager.ts`**: `updateProject` accepts `busEnabled`. This is a
  **three-layer** widening — the update payload is currently typed `{ name: string }` at
  `ProfileManager.ts:189`, `ipcHandlers.ts:84`, and `preload/index.ts:50-51`; widen all three (e.g. to
  `Partial<Pick<Project, 'name' | 'busEnabled'>>`).
- **`src/main/managers/TerminalManager.ts`**: add `attachCapture()` and
  `getActiveTerminalForProfile()`.
- **`src/main/managers/ContainerManager.ts`**: `buildDockerRunCommand` injection (§8.4); optionally a
  helper to install the shim.
- **`src/main/ipcHandlers.ts`**: extend `project:update` (`:84`) for `busEnabled`; add `bus:info` →
  `getInfo()`, `bus:getToken` (profileId) for the UI reveal, and `bus:runPrompt` (profileId, prompt) as
  an in-app test button that drives the inject+capture cycle. Extend `SetupOptions` (`:11-19`) with
  `promptBusManager`. Install the shim in the `connection:launch` handler.
- **`src/preload/index.ts`** (api object ~`:14-220`): add `getBusInfo()`, `getBusToken(profileId)`,
  `runPrompt(profileId, prompt)`; add `busEnabled` to the project-update wrapper.
- **UI:**
  - *Sidebar project header* (`Sidebar.tsx`, project section ~`:119-382`): a toggle/icon **"Enable
    Profile Bus"** per Project → `updateProject(id, { busEnabled })`.
  - *ProfileEditor "Profile Bus" section* (`ProfileEditor.tsx`; follow the checkbox pattern at
    ~`:719-728`, e.g. the "interactive/TTY" or `autoConnectOnStart` `:763-766` controls): read-only
    **status** ("Enabled via project 'Backend'" / "No project — bus unavailable" / "Project bus off"),
    a **"Participate"** checkbox (default on), `quietMs`/`maxMs`/`useEndMarker` inputs, and a
    reveal-on-click **token**/socket display. Update `emptyDraft()`/`profileToDraft()` (`:19-74`) to
    carry `bus`. Note: the draft functions do **not** carry `projectId` (key absent — spread-safe on
    save), so read project membership for the status line from the profile/store, not the draft.

### 8.7 New dependency
`@xterm/headless` (aligns with the renderer's existing `@xterm/xterm` ^6) for de-rendering the captured
stream in the main process. **Zero-dep fallback**: ANSI-strip + dedupe heuristics (lower quality) if we
choose to avoid the dependency — decide in §10.

## 9. Security
- **No network port** — served on a Unix socket, reachable only by containers that received the
  bind-mount. Socket lives in a dedicated space-free runtime dir (§8.2); mode `0666` but exposure
  controlled by the selective mount + token; unlinked on quit.
- **Per-profile bearer token** = the caller-identity anchor (`crypto.randomBytes`, persisted in
  `electron-store` at profile-config trust level, looked up by `sha256(token)`). **Redacted from the
  EventLog** docker-run line (§8.4 — `ContainerManager.ts:146` logs the full command to the UI
  otherwise). Visible inside the container and via `docker inspect` by design — both are
  container-principal / root-equivalent surfaces.
- **Project-scoped authorization** enforced server-side on every `/ask`. Cross-project and orphaned
  profiles are denied.
- **No arbitrary command execution on the receiver** — only keystrokes into an existing `claude` PTY
  (per precondition). Single-flight per target prevents request interleaving.
- **Prompt size cap** to bound memory/latency.

## 10. Open questions / defaults to confirm
Defaults chosen during design; confirm or override before/at implementation:
1. **`@xterm/headless` dependency** vs zero-dep ANSI-strip fallback. *Default: add `@xterm/headless`* (much
   better extraction quality).
2. **`participate` semantics** — opt-*out* (default on within an enabled project) vs opt-*in*. *Default:
   opt-out.*
3. **End-marker on by default** (slightly modifies prompt/answer). *Default: on*, with quiescence + hard
   timeout as fallbacks.
4. **Target terminal** when a profile has several — active/most-recent vs a user-designated "bus
   terminal". *Default: active/most-recent (single-terminal MVP).*
5. **Timing defaults**: `quietMs ≈ 4000`, `maxMs ≈ 120000`, prompt cap ≈ 32 KB. Tune during testing.
6. **`curl`/`jq` availability** in target images for the shim (§8.5) — probe at install time; fall back
   to a node/python variant for the whole shim.

## 11. Implementation checklist (ordered)
1. Types (§8.1) — `Project.busEnabled`, `ProfileBusConfig`, `bus?` on `Profile`, `PromptResult`,
   `BusInfo`.
2. `PromptBusManager` (§8.2) — server on UDS (space-free `busDir`), persisted token store, `/ask`
   auth+authorize skeleton returning a stub.
3. `TerminalManager.attachCapture()` + `getActiveTerminalForProfile()` (§8.3).
4. Inject+capture cycle (§8.3) incl. `@xterm/headless` de-render + completion detection.
5. `buildDockerRunCommand` injection + EventLog token redaction (§8.4) + `ContainerManager` ←
   `PromptBusManager` reference.
6. `devenv-ask` shim + post-launch install (§8.5).
7. Wiring: `index.ts`, `ProfileManager.updateProject`, IPC handlers, preload (§8.6).
8. UI: Sidebar project toggle + ProfileEditor "Profile Bus" section (§8.6).
9. Verify (§12); iterate on timing/extraction defaults (§10).

## 12. Verification (project-scoped, two+ local profiles)
1. Project **Backend** = Profiles A, B with `busEnabled`; Project **Frontend** = Profile C. Launch A, B,
   C (local); open a live `claude` in B and C.
2. Confirm A's/B's `docker run` (visible in the EventLog) carries the `-v …/devenv-bus` dir mount +
   `DEVENV_BUS_*` with the **token redacted** in the log line; `ls -l /run/devenv-bus/bus.sock` exists
   in-container.
3. Happy path: from A, `devenv-ask "B" "print exactly: 42"` → returns `42`, **visibly answered in B's tab**.
4. **Cross-project denied:** from A, `devenv-ask "C" …` → `403`. Disable Backend's `busEnabled` → A→B →
   `403`. An orphaned profile (no project) → its container gets **no** bus injection.
5. Completion paths: end-marker (default) returns promptly & precisely; disable it → quiescence works;
   force a long answer → `maxMs` truncates with `truncated: true`.
6. Multi-line prompt round-trips (bracketed paste — no premature submit). Concurrent asks to B → the
   second queues (single-flight).
7. Negatives: bad/unknown token → `401`; B with no live terminal → clear error; oversized prompt →
   rejected.
8. Confirm **no TCP port** was opened (`ss -ltnp` shows nothing new) — access is socket-only.
9. Restart the app while A's and B's containers keep running → A→B still works (dir mount + persisted
   tokens; no container relaunch needed).

## 13. Future work
- **Remote / SSH profiles:** SSH remote-socket forwarding (`ssh -R /remote.sock:/local.sock …`) added in
  `ConnectionManager.buildSSHArgs` (`ConnectionManager.ts:186-225`) + remote-side env injection —
  extends the same socket model to remote containers.
- **MCP `ask_profile` tool:** ship an MCP stdio server + `.mcp.json` into the container; a thin client of
  the same `/ask` endpoint (no Bash approval needed — most ergonomic for `claude`).
- **Finer auth within a project** (per-pair allow-list) if project scope proves too broad.
- **Headless `--resume <B_session_id>` capture mode:** an alternative that keeps B's context but runs a
  separate headless `claude -p --resume` process for **clean** capture (does not touch the live tab).
  Useful if live-TUI scraping proves too noisy. See §15 for the CLI reference.
- Streaming responses back to the caller; multi-terminal target selection; per-request cancellation.
- **Shell-quote `buildDockerRunCommand` args** generally (`ContainerManager.ts:201` joins unquoted) —
  broader hardening beyond the bus's own space-free values (e.g. user workspace paths with spaces).

---

## 14. Appendix A — Codebase orientation (as of current HEAD)

Line numbers are approximate; verify against the tree when implementing.

**Process layout**
- Main entry: `src/main/index.ts` — instantiates managers (`:12-16`), creates windows, calls
  `setupIpcHandlers` (`:93-101`), app lifecycle incl. on-close container stop/pause (`:120-140`).
- IPC: `src/main/ipcHandlers.ts` — `setupIpcHandlers(opts)`; `SetupOptions` (`:11-19`). All `ipcMain.handle`
  channels live here.
- Preload bridge: `src/preload/index.ts` — `contextBridge.exposeInMainWorld('api', api)`; add new methods
  to the `api` object.
- Renderer: React + Zustand (`src/renderer/src/store/useAppStore.ts`); `App.tsx`,
  `components/Sidebar.tsx`, `components/ProfileCard.tsx`, `components/ProfileEditor.tsx`,
  `components/TerminalView.tsx`. `main.tsx` renders either the full app or a single detached terminal
  (`?detached=<id>`).
- Shared types: `src/shared/types.ts`.

**Managers (`src/main/managers/`)**
- `ProfileManager.ts` — profile/project CRUD via `electron-store`. `getById`, `getAll`, `create`,
  `update`, `delete`, `clone`, import/export; projects: `getProjects`, `createProject`, `updateProject`,
  `deleteProject`, `moveProfileToProject`.
- `ConnectionManager.ts` — SSH tunnels/port-forwards per `profile.id`; `buildSSHArgs` (`:186-225`);
  auto-reconnect.
- `TerminalManager.ts` (extends `EventEmitter`) — `createTerminal` (`:30-111`), `buildCommand`
  (`:113-217`, local shell / `docker exec|attach` / `ssh … docker exec|attach`), `write` (`:291-293`),
  `resize`, `destroy`, `getSessions`, `getSession`, `setTargetWindow`. PTY data fan-out at `:90-93`
  (`ptyProcess.onData → safeSend('terminal:data', …)`); exit at `:95-107`. Emits `profileTerminalsEmpty`.
- `ContainerManager.ts` — `exec(profile, cmd)` → `localExec` (`:17-22`, local `docker …`) or `sshExec`
  (`:29-47`, `ssh <opts> host "<cmd>"`; JSON-stringifies the remote command). `execAsync` timeout is
  hardcoded `{ timeout: 30000 }` at `:19,44` — thread a param if longer runs are needed. Lifecycle:
  `getStatus`, `start`, `stop`, `pause`, `unpause`, `restart`, `remove`, `recreate`, `run`;
  `buildDockerRunCommand` (`:152-202`, `-e` env loop `:191-193`, `extraArgs` `:195-197`, image `:199`);
  `detectImagePorts`, `getLogs`.
- `EventLogManager.ts` — structured logging; emits `log`, forwarded to the renderer.

**Key existing IPC channels** (all `ipcMain.handle`): `profile:*` (list/create/update/delete/clone/
export/import/moveToProject), `project:*` (list/create/update/delete — update at `:84`), `connection:*`
(launch `:114-175`, connect, disconnect, state, allStates), `terminal:*` (create `:196-203`, destroy,
input `:209-211`, resize, sessions, detach, attach), `container:*` (status/start/stop/restart/remove/
recreate/pause/unpause/logs/detectPorts), `log:*`, `dialog:*`, `fs:writeText`, `shell:openExternal`,
`app:getVersion`. Renderer events via `webContents.send`: `terminal:data`, `terminal:exited`,
`terminal:detached`, `terminal:attached`, `connection:stateChanged`, `container:stateChanged`,
`log:entry`.

**Relevant types (`src/shared/types.ts`)**: `Profile` (`:79-92`), `ContainerConfig` (`:32-44`, incl.
`env`, `extraArgs`, `shell`, `workdir`, `workspaceMount`), `Project` (`:70-75`), `TerminalSession`
(`:140-147`, has `profileId`, `context`, `active`), `ConnectionPolicy` (`:52-61`).

**Data flow recap:** renderer calls `window.api.*` → preload `ipcRenderer.invoke` → `ipcMain.handle` →
manager. PTY output: `pty.onData` → `webContents.send('terminal:data')` → renderer xterm (no
main-process buffer — this is *why* the receiver needs `attachCapture` + a headless emulator).

## 15. Appendix B — Claude Code headless reference (for the §13 `--resume` capture mode)
Not used by the MVP (D1 uses the live session), but needed if the headless capture-mode alternative is
built. Verified against docs.claude.com:
- `claude -p "<prompt>"` / `--print` — non-interactive; prints result then exits. Accepts stdin (10 MB cap).
- `--output-format json` → `{ result, session_id, total_cost_usd, usage, … }`; also `stream-json`.
- Session continuity: `-c`/`--continue` (most recent), `--resume <id>` (specific; scoped to the working
  directory). Capture `session_id` from the first JSON response to resume later.
- Unattended permissions: `--allowedTools "Read,Bash(npm run *)"` or `--permission-mode <mode>`; avoid
  `--dangerously-skip-permissions` unless in a disposable, isolated container.
- Working dir determines the project/session scope; `--add-dir` grants extra directories.

## 16. Appendix C — Build / run / test environment
From `CLAUDE.md` (ARM64 Linux container; Node not pre-installed):
- Scripts: `npm run dev` (hot-reload), `npm run build` (JS bundle → `out/`), `npm run dist` (x64 AppImage,
  cross-compiled). **`npm run build` is the real gate** — `typecheck`/`lint` are known-broken independent
  of this feature.
- After `npm install`: fix the Electron sandbox binary (`chown root:root` + `chmod 4755`
  `node_modules/electron/dist/chrome-sandbox`) and `node_modules/.bin/electron-rebuild -f -w node-pty`.
- `npm run dist:build` rebuilds node-pty for **x64**; re-run `npm run rebuild` to restore arm64 for dev.
- Launch a built AppImage in a container with `--no-sandbox`.
- Testing the bus needs Docker available to the app host and at least two local profiles in one
  bus-enabled Project, each able to run `claude` in its container.
```
