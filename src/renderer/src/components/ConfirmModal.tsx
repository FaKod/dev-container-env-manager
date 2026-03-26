import React, { useEffect } from 'react'
import { create } from 'zustand'

interface ConfirmState {
  open: boolean
  message: string
  onConfirm: () => void
  show: (message: string, onConfirm: () => void) => void
  close: () => void
}

const useConfirmStore = create<ConfirmState>((set) => ({
  open: false,
  message: '',
  onConfirm: () => {},
  show: (message, onConfirm) => set({ open: true, message, onConfirm }),
  close: () => set({ open: false })
}))

export function showConfirm(message: string, onConfirm: () => void): void {
  useConfirmStore.getState().show(message, onConfirm)
}

export function ConfirmModal(): React.ReactElement | null {
  const { open, message, onConfirm, close } = useConfirmStore()

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, close])

  if (!open) return null

  function handleConfirm(): void {
    close()
    onConfirm()
  }

  return (
    <div
      className="modal-overlay"
      onClick={close}
      style={{ zIndex: 10000 }}
    >
      <div
        className="modal"
        style={{ maxWidth: 400 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-body" style={{ padding: '24px' }}>
          <p style={{ fontSize: 14 }}>{message}</p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" autoFocus onClick={close}>Cancel</button>
          <button className="btn btn-danger btn-danger-pulse" onClick={handleConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  )
}
