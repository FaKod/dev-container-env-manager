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
}

let nextId = 1

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (message, type = 'error') => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 5000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

export function toast(message: string, type: 'error' | 'info' = 'error'): void {
  useToastStore.getState().show(message, type)
}

export function ToastContainer(): React.ReactElement {
  const { toasts, dismiss } = useToastStore()

  return (
    <div style={{
      position: 'fixed',
      bottom: 20,
      right: 20,
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      pointerEvents: 'none'
    }}>
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  )
}

function ToastItem({ entry, onDismiss }: { entry: ToastEntry; onDismiss: () => void }): React.ReactElement {
  const bg = entry.type === 'error' ? 'var(--red)' : 'var(--blue)'

  return (
    <div style={{
      pointerEvents: 'all',
      background: bg,
      color: 'var(--mantle)',
      padding: '8px 12px',
      borderRadius: 8,
      fontSize: 12,
      fontWeight: 500,
      maxWidth: 360,
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      animation: 'fadeInUp 0.15s ease'
    }}>
      <span style={{ flex: 1, wordBreak: 'break-word' }}>{entry.message}</span>
      <button
        onClick={onDismiss}
        style={{
          background: 'none',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          opacity: 0.7,
          fontSize: 14,
          padding: 0,
          lineHeight: 1,
          flexShrink: 0
        }}
      >
        ✕
      </button>
    </div>
  )
}
