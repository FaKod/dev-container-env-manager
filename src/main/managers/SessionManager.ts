import Store from 'electron-store'
import type { PersistedSession, PersistedTerminal, WindowBounds } from '../../shared/types'

interface StoreSchema {
  session: PersistedSession
}

const EMPTY: PersistedSession = {
  terminals: [],
  activeTerminalId: null,
  activeProfileId: null
}

/** Supplies the live frame of the detached window hosting a terminal, if any. */
type BoundsProvider = (terminalId: string) => WindowBounds | undefined

/**
 * Remembers which terminals were open when the app last quit so they can be
 * rebuilt on the next start.
 *
 * Only the *shape* of the workspace is stored — profile, context, title, tab
 * order, and which terminals lived in their own window. PTYs cannot outlive the
 * process, so a restored terminal comes back as a stub the user reconnects on
 * demand (see TerminalManager.restoreStub / activateStub).
 *
 * The renderer owns tab order / active / hidden state and pushes a snapshot on
 * every change; the main process owns detached-window bounds and stamps them in
 * at write time, so the frames saved are always the current ones.
 */
export class SessionManager {
  private store: Store<StoreSchema>
  /** The session loaded at startup — served to renderers, never overwritten. */
  private restored: PersistedSession
  private snapshot: PersistedSession
  private boundsProvider: BoundsProvider | null = null
  /**
   * Last frame seen for each detached window, kept because windows are already
   * destroyed by the time the final save runs on quit — reading them live then
   * is impossible, so the most recent move/resize is what gets written.
   */
  private lastBounds = new Map<string, WindowBounds>()

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'session',
      defaults: { session: EMPTY }
    })
    this.restored = this.sanitize(this.store.get('session', EMPTY))
    // Until the renderer pushes its first snapshot, the best description of the
    // workspace is the one we just restored. Without this a crash between
    // startup and first push would wipe the saved session.
    this.snapshot = this.restored
    // Carry frames forward across the restart: a window nobody touches this run
    // should still come back where the user last left it.
    for (const t of this.restored.terminals) {
      if (t.bounds) this.lastBounds.set(t.id, t.bounds)
    }
  }

  /** Record a detached window's frame as it moves or resizes. */
  rememberBounds(terminalId: string, bounds: WindowBounds): void {
    this.lastBounds.set(terminalId, bounds)
  }

  /** The workspace as it was when the app last quit. */
  getRestored(): PersistedSession {
    return this.restored
  }

  setBoundsProvider(provider: BoundsProvider): void {
    this.boundsProvider = provider
  }

  /** Accept a snapshot from the renderer and write it through to disk. */
  save(snapshot: PersistedSession): void {
    this.snapshot = this.sanitize(snapshot)
    this.persist()
  }

  /**
   * Re-write the current snapshot with freshly read window bounds. Called on
   * quit so a window moved after the last renderer push is still saved where
   * the user left it.
   */
  flush(): void {
    this.persist()
  }

  private persist(): void {
    const terminals = this.snapshot.terminals.map((t) => {
      // Prefer the live window, fall back to its last seen frame (quit path),
      // then to whatever the snapshot already carried. A terminal re-attached to
      // the main window keeps its frame too: if it gets detached again, coming
      // back where it was beats dropping to the default position.
      const bounds = this.boundsProvider?.(t.id) ?? this.lastBounds.get(t.id) ?? t.bounds
      return bounds ? { ...t, bounds } : t
    })
    this.store.set('session', { ...this.snapshot, terminals })
  }

  /**
   * Guard against a malformed or hand-edited store file — a bad entry here
   * would otherwise throw during startup, before any window exists to show it.
   */
  private sanitize(session: PersistedSession | undefined): PersistedSession {
    if (!session || typeof session !== 'object') return EMPTY
    const raw = Array.isArray(session.terminals) ? session.terminals : []
    const terminals = raw.filter(
      (t): t is PersistedTerminal =>
        !!t &&
        typeof t.id === 'string' &&
        typeof t.profileId === 'string' &&
        (t.context === 'local' || t.context === 'ssh' || t.context === 'container')
    )
    return {
      terminals,
      activeTerminalId:
        typeof session.activeTerminalId === 'string' ? session.activeTerminalId : null,
      activeProfileId:
        typeof session.activeProfileId === 'string' ? session.activeProfileId : null
    }
  }
}
