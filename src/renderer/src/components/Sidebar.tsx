import React, { useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import { ProfileCard } from './ProfileCard'
import { toast } from './Toast'

export function Sidebar(): React.ReactElement {
  const { profiles, setProfiles, upsertProfile, openProfileEditor, theme, toggleTheme } = useAppStore()
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleNewProfile(): Promise<void> {
    openProfileEditor()
  }

  async function handleExportAll(): Promise<void> {
    try {
      const json = await window.api.exportAllProfiles()
      const path = await window.api.saveFileDialog('profiles.json')
      if (!path) return
      await window.api.writeTextFile(path, json)
      toast('Profiles exported successfully', 'info')
    } catch (err) {
      toast(`Export failed: ${err}`)
    }
  }

  async function handleImport(): Promise<void> {
    fileInputRef.current?.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    e.target.value = ''

    try {
      // Try importing as single profile or as {profiles:[...]} array
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed.profiles)) {
        for (const p of parsed.profiles) {
          const profile = await window.api.importProfile(JSON.stringify(p))
          upsertProfile(profile)
        }
      } else {
        const profile = await window.api.importProfile(text)
        upsertProfile(profile)
      }
    } catch (err) {
      toast(`Import failed: ${err}`)
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">D</div>
        <h1>DevEnv Manager</h1>
      </div>

      <div className="sidebar-actions">
        <button className="btn btn-primary btn-sm btn-full" onClick={handleNewProfile}>
          + New Profile
        </button>
      </div>

      <div className="profile-list">
        {profiles.length === 0 && (
          <div className="empty-state" style={{ paddingTop: 40 }}>
            <p>No profiles yet.</p>
            <p>Create one to get started.</p>
          </div>
        )}
        {profiles.map((p) => (
          <ProfileCard key={p.id} profile={p} />
        ))}
      </div>

      <div className="sidebar-footer">
        <button
          className="btn btn-ghost btn-sm"
          style={{ flex: 1 }}
          onClick={handleImport}
          title="Import profile(s) from JSON file"
        >
          Import
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ flex: 1 }}
          onClick={handleExportAll}
          title="Export all profiles"
        >
          Export All
        </button>
        <button
          className="btn btn-icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </aside>
  )
}
