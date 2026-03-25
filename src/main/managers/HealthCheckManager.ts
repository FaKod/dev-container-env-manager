import { EventEmitter } from 'events'
import * as http from 'http'
import * as https from 'https'
import type { BrowserWindow } from 'electron'
import type { Profile, ServiceHealth } from '../../shared/types'
import type { EventLogManager } from './EventLogManager'

interface CheckEntry {
  profileId: string
  url: string
  interval: ReturnType<typeof setInterval>
  lastState: ServiceHealth
  mainWindow: BrowserWindow
  pending: boolean
}

const DEFAULT_INTERVAL_MS = 15_000
const TIMEOUT_MS = 5_000

export class HealthCheckManager extends EventEmitter {
  private checks = new Map<string, CheckEntry[]>()
  private logger: EventLogManager

  constructor(logger: EventLogManager) {
    super()
    this.logger = logger
  }

  startChecks(profile: Profile, mainWindow: BrowserWindow): void {
    this.stopChecks(profile.id)

    const urls = profile.service?.urls ?? []
    if (urls.length === 0) return

    const entries: CheckEntry[] = []

    for (const url of urls) {
      const initial: ServiceHealth = { url, healthy: false }
      const entry: CheckEntry = {
        profileId: profile.id,
        url,
        mainWindow,
        lastState: initial,
        pending: false,
        interval: setInterval(() => this.check(entry), DEFAULT_INTERVAL_MS)
      }
      entries.push(entry)
      // Run immediately
      this.check(entry)
    }

    this.checks.set(profile.id, entries)
  }

  stopChecks(profileId: string): void {
    const entries = this.checks.get(profileId) ?? []
    for (const e of entries) clearInterval(e.interval)
    this.checks.delete(profileId)
  }

  stopAll(): void {
    for (const profileId of this.checks.keys()) {
      this.stopChecks(profileId)
    }
  }

  getHealth(profileId: string): ServiceHealth[] {
    return (this.checks.get(profileId) ?? []).map((e) => e.lastState)
  }

  private async check(entry: CheckEntry): Promise<void> {
    if (entry.pending) return
    entry.pending = true
    const result = await this.ping(entry.url)
    entry.pending = false
    const changed =
      result.healthy !== entry.lastState.healthy ||
      result.statusCode !== entry.lastState.statusCode

    entry.lastState = result

    if (changed) {
      this.logger.debug(
        'HealthCheckManager',
        `${entry.url} → ${result.healthy ? 'UP' : 'DOWN'} (${result.statusCode ?? result.error})`,
        entry.profileId
      )
      try {
        if (!entry.mainWindow.isDestroyed()) {
          entry.mainWindow.webContents.send('service:healthChanged', entry.profileId, result)
        }
      } catch { /* window destroyed between check and send */ }
    }
  }

  private ping(url: string): Promise<ServiceHealth> {
    return new Promise((resolve) => {
      const now = new Date().toISOString()
      const lib = url.startsWith('https') ? https : http

      const req = lib.get(url, { timeout: TIMEOUT_MS }, (res) => {
        res.resume() // drain the body
        const healthy = (res.statusCode ?? 0) < 500
        resolve({
          url,
          healthy,
          statusCode: res.statusCode,
          lastChecked: now
        })
      })

      req.on('error', (err) => {
        resolve({ url, healthy: false, error: err.message, lastChecked: now })
      })

      req.on('timeout', () => {
        req.destroy()
        resolve({ url, healthy: false, error: 'timeout', lastChecked: now })
      })
    })
  }
}
