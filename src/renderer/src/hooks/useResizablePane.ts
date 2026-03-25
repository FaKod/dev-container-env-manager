import { useState, useCallback, MouseEvent } from 'react'

export function useResizablePane(
  initial: number,
  min: number,
  max: number,
  direction: 'horizontal' | 'vertical',
  reverse = false
): { size: number; handleMouseDown: (e: MouseEvent) => void } {
  const [size, setSize] = useState(initial)

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      const startSize = size

      const onMouseMove = (ev: globalThis.MouseEvent): void => {
        if (direction === 'horizontal') {
          const delta = ev.clientX - startX
          setSize(Math.min(max, Math.max(min, startSize + (reverse ? -delta : delta))))
        } else {
          const delta = startY - ev.clientY
          setSize(Math.min(max, Math.max(min, startSize + delta)))
        }
      }

      const onMouseUp = (): void => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [size, min, max, direction]
  )

  return { size, handleMouseDown }
}
