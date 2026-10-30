import React, { useState } from 'react'
import type { Profile, OpenShellConfig, OpenShellForward } from '../../../shared/types'
import {
  SANDBOX_NAME_MAX_LEN,
  isValidSandboxName,
  joinCommand,
  looksLikeSecret,
  sandboxSlug,
  splitCommand
} from '../../../shared/backend'
import { toast } from './Toast'

// "Sandbox" tab of the profile editor for OpenShell profiles
// (Docs/openshell-sandbox-plan.md, Phase 5). Edits the profile's `openshell` block.

type DraftProfile = Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>

interface Props {
  draft: DraftProfile
  onChange: <K extends keyof DraftProfile>(key: K, value: DraftProfile[K]) => void
}

const hintStyle: React.CSSProperties = { fontSize: 11, color: 'var(--overlay1)', marginTop: 2 }
const warnStyle: React.CSSProperties = { fontSize: 11, color: 'var(--peach)', marginTop: 4 }
const checkboxLabel: React.CSSProperties = { flexDirection: 'row', display: 'flex', gap: 6, alignItems: 'center' }

export function OpenShellTab({ draft, onChange }: Props): React.ReactElement {
  const o: OpenShellConfig = draft.openshell ?? { sandboxName: '' }
  const remote = !draft.local
  const where = remote ? draft.ssh.host || 'the SSH host' : 'this machine'
  const usesTemplate = o.template !== undefined

  function set<K extends keyof OpenShellConfig>(key: K, value: OpenShellConfig[K]): void {
    onChange('openshell', { ...o, [key]: value })
  }

  // Free-text fields that map to structured values keep their own text, so
  // typing a quote or a trailing space isn't normalised away mid-edit.
  const [mainCommandText, setMainCommandText] = useState(joinCommand(o.mainCommand ?? []))
  const [envRows, setEnvRows] = useState(Object.entries(o.env ?? {}).map(([k, v]) => ({ k, v })))
  const [providersText, setProvidersText] = useState((o.providers ?? []).join(', '))

  // Lists loaded from the gateway on request
  const [templates, setTemplates] = useState<string[] | null>(null)
  const [providers, setProviders] = useState<{ name: string; type: string }[] | null>(null)
  const [gateways, setGateways] = useState<{ name: string; active: boolean }[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [checkResult, setCheckResult] = useState<string | null>(null)

  async function load<T>(what: string, fn: () => Promise<T>, done: (v: T) => void): Promise<void> {
    if (remote && !draft.ssh.host.trim()) { toast('Set the SSH host first (SSH tab)'); return }
    setBusy(what)
    try {
      done(await fn())
    } catch (err) {
      toast(`Could not load ${what}: ${err}`)
    } finally {
      setBusy(null)
    }
  }

  function testConnection(): void {
    setCheckResult(null)
    void load('connection test', () => window.api.openShellCheck(draft), (r) =>
      setCheckResult(`${r.version} · gateway ${r.gateway ?? '(active)'} ${r.server ? `at ${r.server} ` : ''}· ${r.status}`)
    )
  }

  function updateEnv(rows: { k: string; v: string }[]): void {
    setEnvRows(rows)
    const env: Record<string, string> = {}
    for (const { k, v } of rows) if (k.trim()) env[k.trim()] = v
    set('env', Object.keys(env).length ? env : undefined)
  }

  function updateProviders(text: string): void {
    setProvidersText(text)
    const list = text.split(/[\s,]+/).filter(Boolean)
    set('providers', list.length ? list : undefined)
  }

  function toggleProvider(name: string): void {
    const list = (o.providers ?? []).includes(name)
      ? (o.providers ?? []).filter((p) => p !== name)
      : [...(o.providers ?? []), name]
    updateProviders(list.join(', '))
  }

  const forwards = o.forwards ?? []
  function updateForward(i: number, fwd: OpenShellForward): void {
    const next = [...forwards]
    next[i] = fwd
    set('forwards', next)
  }

  const nameInvalid = !!o.sandboxName && !isValidSandboxName(o.sandboxName)
  let driverJsonError: string | null = null
  if (o.driverConfigJson?.trim()) {
    try { JSON.parse(o.driverConfigJson) } catch (err) { driverJsonError = String(err) }
  }

  return (
    <div className="form-section">
      {/* ── Sandbox ── */}
      <div className="form-section-title">Sandbox</div>
      <div className="form-group">
        <label>Sandbox Name</label>
        <input
          className="form-control mono"
          value={o.sandboxName}
          onChange={(e) => set('sandboxName', e.target.value.trim())}
          placeholder={`${sandboxSlug(draft.name || 'sandbox')} (from the profile name)`}
        />
        <div style={hintStyle}>
          Lowercase letters, digits and dashes, at most {SANDBOX_NAME_MAX_LEN} characters. It stays the same when the
          profile is renamed; changing it points the profile at a different sandbox.
        </div>
        {nameInvalid && <div style={warnStyle}>Not a valid sandbox name.</div>}
      </div>

      <div className="form-group">
        <label>Created From</label>
        <div style={{ display: 'flex', gap: 16, paddingTop: 4 }}>
          <label style={{ ...checkboxLabel, fontWeight: 'normal' }}>
            <input
              type="radio"
              name="openshellSource"
              checked={!usesTemplate}
              onChange={() => onChange('openshell', { ...o, template: undefined })}
            />
            Image
          </label>
          <label style={{ ...checkboxLabel, fontWeight: 'normal' }}>
            <input
              type="radio"
              name="openshellSource"
              checked={usesTemplate}
              onChange={() => onChange('openshell', { ...o, template: o.template ?? '' })}
            />
            Sandbox template
          </label>
        </div>
      </div>
      {!usesTemplate ? (
        <div className="form-group">
          <label>Image</label>
          <input
            className="form-control mono"
            value={o.image ?? ''}
            onChange={(e) => set('image', e.target.value.trim() || undefined)}
            placeholder="(gateway default image)"
          />
          <div style={hintStyle}>
            Must be pullable by the gateway. The image's CMD/ENTRYPOINT does not run; use the main command below.
          </div>
        </div>
      ) : (
        <div className="form-group">
          <label>
            Template
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 8 }}
              disabled={busy !== null}
              onClick={() => void load('templates', () => window.api.openShellTemplates(draft), setTemplates)}
            >
              {busy === 'templates' ? 'Loading…' : 'Load from gateway'}
            </button>
          </label>
          <input
            className="form-control mono"
            list="openshell-templates"
            value={o.template ?? ''}
            onChange={(e) => set('template', e.target.value.trim())}
            placeholder="template name"
          />
          <datalist id="openshell-templates">
            {(templates ?? []).map((t) => <option key={t} value={t} />)}
          </datalist>
          {templates && templates.length === 0 && <div style={hintStyle}>The gateway has no templates.</div>}
          <div style={hintStyle}>
            A template sets image, resources, environment and driver config, so those fields are not used.
          </div>
        </div>
      )}

      <div className="form-group">
        <label>Main Command</label>
        <input
          className="form-control mono"
          value={mainCommandText}
          onChange={(e) => {
            setMainCommandText(e.target.value)
            const args = splitCommand(e.target.value)
            set('mainCommand', args.length ? args : undefined)
          }}
          placeholder="(none: a login shell)"
        />
        <div style={hintStyle}>
          The sandbox's main process, e.g. <code>claude</code>. The first terminal attaches to it; others get their own
          shell. Without one, every terminal is its own shell.
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Restart Policy</label>
          <select
            className="form-control"
            value={o.restartPolicy ?? ''}
            onChange={(e) => set('restartPolicy', (e.target.value || undefined) as OpenShellConfig['restartPolicy'])}
          >
            <option value="">Default ({o.mainCommand?.length ? 'never' : 'always'})</option>
            <option value="never">never</option>
            <option value="on-failure">on-failure</option>
            <option value="always">always</option>
          </select>
        </div>
        <div className="form-group">
          <label>Terminal Shell</label>
          <input
            className="form-control mono"
            value={o.shell ?? ''}
            onChange={(e) => set('shell', e.target.value || undefined)}
            placeholder="bash (falls back to sh)"
          />
        </div>
      </div>

      {/* ── Resources ── */}
      {!usesTemplate && (
        <>
          <div className="form-section-title" style={{ marginTop: 8 }}>Resources</div>
          <div className="form-row">
            <div className="form-group">
              <label>CPU</label>
              <input
                className="form-control mono"
                value={o.cpu ?? ''}
                onChange={(e) => set('cpu', e.target.value.trim() || undefined)}
                placeholder="e.g. 2 or 500m"
              />
            </div>
            <div className="form-group">
              <label>Memory</label>
              <input
                className="form-control mono"
                value={o.memory ?? ''}
                onChange={(e) => set('memory', e.target.value.trim() || undefined)}
                placeholder="e.g. 4Gi"
              />
            </div>
            <div className="form-group">
              <label>GPUs</label>
              <input
                className="form-control"
                type="number"
                min={0}
                value={o.gpu === true ? '' : (o.gpu ?? '')}
                onChange={(e) => set('gpu', e.target.value ? Number(e.target.value) : o.gpu === true ? true : undefined)}
                placeholder={o.gpu === true ? 'any' : 'none'}
                disabled={o.gpu === true}
              />
              <label style={{ ...checkboxLabel, fontWeight: 'normal', marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={o.gpu === true}
                  onChange={(e) => set('gpu', e.target.checked ? true : undefined)}
                />
                GPU (gateway picks)
              </label>
            </div>
          </div>
        </>
      )}

      {/* ── Workspace folder ── */}
      <div className="form-section-title" style={{ marginTop: 8 }}>Workspace Folder</div>
      <div className="form-group">
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={!!o.workspaceMount}
            onChange={(e) =>
              set(
                'workspaceMount',
                e.target.checked ? { localPath: draft.local ? '${cwd}' : '', targetPath: '/sandbox/project' } : undefined
              )
            }
          />
          Mount a folder from {where} into the sandbox
        </label>
      </div>
      {o.workspaceMount && (
        <>
          <div className="form-row">
            <div className="form-group">
              <label>Folder on {where}</label>
              <input
                className="form-control mono"
                value={o.workspaceMount.localPath}
                onChange={(e) => set('workspaceMount', { ...o.workspaceMount!, localPath: e.target.value })}
                placeholder={draft.local ? '${cwd}' : '/home/you/project'}
              />
            </div>
            <div className="form-group">
              <label>Path in the Sandbox</label>
              <input
                className="form-control mono"
                value={o.workspaceMount.targetPath}
                onChange={(e) => set('workspaceMount', { ...o.workspaceMount!, targetPath: e.target.value })}
                placeholder="/sandbox/project"
              />
            </div>
          </div>
          <div className="form-group">
            <label style={{ ...checkboxLabel, fontWeight: 'normal' }}>
              <input
                type="checkbox"
                checked={o.workspaceMount.readOnly ?? false}
                onChange={(e) => set('workspaceMount', { ...o.workspaceMount!, readOnly: e.target.checked || undefined })}
              />
              Read-only
            </label>
          </div>
          <div style={warnStyle}>
            The mounted folder is outside OpenShell&apos;s filesystem policy: the sandbox can read and change everything
            in it. Files it creates belong to uid 1000. The gateway on {where} must allow folder mounts
            (<code>allow_driver_config</code> and <code>enable_bind_mounts</code> in its gateway.toml).
          </div>
          {usesTemplate && (
            <div style={warnStyle}>A folder mount can&apos;t be combined with a template; put it into the template.</div>
          )}
        </>
      )}

      {/* ── Port forwards ── */}
      <div className="form-section-title" style={{ marginTop: 8 }}>
        Port Forwards
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: 8 }}
          onClick={() => set('forwards', [...forwards, { localPort: 3000, targetPort: 3000 }])}
        >
          + Add
        </button>
      </div>
      <div style={{ ...hintStyle, marginBottom: 6 }}>
        Local port on this machine → port inside the sandbox (the service must listen on 127.0.0.1 or 0.0.0.0).
        {remote && ` Port on ${where}: used between the two hops; defaults to the local port.`}
      </div>
      {forwards.map((fwd, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
          <div className="form-group" style={{ maxWidth: 110, marginBottom: 0 }}>
            <label>Local port</label>
            <input
              className="form-control"
              type="number"
              value={fwd.localPort}
              onChange={(e) => updateForward(i, { ...fwd, localPort: Number(e.target.value) })}
            />
          </div>
          <div className="form-group" style={{ maxWidth: 110, marginBottom: 0 }}>
            <label>Sandbox port</label>
            <input
              className="form-control"
              type="number"
              value={fwd.targetPort}
              onChange={(e) => updateForward(i, { ...fwd, targetPort: Number(e.target.value) })}
            />
          </div>
          {remote && (
            <div className="form-group" style={{ maxWidth: 130, marginBottom: 0 }}>
              <label>Port on host</label>
              <input
                className="form-control"
                type="number"
                value={fwd.remotePort ?? ''}
                onChange={(e) =>
                  updateForward(i, { ...fwd, remotePort: e.target.value ? Number(e.target.value) : undefined })
                }
                placeholder={String(fwd.localPort)}
              />
            </div>
          )}
          <button
            className="btn btn-icon"
            style={{ marginBottom: 2 }}
            onClick={() => set('forwards', forwards.filter((_, idx) => idx !== i))}
          >
            ✕
          </button>
        </div>
      ))}

      {/* ── Environment ── */}
      {!usesTemplate && (
        <>
          <div className="form-section-title" style={{ marginTop: 8 }}>
            Environment Variables
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 8 }}
              onClick={() => setEnvRows([...envRows, { k: '', v: '' }])}
            >
              + Add
            </button>
          </div>
          <div style={{ ...hintStyle, marginBottom: 6 }}>
            For non-secret values only: the sandbox can read them. Put secrets into providers.
          </div>
          {envRows.map((row, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="form-control mono"
                  style={{ maxWidth: 200 }}
                  value={row.k}
                  onChange={(e) => updateEnv(envRows.map((r, idx) => (idx === i ? { ...r, k: e.target.value } : r)))}
                  placeholder="NAME"
                />
                <input
                  className="form-control mono"
                  value={row.v}
                  onChange={(e) => updateEnv(envRows.map((r, idx) => (idx === i ? { ...r, v: e.target.value } : r)))}
                  placeholder="value"
                />
                <button className="btn btn-icon" onClick={() => updateEnv(envRows.filter((_, idx) => idx !== i))}>
                  ✕
                </button>
              </div>
              {looksLikeSecret(row.k) && (
                <div style={warnStyle}>
                  {row.k} looks like a secret. The sandbox can read environment variables; use a provider instead.
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {/* ── Providers ── */}
      <div className="form-section-title" style={{ marginTop: 8 }}>
        Providers
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: 8 }}
          disabled={busy !== null}
          onClick={() => void load('providers', () => window.api.openShellProviders(draft), setProviders)}
        >
          {busy === 'providers' ? 'Loading…' : 'Load from gateway'}
        </button>
      </div>
      <div className="form-group">
        <input
          className="form-control mono"
          value={providersText}
          onChange={(e) => updateProviders(e.target.value)}
          placeholder="e.g. github, anthropic"
        />
        <div style={hintStyle}>
          Credentials registered on the gateway (<code>openshell provider create</code>). The sandbox can use them
          without seeing the secret values.
        </div>
        {providers && providers.length === 0 && <div style={hintStyle}>The gateway has no providers yet.</div>}
        {providers && providers.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {providers.map((p) => {
              const on = (o.providers ?? []).includes(p.name)
              return (
                <button
                  key={p.name}
                  className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => toggleProvider(p.name)}
                  title={p.type}
                >
                  {on ? '✓ ' : ''}{p.name}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Policy ── */}
      <div className="form-section-title" style={{ marginTop: 8 }}>Policy</div>
      <div className="form-group">
        <label>Policy File on {where}</label>
        <input
          className="form-control mono"
          value={o.policyFile ?? ''}
          onChange={(e) => set('policyFile', e.target.value.trim() || undefined)}
          placeholder="(gateway default policy)"
        />
        <div style={hintStyle}>
          OpenShell policy YAML. The default policy blocks all outbound network traffic, so package installs and API
          calls fail until a policy allows them.
        </div>
      </div>

      {/* ── Gateway connection ── */}
      <div className="form-section-title" style={{ marginTop: 8 }}>
        Gateway
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginLeft: 8 }}
          disabled={busy !== null}
          onClick={testConnection}
        >
          {busy === 'connection test' ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {checkResult && <div style={{ ...hintStyle, color: 'var(--green)', marginBottom: 6 }}>✓ {checkResult}</div>}
      <div className="form-row">
        <div className="form-group">
          <label>
            Gateway
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 8 }}
              disabled={busy !== null}
              onClick={() => void load('gateways', () => window.api.openShellGateways(draft), setGateways)}
            >
              {busy === 'gateways' ? 'Loading…' : 'Load'}
            </button>
          </label>
          <input
            className="form-control mono"
            list="openshell-gateways"
            value={o.gateway ?? ''}
            onChange={(e) => set('gateway', e.target.value.trim() || undefined)}
            placeholder="(active gateway)"
          />
          <datalist id="openshell-gateways">
            {(gateways ?? []).map((g) => <option key={g.name} value={g.name}>{g.active ? 'active' : ''}</option>)}
          </datalist>
        </div>
        <div className="form-group">
          <label>Workspace</label>
          <input
            className="form-control mono"
            value={o.workspace ?? ''}
            onChange={(e) => set('workspace', e.target.value.trim() || undefined)}
            placeholder="default"
          />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>CLI Path on {where}</label>
          <input
            className="form-control mono"
            value={o.cliPath ?? ''}
            onChange={(e) => set('cliPath', e.target.value.trim() || undefined)}
            placeholder="openshell"
          />
        </div>
        <div className="form-group">
          <label>Compute Driver</label>
          <select
            className="form-control"
            value={o.driver ?? 'docker'}
            onChange={(e) => set('driver', e.target.value === 'docker' ? undefined : (e.target.value as OpenShellConfig['driver']))}
          >
            <option value="docker">docker</option>
            <option value="podman">podman</option>
            <option value="vm">vm (MicroVM)</option>
          </select>
        </div>
      </div>
      <div className="form-group">
        <label>Driver Config JSON (advanced)</label>
        <textarea
          className="form-control mono"
          rows={3}
          value={o.driverConfigJson ?? ''}
          onChange={(e) => set('driverConfigJson', e.target.value || undefined)}
          placeholder='{"docker":{"cdi_devices":["nvidia.com/gpu=0"]}}'
        />
        <div style={hintStyle}>Merged with the folder mount. Needs <code>allow_driver_config</code> on the gateway.</div>
        {driverJsonError && <div style={warnStyle}>Invalid JSON: {driverJsonError}</div>}
      </div>
    </div>
  )
}

/**
 * Problems that would make sandbox creation fail, checked before saving.
 * Returns a message, or null when the OpenShell settings look usable.
 */
export function validateOpenShell(draft: DraftProfile): string | null {
  const o = draft.openshell
  if (!o) return null
  if (o.sandboxName && !isValidSandboxName(o.sandboxName)) {
    return `Sandbox name "${o.sandboxName}" is invalid: use lowercase letters, digits and dashes, at most ${SANDBOX_NAME_MAX_LEN} characters`
  }
  if (o.template !== undefined) {
    if (!o.template) return 'Enter a template name, or choose Image'
    const conflicts = [
      o.image && 'image', o.cpu && 'CPU', o.memory && 'memory', o.gpu && 'GPU',
      o.env && Object.keys(o.env).length && 'environment variables',
      o.workspaceMount && 'folder mount', o.driverConfigJson?.trim() && 'driver config JSON'
    ].filter(Boolean)
    if (conflicts.length) return `A template can't be combined with: ${conflicts.join(', ')}`
  }
  if (o.workspaceMount) {
    if (!o.workspaceMount.localPath.trim()) return 'Enter the folder to mount, or untick the folder mount'
    const target = o.workspaceMount.targetPath.replace(/\/+$/, '')
    if (!target.startsWith('/sandbox/')) return 'The mount path in the sandbox must be below /sandbox, e.g. /sandbox/project'
  }
  const ports = new Set<number>()
  for (const f of o.forwards ?? []) {
    for (const p of [f.localPort, f.targetPort, f.remotePort]) {
      if (p !== undefined && (!Number.isInteger(p) || p < 1 || p > 65535)) return `Port ${p} is not between 1 and 65535`
    }
    if (ports.has(f.localPort)) return `Local port ${f.localPort} is forwarded twice`
    ports.add(f.localPort)
  }
  if (o.driverConfigJson?.trim()) {
    try {
      const v = JSON.parse(o.driverConfigJson)
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'Driver config JSON must be an object'
    } catch (err) {
      return `Driver config JSON is invalid: ${err}`
    }
  }
  return null
}
