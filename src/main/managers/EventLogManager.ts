import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { LogEntry, LogLevel } from '../../shared/types'

const MAX_LOG_ENTRIES = 2000

export class EventLogManager extends EventEmitter {
  private logs: LogEntry[] = []

  log(
    level: LogLevel,
    source: string,
    message: string,
    profileId?: string,
    details?: unknown
  ): LogEntry {
    const entry: LogEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      profileId,
      details
    }

    this.logs.push(entry)
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES)
    }

    this.emit('log', entry)
    return entry
  }

  info(source: string, message: string, profileId?: string, details?: unknown): LogEntry {
    return this.log('info', source, message, profileId, details)
  }

  warn(source: string, message: string, profileId?: string, details?: unknown): LogEntry {
    return this.log('warn', source, message, profileId, details)
  }

  error(source: string, message: string, profileId?: string, details?: unknown): LogEntry {
    return this.log('error', source, message, profileId, details)
  }

  debug(source: string, message: string, profileId?: string, details?: unknown): LogEntry {
    return this.log('debug', source, message, profileId, details)
  }

  getLogs(profileId?: string): LogEntry[] {
    if (profileId) {
      return this.logs.filter((e) => e.profileId === profileId)
    }
    return [...this.logs]
  }

  clear(profileId?: string): void {
    if (profileId) {
      this.logs = this.logs.filter((e) => e.profileId !== profileId)
    } else {
      this.logs = []
    }
  }
}
