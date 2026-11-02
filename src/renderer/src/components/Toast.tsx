import React from 'react'
import { create } from 'zustand'

interface ToastEntry {
  id: number
  message: string
  type: 'error' | 'info'
}

interface ToastStore {
  toasts: ToastEntry[]
  show: (message: string, type?: 'error' | 'info') => void
  dismiss: (id: number) => void
  dismissAll: () => void
}

let nextId = 1

/** Notices disappear after this long; errors stay until they are closed. */
const INFO_TIMEOUT_MS = 5000

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  show: (message, type = 'error') => {
    // The same message twice (e.g. one failure per terminal) is shown once
    if (get().toasts.some((t) => t.message === message && t.type === type)) return
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }))
    if (type === 'info') {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, INFO_TIMEOUT_MS)
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dismissAll: () => set({ toasts: [] })
}))

export function toast(message: string, type: 'error' | 'info' = 'error'): void {
  useToastStore.getState().show(message, type)
}

export function ToastContainer(): React.ReactElement {
  const { toasts, dismiss, dismissAll } = useToastStore()
  const errorCount = toasts.filter((t) => t.type === 'error').length

  return (
    <div className="toast-container">
      {errorCount > 1 && (
        <button className="toast-dismiss-all" onClick={dismissAll}>
          Dismiss all ({toasts.length})
        </button>
      )}
      {toasts.map((t) => (
        <div key={t.id} className={`toast-item toast-${t.type}`}>
          <div className="toast-body">
            <span className="toast-message">{t.message}</span>
            <button className="toast-close" onClick={() => dismiss(t.id)} title="Close">✕</button>
          </div>
          {/* Only notices count down; errors stay until closed */}
          {t.type === 'info' && <div className="toast-progress" />}
        </div>
      ))}
    </div>
  )
}
