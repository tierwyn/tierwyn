import { useCallback, useEffect, useState } from 'react';
import type {
  McpNativeEntry,
  McpNativeInstallResult,
  McpNativeView,
  McpNativeWriteScope,
  McpPlacement,
  McpPublicVar,
  McpSecretKind,
  McpServerDef,
  McpServerInput,
  McpTransport,
  Project,
} from '@tierwyn/shared';
import {
  MCP_ENV_FALLBACK_RE,
  MCP_ENV_KEY_RE,
  MCP_HEADER_KEY_RE,
  MCP_ID_RE,
  MCP_INJECTABLE_ADAPTERS,
  MCP_NATIVE_WRITABLE_AGENTS,
  MCP_TRANSPORTS,
  mcpAgentCapability,
  effectiveMcpPlacement,
  validateMcpServerInput,
} from '@tierwyn/shared';
import { describeMcpCapability } from '../mcpView.js';
import { api } from '../api.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';
import { ConfirmDialog } from './ConfirmDialog.js';

const INJECTABLE_OPTIONS: SelectDropdownOption[] = [...MCP_INJECTABLE_ADAPTERS].map((a) => ({
  value: a,
  label: a,
}));

const TRANSPORT_OPTIONS: SelectDropdownOption<McpTransport>[] = [
  { value: 'stdio', label: 'stdio (Local Process)' },
  { value: 'http', label: 'http (Remote HTTP Stream)' },
  { value: 'sse', label: 'sse (Server-Sent Events)' },
];

const PLACEMENT_OPTIONS: SelectDropdownOption<McpPlacement>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'agent', label: "Agent's host" },
  { value: 'hub', label: 'Hub' },
];

const NATIVE_AGENT_OPTIONS: SelectDropdownOption[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'copilot', label: 'GitHub Copilot' },
  { value: 'grok-build', label: 'Grok Build' },
  { value: 'pi', label: 'Pi' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'qwen', label: 'Qwen Code' },
  { value: 'kiro', label: 'Kiro' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kilocode', label: 'KiloCode' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'kimi', label: 'Kimi Code' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'grok-bot', label: 'Grok Bot' },
];

const WRITABLE_AGENT_OPTIONS: SelectDropdownOption[] = NATIVE_AGENT_OPTIONS.filter((o) =>
  MCP_NATIVE_WRITABLE_AGENTS.has(o.value),
);

interface ServerDraft {
  id: string;
  description: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  env: McpPublicVar[];
  headers: McpPublicVar[];
  enabled: boolean;
  allowInDelegating: boolean;
  placement: McpPlacement;
  agentTypes: string[];
}

const emptyDraft = (): ServerDraft => ({
  id: '',
  description: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  cwd: '',
  url: '',
  env: [],
  headers: [],
  enabled: true,
  allowInDelegating: false,
  placement: 'auto',
  agentTypes: [],
});

function draftFromDef(def: McpServerDef): ServerDraft {
  return {
    id: def.id,
    description: def.description ?? '',
    transport: def.transport,
    command: def.command ?? '',
    argsText: (def.args ?? []).join('\n'),
    cwd: def.cwd ?? '',
    url: def.url ?? '',
    env: def.env ? def.env.map((v) => ({ ...v })) : [],
    headers: def.headers ? def.headers.map((h) => ({ ...h })) : [],
    enabled: def.enabled,
    allowInDelegating: def.allowInDelegating,
    placement: def.placement ?? 'auto',
    agentTypes: def.agentTypes ? [...def.agentTypes] : [],
  };
}

export function McpServerSettings() {
  const [servers, setServers] = useState<McpServerDef[]>([]);
  const [vaultAvailable, setVaultAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editor modal state
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Secret management drafts (key => secret string)
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [secretBusy, setSecretBusy] = useState<string | null>(null);

  // Deletion confirm
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Native installation dialog state
  const [installServer, setInstallServer] = useState<McpServerDef | null>(null);
  const [installAgent, setInstallAgent] = useState<string>('claude-code');
  const [installScope, setInstallScope] = useState<McpNativeWriteScope>('user');
  const [installProject, setInstallProject] = useState<string>('');
  const [copySecrets, setCopySecrets] = useState<boolean>(false);
  const [installing, setInstalling] = useState<boolean>(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<McpNativeInstallResult | null>(null);

  // Native entry removal confirm
  const [removeTarget, setRemoveTarget] = useState<McpNativeEntry | null>(null);
  const [removing, setRemoving] = useState<boolean>(false);

  // Native config viewer state
  const [projects, setProjects] = useState<Project[]>([]);
  const [nativeAgent, setNativeAgent] = useState('claude-code');
  const [nativeProject, setNativeProject] = useState('');
  const [nativeView, setNativeView] = useState<McpNativeView | null>(null);
  const [nativeLoading, setNativeLoading] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);

  const fetchServers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.listMcpServers();
      setServers(res.servers);
      setVaultAvailable(res.vaultAvailable);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchServers();
    api.listProjects().then(setProjects).catch(() => {});
  }, [fetchServers]);

  const fetchNative = useCallback(async (agent: string, projId?: string) => {
    try {
      setNativeLoading(true);
      setNativeError(null);
      const view = await api.getNativeMcp(agent, projId || undefined);
      setNativeView(view);
    } catch (err) {
      setNativeError(err instanceof Error ? err.message : String(err));
      setNativeView(null);
    } finally {
      setNativeLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchNative(nativeAgent, nativeProject);
  }, [fetchNative, nativeAgent, nativeProject]);

  const openNewServer = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setDraftError(null);
    setSecretDrafts({});
  };

  const openEditServer = (s: McpServerDef) => {
    setEditingId(s.id);
    setDraft(draftFromDef(s));
    setDraftError(null);
    setSecretDrafts({});
  };

  const closeEditor = () => {
    setDraft(null);
    setEditingId(null);
    setDraftError(null);
    setSecretDrafts({});
  };

  const openImportFromNative = (entry: McpNativeEntry) => {
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^[-_]+/, '')
      .slice(0, 32);
    const transport: McpTransport =
      entry.transport === 'http' || entry.transport === 'sse' ? entry.transport : 'stdio';
    setEditingId(null);
    setDraft({
      id: slug,
      description: `Imported from ${nativeAgent} (${entry.scope})`,
      transport,
      command: transport === 'stdio' ? (entry.command ?? '') : '',
      argsText:
        transport === 'stdio'
          ? (entry.args ?? []).filter((a) => !a.includes('••••')).join('\n')
          : '',
      cwd: '',
      url:
        transport !== 'stdio' &&
        entry.url &&
        entry.url !== 'invalid-url' &&
        !entry.url.includes('••••')
          ? entry.url
          : '',
      env:
        transport === 'stdio'
          ? Object.keys(entry.env ?? {}).map((key) => ({ key, secret: true }))
          : [],
      headers:
        transport !== 'stdio'
          ? Object.keys(entry.headers ?? {}).map((key) => ({ key, secret: true }))
          : [],
      enabled: false,
      allowInDelegating: false,
      placement: 'auto',
      agentTypes: [],
    });
    setDraftError(null);
    setSecretDrafts({});
  };

  const openInstallDialog = (s: McpServerDef) => {
    setInstallServer(s);
    setInstallAgent('claude-code');
    setInstallScope('user');
    setInstallProject(projects[0]?.id ?? '');
    setCopySecrets(false);
    setInstallError(null);
    setInstallResult(null);
  };

  const nativeRemoteProjectId = projects.find((p) => p.id === nativeProject)?.remoteHostId
    ? nativeProject
    : undefined;

  const handleInstall = async () => {
    if (!installServer) return;
    try {
      setInstalling(true);
      setInstallError(null);
      const res = await api.installNativeMcp(installAgent, {
        serverId: installServer.id,
        scope: installScope,
        projectId: installScope === 'project' ? installProject : nativeRemoteProjectId,
        copySecrets,
      });
      setInstallResult(res);
      if (nativeAgent === installAgent) {
        void fetchNative(nativeAgent, nativeProject);
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const handleRemove = async (entry: McpNativeEntry) => {
    try {
      setRemoving(true);
      await api.removeNativeMcp(
        nativeAgent,
        entry.name,
        entry.scope as McpNativeWriteScope,
        entry.scope === 'project' ? nativeProject : nativeRemoteProjectId,
      );
      setRemoveTarget(null);
      await fetchNative(nativeAgent, nativeProject);
    } catch (err) {
      setNativeError(err instanceof Error ? err.message : String(err));
      setRemoveTarget(null);
    } finally {
      setRemoving(false);
    }
  };

  const handleToggle = async (s: McpServerDef) => {
    try {
      setError(null);
      const payload: McpServerInput = {
        id: s.id,
        transport: s.transport,
        command: s.command,
        args: s.args,
        cwd: s.cwd,
        url: s.url,
        description: s.description,
        enabled: !s.enabled,
        allowInDelegating: s.allowInDelegating,
        placement: s.placement ?? 'auto',
        agentTypes: s.agentTypes,
        env: s.env.map((e) => ({
          key: e.key,
          secret: e.secret,
          value: e.value,
          envFallback: e.envFallback,
        })),
        headers: s.headers.map((h) => ({
          key: h.key,
          secret: h.secret,
          value: h.value,
          envFallback: h.envFallback,
        })),
      };
      await api.saveMcpServer(payload);
      await fetchServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      setError(null);
      await api.deleteMcpServer(id);
      setDeleteTarget(null);
      await fetchServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveSecret = async (
    serverId: string,
    kind: McpSecretKind,
    key: string,
    value: string,
  ) => {
    const slot = `${kind}:${key}`;
    try {
      setSecretBusy(slot);
      setDraftError(null);
      const res = await api.setMcpSecret(serverId, kind, key, value);
      // Update draft variable status with updated server response
      setDraft((d) => {
        if (!d) return d;
        const list = kind === 'env' ? d.env : d.headers;
        const updatedList = list.map((v) => {
          if (v.key !== key) return v;
          const fresh = (kind === 'env' ? res.server.env : res.server.headers).find(
            (x) => x.key === key,
          );
          return fresh ? { ...fresh } : v;
        });
        return kind === 'env' ? { ...d, env: updatedList } : { ...d, headers: updatedList };
      });
      setSecretDrafts((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      await fetchServers();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setSecretBusy(null);
    }
  };

  const handleClearSecret = async (serverId: string, kind: McpSecretKind, key: string) => {
    const slot = `${kind}:${key}`;
    try {
      setSecretBusy(slot);
      setDraftError(null);
      const res = await api.clearMcpSecret(serverId, kind, key);
      setDraft((d) => {
        if (!d) return d;
        const list = kind === 'env' ? d.env : d.headers;
        const updatedList = list.map((v) => {
          if (v.key !== key) return v;
          const fresh = (kind === 'env' ? res.server.env : res.server.headers).find(
            (x) => x.key === key,
          );
          return fresh ? { ...fresh } : v;
        });
        return kind === 'env' ? { ...d, env: updatedList } : { ...d, headers: updatedList };
      });
      await fetchServers();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setSecretBusy(null);
    }
  };

  const handleSaveDraft = async () => {
    if (!draft) return;
    setDraftError(null);

    const args = draft.argsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const input: McpServerInput = {
      id: draft.id.trim(),
      transport: draft.transport,
      description: draft.description.trim() || undefined,
      command: draft.transport === 'stdio' ? draft.command.trim() || undefined : undefined,
      args: draft.transport === 'stdio' ? args : undefined,
      cwd: draft.transport === 'stdio' && draft.cwd.trim() ? draft.cwd.trim() : undefined,
      url: draft.transport !== 'stdio' ? draft.url.trim() || undefined : undefined,
      enabled: draft.enabled,
      allowInDelegating: draft.allowInDelegating,
      placement: draft.placement,
      agentTypes: draft.agentTypes.length > 0 ? draft.agentTypes : null,
      env:
        draft.transport === 'stdio'
          ? draft.env.map((e) => ({
              key: e.key.trim(),
              secret: Boolean(e.secret),
              value: !e.secret ? e.value ?? '' : undefined,
              envFallback: e.secret && e.envFallback?.trim() ? e.envFallback.trim() : undefined,
            }))
          : [],
      headers:
        draft.transport !== 'stdio'
          ? draft.headers.map((h) => ({
              key: h.key.trim(),
              secret: Boolean(h.secret),
              value: !h.secret ? h.value ?? '' : undefined,
              envFallback: h.secret && h.envFallback?.trim() ? h.envFallback.trim() : undefined,
            }))
          : [],
    };

    const validated = validateMcpServerInput(input);
    if (!validated.ok) {
      setDraftError(validated.error);
      return;
    }

    try {
      setSaving(true);
      await api.saveMcpServer(validated.value);
      closeEditor();
      await fetchServers();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const serversMap = new Map<string, McpServerDef>(servers.map((s) => [s.id, s]));

  return (
    <div className="mcp-server-settings" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* ── Header & Action ────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="settings-section-title" style={{ margin: 0 }}>MCP Server Registry</div>
          <div className="modal-hint">
            Tierwyn-managed Model Context Protocol servers injected into supported agent sessions ({[...MCP_INJECTABLE_ADAPTERS].join(', ')}). Disabling a server stops Tierwyn injection only — copies in an agent&rsquo;s native config still load.
          </div>
        </div>
        <button
          type="button"
          className="modal-btn primary"
          onClick={openNewServer}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New server
        </button>
      </div>

      {!vaultAvailable && (
        <div className="usage-error" role="status">
          Plugin vault is unavailable. Secret vars will fail closed unless a matching TIERWYN_MCP_* environment fallback exists at server boot.
        </div>
      )}

      {error && <div className="usage-error" role="alert">{error}</div>}

      {/* ── Server List ────────────────────────────────────────────── */}
      {loading ? (
        <div className="modal-hint">Loading MCP servers…</div>
      ) : servers.length === 0 ? (
        <div className="modal-hint" style={{ padding: '24px 0', textAlign: 'center' }}>
          No MCP servers registered yet. Click &ldquo;New server&rdquo; to configure one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {servers.map((s) => (
            <div key={s.id} className="settings-card active">
              <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ minWidth: 200 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-1)' }}>{s.id}</span>
                      <span
                        style={{
                          fontSize: 11,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: 'rgba(255,255,255,0.08)',
                          color: 'var(--text-2)',
                          textTransform: 'uppercase',
                        }}
                      >
                        {s.transport}
                      </span>
                      {s.allowInDelegating ? (
                        <span
                          style={{
                            fontSize: 11,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'rgba(245, 158, 11, 0.15)',
                            color: 'var(--amber, #f59e0b)',
                          }}
                          title="Allowed in autonomous delegating chats"
                        >
                          delegating-allowed
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: 11,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'var(--surface-3)',
                            border: '1px solid var(--border)',
                            color: 'var(--text-3)',
                          }}
                          title="Direct chat sessions only"
                        >
                          direct-only
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <div className="modal-hint" style={{ marginTop: 4 }}>{s.description}</div>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={s.enabled}
                        className={`toggle-switch${s.enabled ? ' on' : ''}`}
                        onClick={() => void handleToggle(s)}
                        title={s.enabled ? 'Tierwyn injects this server into supported agents' : 'Tierwyn will not inject this server — native CLI configs (e.g. ~/.gemini, ~/.cursor) are unaffected'}
                      >
                        <span className="toggle-knob" />
                      </button>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 500,
                          minWidth: 46,
                          color: s.enabled ? 'var(--green, #10b981)' : 'var(--text-3)',
                        }}
                      >
                        {s.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => openInstallDialog(s)}
                    >
                      Install →
                    </button>
                    <button
                      type="button"
                      className="modal-btn"
                      onClick={() => openEditServer(s)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="modal-btn danger"
                      onClick={() => setDeleteTarget(s.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div style={{ fontSize: 12, color: 'var(--text-3)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {s.transport === 'stdio' ? (
                    <>
                      <span>Command: <code style={{ color: 'var(--text-2)' }}>{s.command}</code></span>
                      {s.args.length > 0 && <span>Args: {s.args.length}</span>}
                      {s.env.length > 0 && (
                        <span>
                          Env: {s.env.length} ({s.env.filter((e) => e.secret).length} secret)
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span>URL: <code style={{ color: 'var(--text-2)' }}>{s.url}</code></span>
                      {s.headers.length > 0 && (
                        <span>
                          Headers: {s.headers.length} ({s.headers.filter((h) => h.secret).length} secret)
                        </span>
                      )}
                    </>
                  )}
                  <span>
                    Adapters: {s.agentTypes ? s.agentTypes.join(', ') : 'all injectable'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Native Config Viewer ───────────────────────────────────── */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20, marginTop: 10 }}>
        <div className="settings-section-title">Native Agent Configurations</div>
        <div className="modal-hint" style={{ marginBottom: 12 }}>
          MCP servers configured natively on this host for each agent CLI. The agent loads these itself — the registry toggle above does not affect them.
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ minWidth: 180 }}>
            <SelectDropdown
              options={NATIVE_AGENT_OPTIONS}
              value={nativeAgent}
              onChange={(a) => setNativeAgent(a)}
              placement="bottom"
            />
          </div>
          {projects.length > 0 && (
            <div style={{ minWidth: 200 }}>
              <SelectDropdown
                options={[
                  { value: '', label: 'User scope (global)' },
                  ...projects.map((p) => ({ value: p.id, label: `Project: ${p.name}` })),
                ]}
                value={nativeProject}
                onChange={(p) => setNativeProject(p)}
                placement="bottom"
              />
            </div>
          )}
          <button
            type="button"
            className="modal-btn"
            disabled={nativeLoading}
            onClick={() => void fetchNative(nativeAgent, nativeProject)}
          >
            {nativeLoading ? 'Reading…' : 'Refresh'}
          </button>
        </div>

        <div className="modal-hint mcp-hint-box" style={{ marginBottom: 10 }}>
          <strong>{nativeAgent}:</strong> {describeMcpCapability(nativeAgent)}
          {mcpAgentCapability(nativeAgent).notes && <div>{mcpAgentCapability(nativeAgent).notes}</div>}
        </div>

        {nativeError && <div className="usage-error" role="alert">{nativeError}</div>}

        {nativeView?.note && (
          <div className="modal-hint" style={{ fontStyle: 'italic', marginBottom: 10 }}>
            Note: {nativeView.note}
          </div>
        )}

        {nativeView?.errors && nativeView.errors.length > 0 && (
          <div className="usage-error" style={{ marginBottom: 10 }}>
            {nativeView.errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}

        {nativeView?.raw && (
          <pre
            style={{
              padding: 12,
              background: 'rgba(0,0,0,0.2)',
              borderRadius: 6,
              fontFamily: 'var(--mono)',
              fontSize: 12,
              overflowX: 'auto',
              maxHeight: 280,
            }}
          >
            {nativeView.raw}
          </pre>
        )}

        {nativeView?.entries && nativeView.entries.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 12,
                color: 'var(--text-2)',
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-3)' }}>
                  <th style={{ padding: '8px 6px' }}>Name</th>
                  <th style={{ padding: '8px 6px' }}>Scope</th>
                  <th style={{ padding: '8px 6px' }}>Transport</th>
                  <th style={{ padding: '8px 6px' }}>Target</th>
                  <th style={{ padding: '8px 6px' }}>Source File</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {nativeView.entries.map((entry: McpNativeEntry, i: number) => {
                  const matchingServer = serversMap.get(entry.name);
                  const isRegistered = Boolean(matchingServer);
                  const isActiveCollision = Boolean(
                    matchingServer &&
                      matchingServer.enabled &&
                      (!matchingServer.agentTypes || matchingServer.agentTypes.includes(nativeAgent)),
                  );
                  const isFilteredOut = Boolean(
                    matchingServer &&
                      matchingServer.enabled &&
                      matchingServer.agentTypes &&
                      !matchingServer.agentTypes.includes(nativeAgent),
                  );

                  return (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '8px 6px', fontWeight: 600, color: 'var(--text-1)' }}>
                        {entry.name}
                        {isActiveCollision && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: 'rgba(239, 68, 68, 0.15)',
                              color: 'var(--red, #ef4444)',
                            }}
                            title="Active in Tierwyn registry and will be injected into this agent. Toggle it off above to use the native config exclusively."
                          >
                            collision
                          </span>
                        )}
                        {isRegistered && !matchingServer!.enabled && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: 'var(--surface-3)',
                              border: '1px solid var(--border)',
                              color: 'var(--text-3)',
                            }}
                            title="Disabled for Tierwyn injection only — this native entry still loads whenever the agent CLI starts."
                          >
                            registry disabled
                          </span>
                        )}
                        {isFilteredOut && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: 'rgba(59, 130, 246, 0.12)',
                              color: 'var(--blue, #3b82f6)',
                            }}
                            title="Registered in Tierwyn, but excluded from this agent by adapter filter."
                          >
                            filtered out
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '8px 6px' }}>{entry.scope}</td>
                      <td style={{ padding: '8px 6px' }}>{entry.transport}</td>
                      <td style={{ padding: '8px 6px', fontFamily: 'var(--mono)' }}>
                        {entry.command ? `${entry.command} ${(entry.args ?? []).join(' ')}` : entry.url ?? '—'}
                      </td>
                      <td style={{ padding: '8px 6px', color: 'var(--text-3)' }} title={entry.file}>
                        {entry.file}
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                          {!isRegistered ? (
                            <button
                              type="button"
                              className="modal-btn primary"
                              style={{ padding: '2px 8px', fontSize: 11 }}
                              onClick={() => openImportFromNative(entry)}
                              title="Import this native MCP server into the Tierwyn MCP Server Registry"
                            >
                              Import
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="modal-btn"
                              style={{ padding: '2px 8px', fontSize: 11 }}
                              onClick={() => void handleToggle(matchingServer!)}
                              title={
                                matchingServer!.enabled
                                  ? 'Disable Tierwyn injection so this agent uses its native configuration exclusively'
                                  : 'Enable Tierwyn injection across supported sessions'
                              }
                            >
                              {matchingServer!.enabled ? 'Disable injection' : 'Enable injection'}
                            </button>
                          )}
                          {MCP_NATIVE_WRITABLE_AGENTS.has(nativeAgent) &&
                            (entry.scope === 'user' || entry.scope === 'project') && (
                              <button
                                type="button"
                                className="modal-btn danger"
                                style={{ padding: '2px 8px', fontSize: 11 }}
                                disabled={removing}
                                onClick={() => setRemoveTarget(entry)}
                              >
                                Remove
                              </button>
                            )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {nativeView && !nativeView.raw && (!nativeView.entries || nativeView.entries.length === 0) && !nativeView.note && (
          <div className="modal-hint">No native MCP servers found for this agent and scope.</div>
        )}
      </div>

      {/* ── Server Edit / Create Modal ─────────────────────────────── */}
      {draft && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={closeEditor}>
          <div
            className="modal-content"
            style={{ maxWidth: 640, width: '92vw', maxHeight: '90vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span>{editingId ? `Edit MCP server: ${editingId}` : 'New MCP server'}</span>
              <button type="button" className="icon-btn" onClick={closeEditor} title="Close">
                ✕
              </button>
            </div>

            {draftError && <div className="usage-error" style={{ margin: '12px 16px 0' }}>{draftError}</div>}

            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="modal-field">
                <span className="modal-label">Server ID</span>
                <input
                  type="text"
                  className="modal-input"
                  value={draft.id}
                  disabled={Boolean(editingId)}
                  placeholder="e.g. github, filesystem, postgres"
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
                <div className="modal-hint">Lowercase slug, up to 32 chars (letters, numbers, hyphens, underscores).</div>
              </div>

              <div className="modal-field">
                <span className="modal-label">Description</span>
                <input
                  type="text"
                  className="modal-input"
                  value={draft.description}
                  placeholder="Optional brief description"
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>

              <div className="modal-field">
                <span className="modal-label">Transport</span>
                <SelectDropdown<McpTransport>
                  options={TRANSPORT_OPTIONS}
                  value={draft.transport}
                  onChange={(transport) => setDraft({ ...draft, transport })}
                  placement="bottom"
                />
              </div>

              <div className="modal-field">
                <span className="modal-label">Runs on (remote projects)</span>
                <SelectDropdown<McpPlacement>
                  options={PLACEMENT_OPTIONS}
                  value={draft.placement}
                  onChange={(placement) => setDraft({ ...draft, placement })}
                  placement="bottom"
                />
                {draft.placement === 'auto' && (
                  <div className="modal-hint">
                    → {effectiveMcpPlacement({ transport: draft.transport, url: draft.url.trim() || undefined, placement: 'auto' }) === 'hub' ? 'Hub' : "Agent's host"}
                  </div>
                )}
                <div className="modal-hint">
                  Agent's host: this server's secrets are sent to the remote host when its 'MCP secrets' toggle is on. Hub: secrets never leave this server — it runs on the hub machine and sees the hub's files, not the remote host's.
                </div>
              </div>

              {draft.transport === 'stdio' ? (
                <>
                  <div className="modal-field">
                    <span className="modal-label">Command</span>
                    <input
                      type="text"
                      className="modal-input"
                      value={draft.command}
                      placeholder="e.g. npx, uvx, docker, /usr/local/bin/my-server"
                      onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                    />
                  </div>

                  <div className="modal-field">
                    <span className="modal-label">Arguments (one per line)</span>
                    <textarea
                      className="modal-input"
                      rows={4}
                      value={draft.argsText}
                      placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/tmp"
                      onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                    />
                  </div>

                  <div className="modal-field">
                    <span className="modal-label">Working directory (optional)</span>
                    <input
                      type="text"
                      className="modal-input"
                      value={draft.cwd}
                      placeholder="Leave blank for session working directory"
                      onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                    />
                  </div>

                  {/* Environment Variables */}
                  <div className="modal-field">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="modal-label">Environment variables</span>
                      <button
                        type="button"
                        className="modal-btn"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            env: [...draft.env, { key: '', secret: false, value: '' }],
                          })
                        }
                      >
                        + Add var
                      </button>
                    </div>

                    {draft.env.map((v, idx) => {
                      const slot = `env:${v.key}`;
                      const isBusy = secretBusy === slot;
                      return (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            marginTop: 8,
                            padding: 8,
                            borderRadius: 6,
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              className="modal-input"
                              style={{ flex: 1, minWidth: 140 }}
                              placeholder="VAR_NAME"
                              value={v.key}
                              onChange={(e) => {
                                const next = [...draft.env];
                                next[idx] = { ...v, key: e.target.value };
                                setDraft({ ...draft, env: next });
                              }}
                            />
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={v.secret}
                                onChange={(e) => {
                                  const isSecret = e.target.checked;
                                  const next = [...draft.env];
                                  next[idx] = {
                                    ...v,
                                    secret: isSecret,
                                    value: isSecret ? undefined : (v.value ?? ''),
                                    envFallback: isSecret ? (v.envFallback ?? '') : undefined,
                                  };
                                  setDraft({ ...draft, env: next });
                                }}
                              />
                              Secret
                            </label>
                            <button
                              type="button"
                              className="modal-btn danger"
                              onClick={() => {
                                const next = draft.env.filter((_, i) => i !== idx);
                                setDraft({ ...draft, env: next });
                              }}
                            >
                              ✕
                            </button>
                          </div>

                          {!v.secret ? (
                            <input
                              type="text"
                              className="modal-input"
                              placeholder="Variable value"
                              value={v.value ?? ''}
                              onChange={(e) => {
                                const next = [...draft.env];
                                next[idx] = { ...v, value: e.target.value };
                                setDraft({ ...draft, env: next });
                              }}
                            />
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Status:</span>
                                {v.source === 'vault' ? (
                                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.15)', color: 'var(--green, #10b981)' }}>
                                    vault
                                  </span>
                                ) : v.source === 'env' ? (
                                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.15)', color: 'var(--blue, #3b82f6)' }}>
                                    env ({v.envFallback || 'captured'})
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: 'var(--red, #ef4444)' }}>
                                    missing
                                  </span>
                                )}

                                {editingId && v.key.trim() && (
                                  <>
                                    <input
                                      type="password"
                                      className="modal-input"
                                      style={{ flex: 1, minWidth: 160 }}
                                      placeholder="Set new secret value…"
                                      autoComplete="off"
                                      value={secretDrafts[slot] ?? ''}
                                      disabled={!vaultAvailable || isBusy}
                                      onChange={(e) =>
                                        setSecretDrafts((prev) => ({ ...prev, [slot]: e.target.value }))
                                      }
                                    />
                                    <button
                                      type="button"
                                      className="modal-btn primary"
                                      disabled={!vaultAvailable || !secretDrafts[slot] || isBusy}
                                      onClick={() => void handleSaveSecret(editingId, 'env', v.key, secretDrafts[slot])}
                                    >
                                      {isBusy ? 'Saving…' : 'Save'}
                                    </button>
                                    {v.configured && (
                                      <button
                                        type="button"
                                        className="modal-btn danger"
                                        disabled={isBusy}
                                        onClick={() => void handleClearSecret(editingId, 'env', v.key)}
                                      >
                                        Clear
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>

                              <input
                                type="text"
                                className="modal-input"
                                placeholder="envFallback e.g. TIERWYN_MCP_GITHUB_TOKEN"
                                value={v.envFallback ?? ''}
                                onChange={(e) => {
                                  const next = [...draft.env];
                                  next[idx] = { ...v, envFallback: e.target.value };
                                  setDraft({ ...draft, env: next });
                                }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <div className="modal-field">
                    <span className="modal-label">Endpoint URL</span>
                    <input
                      type="text"
                      className="modal-input"
                      value={draft.url}
                      placeholder="https://example.com/mcp"
                      onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    />
                  </div>

                  {/* Headers */}
                  <div className="modal-field">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="modal-label">Headers</span>
                      <button
                        type="button"
                        className="modal-btn"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            headers: [...draft.headers, { key: '', secret: false, value: '' }],
                          })
                        }
                      >
                        + Add header
                      </button>
                    </div>

                    {draft.headers.map((h, idx) => {
                      const slot = `header:${h.key}`;
                      const isBusy = secretBusy === slot;
                      return (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            marginTop: 8,
                            padding: 8,
                            borderRadius: 6,
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              className="modal-input"
                              style={{ flex: 1, minWidth: 140 }}
                              placeholder="Header-Name"
                              value={h.key}
                              onChange={(e) => {
                                const next = [...draft.headers];
                                next[idx] = { ...h, key: e.target.value };
                                setDraft({ ...draft, headers: next });
                              }}
                            />
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={h.secret}
                                onChange={(e) => {
                                  const isSecret = e.target.checked;
                                  const next = [...draft.headers];
                                  next[idx] = {
                                    ...h,
                                    secret: isSecret,
                                    value: isSecret ? undefined : (h.value ?? ''),
                                    envFallback: isSecret ? (h.envFallback ?? '') : undefined,
                                  };
                                  setDraft({ ...draft, headers: next });
                                }}
                              />
                              Secret
                            </label>
                            <button
                              type="button"
                              className="modal-btn danger"
                              onClick={() => {
                                const next = draft.headers.filter((_, i) => i !== idx);
                                setDraft({ ...draft, headers: next });
                              }}
                            >
                              ✕
                            </button>
                          </div>

                          {!h.secret ? (
                            <input
                              type="text"
                              className="modal-input"
                              placeholder="Header value"
                              value={h.value ?? ''}
                              onChange={(e) => {
                                const next = [...draft.headers];
                                next[idx] = { ...h, value: e.target.value };
                                setDraft({ ...draft, headers: next });
                              }}
                            />
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Status:</span>
                                {h.source === 'vault' ? (
                                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.15)', color: 'var(--green, #10b981)' }}>
                                    vault
                                  </span>
                                ) : h.source === 'env' ? (
                                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.15)', color: 'var(--blue, #3b82f6)' }}>
                                    env ({h.envFallback || 'captured'})
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: 'var(--red, #ef4444)' }}>
                                    missing
                                  </span>
                                )}

                                {editingId && h.key.trim() && (
                                  <>
                                    <input
                                      type="password"
                                      className="modal-input"
                                      style={{ flex: 1, minWidth: 160 }}
                                      placeholder="Set new secret value…"
                                      autoComplete="off"
                                      value={secretDrafts[slot] ?? ''}
                                      disabled={!vaultAvailable || isBusy}
                                      onChange={(e) =>
                                        setSecretDrafts((prev) => ({ ...prev, [slot]: e.target.value }))
                                      }
                                    />
                                    <button
                                      type="button"
                                      className="modal-btn primary"
                                      disabled={!vaultAvailable || !secretDrafts[slot] || isBusy}
                                      onClick={() => void handleSaveSecret(editingId, 'header', h.key, secretDrafts[slot])}
                                    >
                                      {isBusy ? 'Saving…' : 'Save'}
                                    </button>
                                    {h.configured && (
                                      <button
                                        type="button"
                                        className="modal-btn danger"
                                        disabled={isBusy}
                                        onClick={() => void handleClearSecret(editingId, 'header', h.key)}
                                      >
                                        Clear
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>

                              <input
                                type="text"
                                className="modal-input"
                                placeholder="envFallback e.g. TIERWYN_MCP_API_KEY"
                                value={h.envFallback ?? ''}
                                onChange={(e) => {
                                  const next = [...draft.headers];
                                  next[idx] = { ...h, envFallback: e.target.value };
                                  setDraft({ ...draft, headers: next });
                                }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Injectable Adapter Filter */}
              <div className="modal-field">
                <span className="modal-label">Inject into agent adapters</span>
                <SelectDropdown
                  options={INJECTABLE_OPTIONS}
                  multiple
                  value={draft.agentTypes}
                  onChange={(agentTypes) => setDraft({ ...draft, agentTypes })}
                  placeholder="All injectable adapters"
                  placement="top"
                />
                <div className="modal-hint">
                  Leave empty to make this server available to every injectable adapter.
                </div>
              </div>

              {/* Allow in Delegating Chats */}
              <div
                className="modal-field"
                style={{
                  padding: 10,
                  borderRadius: 6,
                  background: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="modal-label" style={{ color: 'var(--amber, #f59e0b)', margin: 0 }}>
                    Allow in delegating chats
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.allowInDelegating}
                    className={`toggle-switch${draft.allowInDelegating ? ' on' : ''}`}
                    onClick={() => setDraft({ ...draft, allowInDelegating: !draft.allowInDelegating })}
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
                <div className="modal-hint" style={{ marginTop: 6, color: 'var(--text-2)' }}>
                  Caution: Autonomous child delegates spawned in this chat can execute tools and read secrets on this server. Tierwyn keeps this off by default for security.
                </div>
              </div>

              {/* Enabled Switch */}
              <div className="modal-field modal-field-row">
                <span className="modal-label">Enabled</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.enabled}
                  className={`toggle-switch${draft.enabled ? ' on' : ''}`}
                  onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="modal-btn" onClick={closeEditor} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="modal-btn primary" onClick={() => void handleSaveDraft()} disabled={saving}>
                {saving ? 'Saving…' : 'Save server'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete MCP Server"
          body={`Are you sure you want to delete "${deleteTarget}"? Any secret credentials stored in the vault for this server will also be cleared.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => void handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* ── Native Install Dialog ───────────────────────────────────── */}
      {installServer && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setInstallServer(null)}
        >
          <div
            className="modal-content"
            style={{ maxWidth: 540, width: '92vw', maxHeight: '90vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span>Install to native config: {installServer.id}</span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setInstallServer(null)}
                title="Close"
              >
                ✕
              </button>
            </div>

            {installError && (
              <div className="usage-error" style={{ margin: '12px 16px 0' }}>
                {installError}
              </div>
            )}

            {installResult ? (
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ color: 'var(--green, #10b981)', fontWeight: 600 }}>
                  Installed &ldquo;{installResult.entry.name}&rdquo; into {installResult.agentType} native config!
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>Config file:</div>
                  <code style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--text-1)' }}>
                    {installResult.file}
                  </code>
                </div>
                {installResult.backup && (
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>Backup created:</div>
                    <code style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--text-2)' }}>
                      {installResult.backup}
                    </code>
                  </div>
                )}
                {installResult.overwrote && (
                  <div className="modal-hint" style={{ color: 'var(--amber, #f59e0b)' }}>
                    Overwrote existing native entry with the same name.
                  </div>
                )}
                {installResult.placeholderVars && installResult.placeholderVars.length > 0 && (
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 6,
                      background: 'rgba(59, 130, 246, 0.1)',
                      border: '1px solid rgba(59, 130, 246, 0.3)',
                      color: 'var(--text-1)',
                      fontSize: 12,
                    }}
                  >
                    <strong>Notice:</strong> export these environment variables for {installResult.agentType}:{' '}
                    <code style={{ fontWeight: 600 }}>{installResult.placeholderVars.join(', ')}</code> (they are
                    required at the agent CLI&apos;s runtime).
                  </div>
                )}
              </div>
            ) : (
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="modal-field">
                  <span className="modal-label">Agent CLI</span>
                  <SelectDropdown
                    options={WRITABLE_AGENT_OPTIONS}
                    value={installAgent}
                    onChange={(a) => setInstallAgent(a)}
                    placement="bottom"
                  />
                </div>

                <div className="modal-field">
                  <span className="modal-label">Scope</span>
                  <SelectDropdown
                    options={[
                      { value: 'user', label: 'User scope (global)' },
                      { value: 'project', label: 'Project scope' },
                    ]}
                    value={installScope}
                    onChange={(s) => setInstallScope(s as McpNativeWriteScope)}
                    placement="bottom"
                  />
                </div>

                {installScope === 'project' && (
                  <div className="modal-field">
                    <span className="modal-label">Project</span>
                    <SelectDropdown
                      options={projects.map((p) => ({ value: p.id, label: p.name }))}
                      value={installProject}
                      onChange={(p) => setInstallProject(p)}
                      placement="bottom"
                    />
                    <div className="modal-hint" style={{ marginTop: 6, color: 'var(--amber, #f59e0b)' }}>
                      this writes a file into the project checkout (visible in git)
                    </div>
                  </div>
                )}

                {(installServer.env.some((e) => e.secret) || installServer.headers.some((h) => h.secret)) &&
                  installAgent !== 'claude-code' && (
                    <div
                      className="modal-field"
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        background: 'rgba(245, 158, 11, 0.08)',
                        border: '1px solid rgba(245, 158, 11, 0.25)',
                      }}
                    >
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          cursor: 'pointer',
                          fontWeight: 500,
                          fontSize: 13,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={copySecrets}
                          onChange={(e) => setCopySecrets(e.target.checked)}
                        />
                        Copy secret values into agent config
                      </label>
                      <div className="modal-hint" style={{ marginTop: 6, color: 'var(--amber, #f59e0b)' }}>
                        secret values will be copied into the agent&apos;s config file (mode 0600)
                      </div>
                    </div>
                  )}
              </div>
            )}

            <div className="modal-footer">
              {installResult ? (
                <button
                  type="button"
                  className="modal-btn primary"
                  onClick={() => setInstallServer(null)}
                >
                  Done
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => setInstallServer(null)}
                    disabled={installing}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="modal-btn primary"
                    onClick={() => void handleInstall()}
                    disabled={installing || (installScope === 'project' && !installProject)}
                  >
                    {installing ? 'Installing…' : 'Install'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {removeTarget && (
        <ConfirmDialog
          title="Remove Native MCP Entry"
          body={`Are you sure you want to remove "${removeTarget.name}" from ${nativeAgent}'s native config? A backup file will be created.`}
          confirmLabel={removing ? 'Removing…' : 'Remove'}
          danger
          busy={removing}
          onConfirm={() => void handleRemove(removeTarget)}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
