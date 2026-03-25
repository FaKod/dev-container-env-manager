import React, { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { LogEntry } from '../../../shared/types'

export function LogViewer(): React.ReactElement {
  const { logs, activeProfileId, setLogs } = useAppStore()
  const [filterProfile, setFilterProfile] = useState(false)
  const [search, setSearch] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // Initial load
  useEffect(() => {
    window.api.getLogs().then(setLogs).catch(console.error)
  }, [])

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  const filtered = logs.filter((e) => {
    if (filterProfile && activeProfileId && e.profileId !== activeProfileId) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        e.message.toLowerCase().includes(q) ||
        e.source.toLowerCase().includes(q)
      )
    }
    return true
  })

  async function handleClear(): Promise<void> {
    await window.api.clearLogs(filterProfile ? (activeProfileId ?? undefined) : undefined)
    const updated = await window.api.getLogs()
    setLogs(updated)
  }

  function handleCopy(): void {
    const text = filtered
      .map(
        (e) =>
          `${e.timestamp} [${e.level.toUpperCase()}] ${e.source}: ${e.message}`
      )
      .join('\n')
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="log-viewer">
      <div className="log-viewer-header">
        <span>Event Log</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: 'var(--surface0)',
              border: 'none',
              borderRadius: 4,
              padding: '2px 6px',
              color: 'var(--text)',
              fontSize: 11,
              width: 100,
              outline: 'none'
            }}
          />
          <button
            className={`panel-toggle-btn ${filterProfile ? 'active' : ''}`}
            onClick={() => setFilterProfile((v) => !v)}
            title="Filter by active profile"
          >
            Profile
          </button>
          <button className="panel-toggle-btn" onClick={handleCopy} title="Copy logs">
            Copy
          </button>
          <button className="panel-toggle-btn" onClick={handleClear} title="Clear logs">
            Clear
          </button>
        </div>
      </div>

      <div className="log-entries">
        {filtered.map((entry) => (
          <LogLine key={entry.id} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function LogLine({ entry }: { entry: LogEntry }): React.ReactElement {
  const time = entry.timestamp.slice(11, 19) // HH:MM:SS
  return (
    <div className="log-entry">
      <span className="log-time">{time}</span>
      <span className={`log-level ${entry.level}`}>{entry.level.toUpperCase()}</span>
      <span className="log-source" title={entry.source}>
        {entry.source}
      </span>
      <span className="log-msg">{entry.message}</span>
    </div>
  )
}
