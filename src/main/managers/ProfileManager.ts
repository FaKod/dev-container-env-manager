import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import type { Profile } from '../../shared/types'

interface StoreSchema {
  profiles: Profile[]
}

const DEFAULT_PROFILE: Omit<Profile, 'id' | 'name' | 'createdAt' | 'updatedAt'> = {
  ssh: {
    host: '',
    forwards: [],
    keepalive: true
  },
  terminal: {
    presentation: 'tab',
    defaultContext: 'ssh',
    keepVisibleWhenDisconnected: true
  },
  connectionPolicy: {
    autoReconnect: true,
    preventDuplicateConnections: true,
    existingContainerBehavior: 'attach-or-recreate',
    reconnectDelay: 3000,
    maxReconnectAttempts: 5
  }
}

export class ProfileManager {
  private store: Store<StoreSchema>

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'profiles',
      defaults: { profiles: [] }
    })
  }

  getAll(): Profile[] {
    return this.store.get('profiles', [])
  }

  getById(id: string): Profile | undefined {
    return this.getAll().find((p) => p.id === id)
  }

  create(data: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>>): Profile {
    const now = new Date().toISOString()
    const name = data.name ?? 'New Profile'
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      ...data,
      ssh: { ...DEFAULT_PROFILE.ssh, ...(data.ssh ?? {}) },
      terminal: { ...DEFAULT_PROFILE.terminal, ...(data.terminal ?? {}) },
      connectionPolicy: {
        ...DEFAULT_PROFILE.connectionPolicy,
        ...(data.connectionPolicy ?? {})
      },
      id: uuidv4(),
      name,
      createdAt: now,
      updatedAt: now
    }
    // Container name always equals profile name
    if (profile.container) {
      profile.container = { ...profile.container, name }
    }

    const profiles = this.getAll()
    profiles.push(profile)
    this.store.set('profiles', profiles)
    return profile
  }

  update(id: string, updates: Partial<Omit<Profile, 'id' | 'createdAt'>>): Profile {
    const profiles = this.getAll()
    const idx = profiles.findIndex((p) => p.id === id)
    if (idx === -1) throw new Error(`Profile ${id} not found`)

    const updated: Profile = {
      ...profiles[idx],
      ...updates,
      id,
      createdAt: profiles[idx].createdAt,
      updatedAt: new Date().toISOString()
    }
    // Container name always equals profile name
    if (updated.container) {
      updated.container = { ...updated.container, name: updated.name }
    }
    profiles[idx] = updated
    this.store.set('profiles', profiles)
    return updated
  }

  delete(id: string): void {
    const profiles = this.getAll().filter((p) => p.id !== id)
    this.store.set('profiles', profiles)
  }

  clone(id: string): Profile {
    const source = this.getById(id)
    if (!source) throw new Error(`Profile ${id} not found`)

    const now = new Date().toISOString()
    const cloned: Profile = {
      ...JSON.parse(JSON.stringify(source)),
      id: uuidv4(),
      name: `${source.name} (copy)`,
      createdAt: now,
      updatedAt: now
    }

    const profiles = this.getAll()
    profiles.push(cloned)
    this.store.set('profiles', profiles)
    return cloned
  }

  exportProfile(id: string): string {
    const profile = this.getById(id)
    if (!profile) throw new Error(`Profile ${id} not found`)
    return JSON.stringify(profile, null, 2)
  }

  exportAll(): string {
    return JSON.stringify({ profiles: this.getAll() }, null, 2)
  }

  importProfile(json: string): Profile {
    let data: Partial<Profile>
    try {
      data = JSON.parse(json)
    } catch {
      throw new Error('Import failed: invalid JSON')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Import failed: expected a profile object')
    }
    if (typeof data.name !== 'string' || !data.name.trim()) {
      throw new Error('Import failed: profile must have a name')
    }
    if (!data.ssh || typeof data.ssh.host !== 'string' || !data.ssh.host.trim()) {
      throw new Error('Import failed: profile must have an SSH host')
    }
    const now = new Date().toISOString()
    const originalCreatedAt = typeof data.createdAt === 'string' && data.createdAt ? data.createdAt : now

    // Strip id so we create a fresh one
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...rest } = data

    const profile = this.create(rest as Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>>)

    // Restore original createdAt if the imported profile had one
    if (originalCreatedAt !== now) {
      const profiles = this.getAll()
      const idx = profiles.findIndex((p) => p.id === profile.id)
      if (idx !== -1) {
        profiles[idx] = { ...profiles[idx], createdAt: originalCreatedAt }
        this.store.set('profiles', profiles)
        return profiles[idx]
      }
    }

    return profile
  }
}
