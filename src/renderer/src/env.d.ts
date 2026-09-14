/// <reference types="vite/client" />

import type { Api } from '../../preload'

declare global {
  interface Window {
    /**
     * The contextBridge API exposed by the preload script. Typed from the
     * preload's own `api` object, so adding a method there makes it visible
     * here — and removing one breaks the renderer at compile time instead of
     * at runtime.
     */
    api: Api
  }
}
