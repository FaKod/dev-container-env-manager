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
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast-item toast-${t.type}`}>
          <div className="toast-body">
            <span className="toast-message">{t.message}</span>
            <button className="toast-close" onClick={() => dismiss(t.id)}>✕</button>
          </div>
          <div className="toast-progress" />
        </div>
      ))}
    </div>
  )
}
