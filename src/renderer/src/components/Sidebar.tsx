import React, { useRef, useState, useEffect } from 'react'
import { Terminal, Plus, Upload, Download, Sun, Moon, ChevronDown, Pencil, X, FolderPlus } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { ProfileCard } from './ProfileCard'
import { toast } from './Toast'
import { showConfirm } from './ConfirmModal'
import type { Project, Profile } from '../../../shared/types'

// ── ProjectSection ─────────────────────────────────────────────────────────────

interface ProjectSectionProps {
  id: string
  label: string
  profiles: Profile[]
  isOrphaned?: boolean
  collapsed: boolean
  dragOver: boolean
  editing: boolean
  editName: string
  onToggle: () => void
  onEditStart: () => void
  onEditChange: (name: string) => void
  onEditConfirm: () => void
  onEditCancel: () => void
  onDelete: () => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

function ProjectSection({
  id,
  label,
  profiles,
  isOrphaned = false,
  collapsed,
  dragOver,
  editing,
  editName,
  onToggle,
  onEditStart,
  onEditChange,
  onEditConfirm,
  onEditCancel,
  onDelete,
  onDragOver,
  onDragLeave,
  onDrop
}: ProjectSectionProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  return (
    <div
      className={`project-section${isOrphaned ? ' orphaned' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={`project-header${dragOver ? ' drag-over' : ''}`}
        onClick={editing ? undefined : onToggle}
      >
        <ChevronDown
          size={11}
          className={`project-chevron ${collapsed ? 'closed' : 'open'}`}
        />

        {editing ? (
          <input
            ref={inputRef}
            className="project-title-input"
            value={editName}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onEditConfirm() }
              else if (e.key === 'Escape') { e.preventDefault(); onEditCancel() }
            }}
            onBlur={onEditConfirm}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span className="project-title">{label}</span>
        )}

        <span className="project-count">{profiles.length}</span>

        {!isOrphaned && !editing && (
          <div className="project-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-icon" title="Rename project" onClick={onEditStart} style={{ padding: '1px 3px' }}>
              <Pencil size={10} />
            </button>
            <button className="btn btn-icon" title="Delete project" onClick={onDelete} style={{ padding: '1px 3px' }}>
              <X size={10} />
            </button>
          </div>
        )}
      </div>

      <div className={`project-profiles${collapsed ? ' hidden' : ''}`}>
        {profiles.map((p) => (
          <ProfileCard key={p.id} profile={p} />
        ))}
        {profiles.length === 0 && !collapsed && (
          <div className="project-empty">Drop a profile here</div>
        )}
      </div>
    </div>
  )
}

// ── Sidebar ────────────────────────────────────────────────────────────────────

export function Sidebar(): React.ReactElement {
  const {
    profiles, setProfiles, upsertProfile,
    projects, upsertProject, removeProject,
    openProfileEditor, theme, toggleTheme
  } = useAppStore()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  // Group profiles by project
  const validProjectIds = new Set(projects.map((p) => p.id))
  const grouped: Record<string, Profile[]> = {}
  for (const p of profiles) {
    const key = p.projectId && validProjectIds.has(p.projectId) ? p.projectId : 'orphaned'
    ;(grouped[key] ??= []).push(p)
  }

  function toggleCollapse(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startEdit(project: Project): void {
    setEditingId(project.id)
    setEditName(project.name)
  }

  async function confirmEdit(): Promise<void> {
    if (!editingId) return
    const name = editName.trim()
    if (name) {
      try {
        const updated = await window.api.updateProject(editingId, { name })
        upsertProject(updated)
      } catch (err) {
        toast(`Rename failed: ${err}`)
      }
    }
    setEditingId(null)
    setEditName('')
  }

  function cancelEdit(): void {
    setEditingId(null)
    setEditName('')
  }

  function deleteProject(project: Project): void {
    const count = grouped[project.id]?.length ?? 0
    const msg = count > 0
      ? `Delete project "${project.name}"? Its ${count} profile${count > 1 ? 's' : ''} will be moved to Orphaned.`
      : `Delete project "${project.name}"?`
    showConfirm(msg, async () => {
      try {
        const updatedProfiles = await window.api.deleteProject(project.id)
        setProfiles(updatedProfiles)
        removeProject(project.id)
      } catch (err) {
        toast(`Delete failed: ${err}`)
      }
    })
  }

  async function handleNewProject(): Promise<void> {
    try {
      const proj = await window.api.createProject({ name: 'New Project' })
      upsertProject(proj)
      setEditingId(proj.id)
      setEditName(proj.name)
    } catch (err) {
      toast(`Failed to create project: ${err}`)
    }
  }

  async function handleDrop(e: React.DragEvent, targetProjectId: string | undefined): Promise<void> {
    e.preventDefault()
    const profileId = e.dataTransfer.getData('text/plain')
    if (!profileId) return
    setDragOverId(null)
    try {
      const updated = await window.api.moveProfileToProject(profileId, targetProjectId)
      upsertProfile(updated)
    } catch (err) {
      toast(`Move failed: ${err}`)
    }
  }

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

  const hasAnyProfiles = profiles.length > 0 || projects.length > 0

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo"><Terminal size={14} /></div>
        <h1>DevEnv Manager</h1>
      </div>

      <div className="sidebar-actions">
        <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={handleNewProfile}>
          <Plus size={13} /> New Profile
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={handleNewProject} title="New Project">
          <FolderPlus size={14} />
        </button>
      </div>

      <div className="profile-list">
        {!hasAnyProfiles && (
          <div className="empty-state" style={{ paddingTop: 40 }}>
            <p>No profiles yet.</p>
            <p>Create one to get started.</p>
          </div>
        )}

        {projects.map((project) => (
          <ProjectSection
            key={project.id}
            id={project.id}
            label={project.name}
            profiles={grouped[project.id] ?? []}
            collapsed={collapsed.has(project.id)}
            dragOver={dragOverId === project.id}
            editing={editingId === project.id}
            editName={editName}
            onToggle={() => toggleCollapse(project.id)}
            onEditStart={() => startEdit(project)}
            onEditChange={setEditName}
            onEditConfirm={confirmEdit}
            onEditCancel={cancelEdit}
            onDelete={() => deleteProject(project)}
            onDragOver={(e) => { e.preventDefault(); setDragOverId(project.id) }}
            onDragLeave={() => setDragOverId(null)}
            onDrop={(e) => handleDrop(e, project.id)}
          />
        ))}

        {(projects.length > 0 || (grouped['orphaned']?.length ?? 0) > 0) && (
          <ProjectSection
            key="orphaned"
            id="orphaned"
            label="Orphaned"
            profiles={grouped['orphaned'] ?? []}
            isOrphaned
            collapsed={collapsed.has('orphaned')}
            dragOver={dragOverId === 'orphaned'}
            editing={false}
            editName=""
            onToggle={() => toggleCollapse('orphaned')}
            onEditStart={() => {}}
            onEditChange={() => {}}
            onEditConfirm={() => {}}
            onEditCancel={() => {}}
            onDelete={() => {}}
            onDragOver={(e) => { e.preventDefault(); setDragOverId('orphaned') }}
            onDragLeave={() => setDragOverId(null)}
            onDrop={(e) => handleDrop(e, undefined)}
          />
        )}

        {projects.length === 0 && profiles.map((p) => (
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
          <Upload size={13} /> Import
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ flex: 1 }}
          onClick={handleExportAll}
          title="Export all profiles"
        >
          <Download size={13} /> Export
        </button>
        <button
          className="btn btn-icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
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
