import { useAppStore } from './store/useAppStore'
import type { PersistedSession, PersistedTerminal } from '../../shared/types'

type AppState = ReturnType<typeof useAppStore.getState>

// Titles change whenever a shell emits an OSC sequence, so saves are throttled
// rather than written on every keystroke-driven update. The beforeunload flush
// guarantees the final state lands regardless of where the timer sits.
const SAVE_DEBOUNCE_MS = 1000

function buildSnapshot(s: AppState): PersistedSession {
  const terminals: PersistedTerminal[] = s.terminals.map((t) => ({
    id: t.id,
    profileId: t.profileId,
    context: t.context,
    title: t.title,
    ...(s.detachedTerminalIds[t.id] ? { detached: true as const } : {}),
    ...(s.hiddenTerminalIds[t.id] ? { hidden: true as const } : {})
  }))

  // Split companions live in `splits`, never in `terminals`. Persist them as
  // ordinary terminals so they survive the restart as tabs — the split layout
  // itself is not restored, but no terminal silently disappears.
  for (const { session } of Object.values(s.splits)) {
    if (terminals.some((t) => t.id === session.id)) continue
    terminals.push({
      id: session.id,
      profileId: session.profileId,
      context: session.context,
      title: session.title
    })
  }

  return {
    terminals,
    activeTerminalId: s.activeTerminalId,
    activeProfileId: s.activeProfileId
  }
}

/**
 * Cheap fingerprint of everything the snapshot depends on. The store also emits
 * on unrelated churn — most notably every streamed log entry — so without this
 * gate a busy log would keep resetting the debounce timer and nothing would
 * ever be written.
 */
function signature(s: AppState): string {
  const parts: string[] = []
  for (const t of s.terminals) {
    const flags = `${s.detachedTerminalIds[t.id] ? 'd' : ''}${s.hiddenTerminalIds[t.id] ? 'h' : ''}`
    parts.push(`${t.id}|${t.context}|${t.title}|${flags}`)
  }
  for (const [primaryId, split] of Object.entries(s.splits)) {
    parts.push(`s:${primaryId}:${split.session.id}:${split.session.title}`)
  }
  parts.push(`@${s.activeTerminalId ?? ''}|${s.activeProfileId ?? ''}`)
  return parts.join('\n')
}

/**
 * Mirror the open workspace to the main process so it can be rebuilt next run.
 *
 * Main-window only: a detached window's store holds just the one terminal it
 * hosts, and letting it publish would overwrite the real workspace with a
 * single-entry snapshot.
 *
 * Returns a teardown function.
 */
export function startSessionPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSignature = signature(useAppStore.getState())

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    window.api.saveSession(buildSnapshot(useAppStore.getState()))
  }

  const unsubscribe = useAppStore.subscribe((state) => {
    const next = signature(state)
    if (next === lastSignature) return
    lastSignature = next
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS)
  })

  window.addEventListener('beforeunload', flush)

  return () => {
    unsubscribe()
    window.removeEventListener('beforeunload', flush)
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Rebuild the store from the previous run. The main process has already
 * registered a stub for each surviving terminal, so `terminal:sessions` is the
 * source of truth for *which* terminals exist; the persisted record supplies
 * the ordering and the detached/hidden flags the main process doesn't track.
 */
export async function hydrateFromLastSession(): Promise<number> {
  const [persisted, sessions] = await Promise.all([
    window.api.getRestoredSession(),
    window.api.getTerminalSessions()
  ])

  const byId = new Map(sessions.map((s) => [s.id, s]))
  // Persisted order drives tab order; anything the main process dropped (its
  // profile was deleted between runs) falls out here.
  const terminals = persisted.terminals
    .map((t) => byId.get(t.id))
    .filter((s): s is NonNullable<typeof s> => !!s)

  if (terminals.length === 0) return 0

  const detachedTerminalIds: Record<string, true> = {}
  const hiddenTerminalIds: Record<string, true> = {}
  for (const t of persisted.terminals) {
    if (!byId.has(t.id)) continue
    if (t.detached) detachedTerminalIds[t.id] = true
    if (t.hidden) hiddenTerminalIds[t.id] = true
  }

  const restoredIds = new Set(terminals.map((t) => t.id))
  const activeTerminalId =
    persisted.activeTerminalId && restoredIds.has(persisted.activeTerminalId)
      ? persisted.activeTerminalId
      : // The remembered tab may be gone, or have been detached into its own
        // window — fall back to the first tab still visible in the main window.
        terminals.find((t) => !detachedTerminalIds[t.id] && !hiddenTerminalIds[t.id])?.id ?? null

  const activeProfileId =
    terminals.find((t) => t.id === activeTerminalId)?.profileId ??
    persisted.activeProfileId

  useAppStore.getState().hydrateSession({
    terminals,
    detachedTerminalIds,
    hiddenTerminalIds,
    activeTerminalId,
    activeProfileId
  })

  return terminals.length
}
