import { app } from 'electron'
import { mkdirSync } from 'fs'
import { resolve } from 'path'

/**
 * Optional alternative config folder, so a second instance (e.g. a test build)
 * can run next to the one you work in without sharing profiles or the saved
 * terminal session:
 *
 *   --config-dir=<path>   or   --config-dir <path>   or   DEVENV_CONFIG_DIR=<path>
 *
 * The folder replaces Electron's userData directory, which holds the
 * electron-store files (profiles.json, session.json) and Chromium's own data.
 * Must run before any manager creates its store, i.e. before app 'ready'.
 * Returns the folder in use when overridden, otherwise undefined.
 */
export function applyConfigDirOverride(argv: string[] = process.argv): string | undefined {
  let dir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--config-dir=')) dir = arg.slice('--config-dir='.length)
    else if (arg === '--config-dir' && argv[i + 1]) dir = argv[i + 1]
  }
  dir = dir || process.env.DEVENV_CONFIG_DIR
  if (!dir) return undefined

  const abs = resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
  mkdirSync(abs, { recursive: true })
  app.setPath('userData', abs)
  return abs
}
