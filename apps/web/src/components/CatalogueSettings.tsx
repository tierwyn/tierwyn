import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SANDBOX_SETTINGS_DEFAULTS,
  isRemoteLoginAgent,
  resolveSandbox,
  type AgentRecord,
  type AgentsBatchState,
  type CommandRecord,
  type InstallAllSkip,
  type ModelRecord,
  type SandboxSettings,
  type UpdateCommandRequest,
} from '@tierwyn/shared';
import { api, type AgentEnvList, type AgentEnvVar } from '../api.js';
import { isValidEnvName, relativeEnvTime } from '../agentEnvName.js';
import {
  loginAgentLabel,
  loginResumeKey,
  loginResumeMessage,
  notLoggedInTitle,
  shouldShowLoginModal,
  shouldShowLoginResume,
  type LoginActions,
} from '../remoteHostAgents.js';
import { AgentLoginModalFor } from './AgentLoginModalFor.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

const HUB = 'hub';

interface Props {
  onClose: () => void;
  /** Called after any change so the parent can re-fetch /profiles (selector refresh). */
  onChanged: () => void;
  /** Render without the drawer overlay — content only, for embedding in another modal. */
  embedded?: boolean;
  /** Incrementing version or timestamp from WebSocket catalogue_updated frames to trigger live reload. */
  catalogueVersion?: number;
}

type HealthStatus = 'not-installed' | 'needs-setup' | 'ready';

const STATUS_CLASS: Record<HealthStatus, string> = {
  'ready':          'catalogue-status-ready',
  'needs-setup':    'catalogue-status-needs-setup',
  'not-installed':  'catalogue-status-not-installed',
};

const DOT_CLASS: Record<HealthStatus, string> = {
  'ready':          's-ready',
  'needs-setup':    's-needs-setup',
  'not-installed':  's-not-installed',
};

/** Sentinel value meaning "show all agents". */
const ALL = '__all__';
const BULK_BUSY = '__bulk__';
const MODEL_SEARCH_DEBOUNCE_MS = 1500;

const PHONE_MQ = '(max-width: 600px), (max-height: 500px) and (orientation: landscape)';
function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE_MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MQ);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

/** Split a search string into terms; double-quoted segments stay intact. */
function splitSearchTerms(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    terms.push((m[1] ?? m[2]).trim());
  }
  return terms.filter(Boolean);
}

/** Match one term against text — regex when valid, else case-insensitive substring. */
function termMatches(text: string, term: string): boolean {
  try {
    return new RegExp(term, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(term.toLowerCase());
  }
}

function modelMatchesQuery(m: ModelRecord, agentLabel: string, q: string): boolean {
  const terms = splitSearchTerms(q.trim());
  if (terms.length === 0) return true;
  const fields = [m.label, m.modelName, agentLabel];
  return terms.every((term) => fields.some((field) => termMatches(field, term)));
}

function parseSpawnCap(raw: string): number | null | 'invalid' {
  const t = raw.trim();
  if (t === '') return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) return 'invalid';
  return v;
}

type BulkTriState = '' | 'on' | 'off';

const bulkVisionOptions: SelectDropdownOption<BulkTriState>[] = [
  { value: '', label: '👁 —' },
  { value: 'on', label: '👁 on' },
  { value: 'off', label: '👁 off' },
];

const bulkSteerOptions: SelectDropdownOption<BulkTriState>[] = [
  { value: '', label: '⇄ —' },
  { value: 'on', label: '⇄ on' },
  { value: 'off', label: '⇄ off' },
];

interface BulkModelPatch {
  spawns: number | null;
  grand: number | null;
  vision: boolean | null;
  steer: boolean | null;
}

function parseTriState(v: BulkTriState): boolean | null {
  if (v === 'on') return true;
  if (v === 'off') return false;
  return null;
}

function patchHasChanges(p: BulkModelPatch): boolean {
  return p.spawns !== null || p.grand !== null || p.vision !== null || p.steer !== null;
}

function groupTargetsByAgent(
  targets: ModelRecord[],
  agentById: Map<string, AgentRecord>,
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of targets) {
    counts.set(m.agentId, (counts.get(m.agentId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([agentId, count]) => ({
      label: agentById.get(agentId)?.label ?? agentId,
      count,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function AgentEnvSection({
  agentType,
  vars,
  vaultAvailable,
  vaultUnavailableReason,
  sandboxOff,
  onChanged,
}: {
  agentType: string;
  vars: AgentEnvVar[];
  vaultAvailable: boolean;
  vaultUnavailableReason?: string;
  sandboxOff: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const writesOff = !vaultAvailable || busy;

  const save = async () => {
    const n = name.trim().toUpperCase();
    if (!isValidEnvName(n) || !value.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.setAgentEnv(agentType, n, value);
      setName(''); setValue('');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (n: string) => {
    setBusy(true); setErr(null);
    try {
      await api.clearAgentEnv(agentType, n);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="catalogue-env-block">
      <div className="catalogue-config-label">Encrypted environment (vault)</div>
      <div className="modal-hint">
        API keys in the vault are scrubbed from every other spawn and injected only into this agent type.
        Enable sandbox for full isolation (see SECURITY.md § Per-agent env vault).
        After saving, delete the same name from prod.env.
      </div>
        {!vaultAvailable && (
          <div className="catalogue-env-warn">Vault unavailable{vaultUnavailableReason ? `: ${vaultUnavailableReason}` : ''}</div>
        )}
        {vars.length > 0 && sandboxOff && (
          <div className="catalogue-env-warn">
            Unsandboxed: this agent can read prod.env + prod.db and decrypt every vault secret.
          </div>
        )}
        {vars.map((v) => (
          <div key={v.name} className="catalogue-env-row">
            <span className="catalogue-env-name">{v.name}</span>
            <span className="catalogue-env-meta">set {relativeEnvTime(v.updatedAt)}</span>
            <button
              type="button"
              className="catalogue-pull-btn"
              disabled={writesOff}
              onClick={() => { setName(v.name); setValue(''); valueRef.current?.focus(); }}
            >Replace</button>
            <button
              type="button"
              className="catalogue-model-delete-btn"
              disabled={writesOff}
              onClick={() => void clear(v.name)}
            >Clear</button>
          </div>
        ))}
        <div className="catalogue-env-add">
          <input
            className="catalogue-config-input"
            placeholder="NAME"
            autoComplete="off"
            spellCheck={false}
            disabled={writesOff}
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
          />
          <input
            ref={valueRef}
            className="catalogue-config-input"
            type="password"
            autoComplete="off"
            placeholder="value"
            disabled={writesOff}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            className="catalogue-pull-btn"
            disabled={writesOff || !isValidEnvName(name.trim()) || !value.trim()}
            onClick={() => void save()}
          >Save</button>
        </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

/** Classify an agent's health for status badge rendering. */
function agentHealthStatus(a: AgentRecord, totalModels: number): HealthStatus {
  if (!a.installed) return 'not-installed';
  if (totalModels === 0) return 'needs-setup';
  return 'ready';
}

function statusLabel(status: HealthStatus, enabledCount: number, totalModels: number): string {
  if (status === 'ready') return `${enabledCount}/${totalModels} model${totalModels === 1 ? '' : 's'}`;
  if (status === 'needs-setup') return 'needs cli setup';
  return 'not installed';
}

function optionMeta(status: HealthStatus, enabledCount: number, totalModels: number): string {
  if (status === 'ready') return `${enabledCount}/${totalModels} model${totalModels === 1 ? '' : 's'}`;
  if (status === 'needs-setup') return 'no models';
  return 'not installed';
}

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago" — for the last version check. */
function agoLabel(at: number): string {
  const s = Math.max(0, Date.now() - at) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Last non-empty line of a failed install's output, truncated (mirrors remoteHostAgents). */
function lastErrorLine(tail: string | undefined): string | undefined {
  const lines = tail?.split('\n').filter((l) => l.trim() !== '') ?? [];
  return lines.length ? lines[lines.length - 1].slice(-300) : undefined;
}

interface SelectOption {
  id: string;        // ALL or agent.id
  label: string;     // display name
  status: HealthStatus | 'all';
  meta: string;
  modelNames: string[];
  /** Hub knows a newer version than the agent's installed one. */
  behind: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
}

/**
 * Searchable agent dropdown. Reuses the app's `.ms-*` design tokens. Offers an
 * "All agents" entry plus one row per agent, each with a status dot and a
 * short meta string (enabled/total models / "no models" / "not installed"). Opens
 * downward, supports keyboard nav, search, and click-outside-to-close.
 */
function AgentSelect({
  options,
  value,
  onChange,
}: {
  options: SelectOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const selected = options.find((o) => o.id === value) ?? options[0];

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery('');
      const idx = options.findIndex((o) => o.id === value);
      setHighlighted(idx >= 0 ? idx : 0);
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll highlighted into view
  useEffect(() => {
    if (open) itemRefs.current[highlighted]?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, open]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      if (o.id === ALL) {
        return o.label.toLowerCase().includes(q);
      }
      return (
        o.label.toLowerCase().includes(q) ||
        o.modelNames.some((name) => name.includes(q)) ||
        (o.behind && (q.includes('behind') || q.includes('update')))
      );
    });
  }, [options, query]);

  const pick = useCallback((id: string) => {
    onChange(id);
    setOpen(false);
  }, [onChange]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    // stopPropagation on Escape so the drawer's window-level Escape
    // listener doesn't also fire and close the whole drawer.
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setHighlighted((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setHighlighted((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const o = filtered[highlighted]; if (o) pick(o.id); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  }, [open, filtered, highlighted, pick]);

  const selectedDot = selected?.status === 'all' ? 's-all' : selected ? DOT_CLASS[selected.status] : '';

  return (
    <div ref={wrapperRef} className="model-selector" onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`ms-trigger${open ? ' ms-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`catalogue-agent-option-dot ${selectedDot}`} />
        <span className="ms-trigger-label">{selected?.label ?? 'Select…'}</span>
        {selected?.behind === true && (
          <span
            className="catalogue-version-badge-behind"
            title={selected.latestVersion
              ? `installed ${selected.installedVersion ?? '?'} · latest ${selected.latestVersion}`
              : 'update available'}
          >
            ↑
          </span>
        )}
        <span className="ms-chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="ms-panel ms-panel--bottom" role="listbox" style={{ minWidth: '100%' }}>
          <div className="ms-search-row">
            <input
              ref={searchRef}
              className="ms-search"
              placeholder="Search agents…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlighted(0); }}
            />
          </div>
          <div className="ms-list">
            {filtered.length === 0 && <div className="ms-empty">No agents match “{query}”.</div>}
            {filtered.map((o, idx) => {
              const isSel = o.id === value;
              const cls = o.status === 'all' ? 's-all' : DOT_CLASS[o.status];
              return (
                <div
                  key={o.id}
                  ref={(el) => { itemRefs.current[idx] = el; }}
                  className={`ms-item${idx === highlighted ? ' ms-item--hi' : ''}${isSel ? ' ms-item--sel' : ''}`}
                  role="option"
                  aria-selected={isSel}
                  onMouseDown={() => pick(o.id)}
                  onMouseEnter={() => setHighlighted(idx)}
                >
                  {isSel && <span className="ms-check">✓</span>}
                  <span className="catalogue-agent-option">
                    <span className={`catalogue-agent-option-dot ${cls}`} />
                    <span className="catalogue-agent-option-name">{o.label}</span>
                    {o.installedVersion && (
                      <span className="catalogue-agent-option-version" title={`installed v${o.installedVersion}`}>
                        v{o.installedVersion}
                      </span>
                    )}
                    {o.behind && (
                      <span
                        className="catalogue-version-badge-behind"
                        title={o.latestVersion
                          ? `installed ${o.installedVersion ?? '?'} · latest ${o.latestVersion}`
                          : 'update available'}
                      >
                        ↑
                      </span>
                    )}
                    <span className="catalogue-agent-option-meta">{o.meta}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ModelSelector expects labels as "Agent · Model". Same rule as edit-blur
 * and server createModel — bare add-form labels get the agent prefix.
 */
function withAgentLabelPrefix(agentLabel: string, label: string): string {
  const raw = label.trim();
  if (!raw) return raw;
  const prefix = `${agentLabel} · `;
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
}

/** Inline add-model form — replaces window.prompt for all agents. */
function AddModelForm({
  agentId,
  agentLabel,
  onAdded,
}: {
  agentId: string;
  agentLabel: string;
  onAdded: () => void;
}) {
  const [modelName, setModelName] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = modelName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const baseLabel = label.trim() || name;
      await api.createModel(agentId, {
        modelName: name,
        label: withAgentLabelPrefix(agentLabel, baseLabel),
        enabled: true,
      });
      setModelName('');
      setLabel('');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="catalogue-add-form" onSubmit={submit}>
      <input
        className="catalogue-add-input"
        value={modelName}
        onChange={(e) => setModelName(e.target.value)}
        placeholder="Model ID (e.g. claude-opus-4-5)"
        disabled={busy}
      />
      <input
        className="catalogue-add-input catalogue-add-input-sm"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (optional)"
        disabled={busy}
      />
      <button className="catalogue-add-btn" type="submit" disabled={busy || !modelName.trim()}>
        {busy ? 'Adding…' : 'Add'}
      </button>
      {error && <span className="catalogue-add-error">{error}</span>}
    </form>
  );
}

function AgentCommands({ agentId }: { agentId: string }) {
  const [commands, setCommands] = useState<CommandRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    const list = await api.listCommands(agentId, { includeDisabled: true });
    setCommands(list);
    setLoaded(true);
  }, [agentId]);

  useEffect(() => {
    if (open && !loaded) {
      void load().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoaded(true);
      });
    }
  }, [open, loaded, load]);

  const patch = async (c: CommandRecord, p: UpdateCommandRequest) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateCommand(agentId, c.id, p);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: CommandRecord) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteCommand(agentId, c.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      await api.createCommand(agentId, { name: n, description: description.trim() || undefined });
      setName('');
      setDescription('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...commands].sort((a, b) =>
    (a.source === 'user' ? 0 : 1) - (b.source === 'user' ? 0 : 1) || a.name.localeCompare(b.name),
  );

  return (
    <details
      className="catalogue-config-details"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Slash commands</summary>
      <div className="catalogue-config-body">
        {loaded && sorted.length === 0 && (
          <div className="catalogue-models-empty">
            No commands yet. Add one below, or use &ldquo;Pull models&rdquo; — command discovery runs on the same schedule.
          </div>
        )}
        {sorted.map((c) => (
          <div key={c.id} className="catalogue-model-row">
            <button
              type="button"
              role="switch"
              aria-checked={c.enabled}
              className={`toggle-switch${c.enabled ? ' on' : ''}`}
              onClick={() => patch(c, { enabled: !c.enabled })}
              title={c.enabled ? 'enabled' : 'disabled'}
              disabled={busy}
              style={{ scale: '0.85', transformOrigin: 'left center', marginRight: '-2px' }}
            >
              <span className="toggle-knob" />
            </button>
            {c.source === 'user' ? (
              <input
                className="catalogue-command-name-input"
                defaultValue={c.name}
                title="command name"
                disabled={busy}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (!v || v === c.name) return;
                  void patch(c, { name: v });
                }}
              />
            ) : (
              <span className="catalogue-command-name-input">/{c.name}</span>
            )}
            <input
              className="catalogue-model-label-input"
              defaultValue={c.description}
              placeholder="description"
              disabled={c.source !== 'user' || busy}
              onBlur={(e) => {
                if (c.source !== 'user') return;
                const v = e.target.value.trim();
                if (v === c.description) return;
                void patch(c, { description: v });
              }}
            />
            <span className="catalogue-command-source">{c.source}</span>
            {c.source === 'user' && (
              <button
                className="catalogue-model-delete-btn"
                title="delete command"
                disabled={busy}
                onClick={() => { if (window.confirm(`Delete command "/${c.name}"?`)) void remove(c); }}
              >×</button>
            )}
          </div>
        ))}
        <form className="catalogue-add-form" onSubmit={submit}>
          <input
            className="catalogue-add-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Command name (e.g. deploy)"
            disabled={busy}
          />
          <input
            className="catalogue-add-input catalogue-add-input-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            disabled={busy}
          />
          <button className="catalogue-add-btn" type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
          {error && <span className="catalogue-add-error">{error}</span>}
        </form>
      </div>
    </details>
  );
}

/**
 * Agents & Models drawer. A searchable dropdown at the top lets the operator
 * jump to a single agent or keep "All agents" to see the full scrollable
 * list. Each card shows a health-status badge, a model list with
 * enable/disable/delete controls, and an inline add-model form.
 */
export function CatalogueSettings({ onClose, onChanged, embedded = false, catalogueVersion }: Props) {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [upgradeBusy, setUpgradeBusy] = useState<string | null>(null);
  const [bulkToggleBusy, setBulkToggleBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(ALL);
  const [globalModelSearch, setGlobalModelSearch] = useState('');
  const [debouncedModelSearch, setDebouncedModelSearch] = useState('');
  const [bulkSpawns, setBulkSpawns] = useState('');
  const [bulkGrand, setBulkGrand] = useState('');
  const [bulkVision, setBulkVision] = useState<BulkTriState>('');
  const [bulkSteer, setBulkSteer] = useState<BulkTriState>('');
  const [bulkConfirm, setBulkConfirm] = useState<{
    targets: ModelRecord[];
    patch: BulkModelPatch;
  } | null>(null);
  const [batch, setBatch] = useState<AgentsBatchState | undefined>(undefined);
  const [versionsRefreshing, setVersionsRefreshing] = useState(false);
  const [installAllConfirm, setInstallAllConfirm] = useState<{
    targets: string[];
    skipped: InstallAllSkip[];
    manual: string[];
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [agentEnv, setAgentEnv] = useState<AgentEnvList | null>(null);
  const [sandboxDoc, setSandboxDoc] = useState<SandboxSettings>(SANDBOX_SETTINGS_DEFAULTS);
  const [loginPrimed, setLoginPrimed] = useState(false);
  const [loginLoadKeys, setLoginLoadKeys] = useState<Set<string>>(() => new Set());
  const [loginOpened, setLoginOpened] = useState<Set<string>>(() => new Set());
  const [loginDismissed, setLoginDismissed] = useState<Set<string>>(() => new Set());
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const isPhone = useIsPhone();
  const phoneAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPhone) return;
    phoneAnchorRef.current?.scrollIntoView({ block: 'start' });
  }, [isPhone, selectedId]);

  const reloadEnv = useCallback(() => {
    api.getAgentEnv().then(setAgentEnv).catch(() => { /* drawer still usable */ });
  }, []);

  const reload = useCallback(async () => {
    const c = await api.getCatalogue();
    setAgents(c.agents);
    setModels(c.models);
    setBatch(c.batch);
    setVersionsRefreshing(c.versionsRefreshing === true);
    onChanged();
  }, [onChanged]);

  useEffect(() => {
    api.getCatalogue()
      .then((c) => {
        setAgents(c.agents);
        setModels(c.models);
        setBatch(c.batch);
        setVersionsRefreshing(c.versionsRefreshing === true);
        setLoginLoadKeys(new Set(
          c.agents.filter((a) => a.login).map((a) => loginResumeKey(HUB, a.type)),
        ));
        setLoginPrimed(true);
      })
      .catch(() => {
        setLoginPrimed(true);
        /* transient — the WS-triggered reload retries */
      });
    reloadEnv();
    api.getSandboxSettings().then(setSandboxDoc).catch(() => { /* defaults stay */ });
  }, [reloadEnv]);

  useEffect(() => {
    if (catalogueVersion !== undefined && catalogueVersion > 0) {
      void reload();
    }
  }, [catalogueVersion, reload]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedModelSearch(globalModelSearch), MODEL_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [globalModelSearch]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pull = useCallback(async (agentId: string) => {
    setBusy(agentId);
    setError(null);
    try { await api.pullModels(agentId); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, [reload]);

  const upgrade = useCallback(async (agentId: string) => {
    setUpgradeBusy(agentId);
    setError(null);
    try {
      await api.upgradeAgent(agentId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setUpgradeBusy(null);
    }
  }, [reload]);

  const loginGate = (agentType: string) => ({
    hostId: HUB,
    agentType,
    primed: loginPrimed,
    loadKeys: loginLoadKeys,
    opened: loginOpened,
    dismissed: loginDismissed,
  });

  const localActions = (type: string): LoginActions => ({
    cancel: () => api.cancelLocalAgentLogin(type),
    retry: () => api.loginLocalAgent(type),
    submitCode: (c) => api.submitLocalAgentLoginCode(type, c),
  });

  const startLogin = (type: string) => {
    setError(null);
    setLoginOpened((s) => new Set(s).add(loginResumeKey(HUB, type)));
    api.loginLocalAgent(type)
      .then(() => reload())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const reopenLogin = (type: string) => {
    setLoginOpened((s) => new Set(s).add(loginResumeKey(HUB, type)));
  };

  const restartLogin = (type: string) => {
    setLoginOpened((s) => new Set(s).add(loginResumeKey(HUB, type)));
    api.cancelLocalAgentLogin(type).catch(() => {}).then(() => startLogin(type));
  };

  const dismissLogin = (type: string, running: boolean) => {
    setLoginDismissed((s) => new Set(s).add(loginResumeKey(HUB, type)));
    if (!running) api.cancelLocalAgentLogin(type).catch(() => {});
  };

  /** Fire-and-forget on the server; completion lands via catalogue_updated → reload. */
  const checkVersions = useCallback(() => {
    setError(null);
    setNotice(null);
    api.refreshAgentVersions()
      .then(() => setVersionsRefreshing(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const startInstallAll = useCallback(() => {
    setError(null);
    setNotice(null);
    const targets = agents
      .filter((a) => a.upgradeable && (!a.installed || a.behind === true) && !a.upgrading)
      .map((a) => a.id);
    if (!targets.length) return;
    setInstallAllConfirm({
      targets,
      skipped: [],
      manual: agents.filter((a) => !a.installed && !a.upgradeable).map((a) => a.label),
    });
  }, [agents]);

  const runInstallAll = useCallback(async () => {
    if (!installAllConfirm) return;
    setInstallAllConfirm(null);
    setError(null);
    try {
      const r = await api.installAllAgents('missing+behind');
      if (r.started && r.skipped.length) {
        setNotice(`Skipped: ${r.skipped.map((s) => `${s.type} (${s.reason})`).join(', ')}`);
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [installAllConfirm, reload]);

  const patchAgent = useCallback(async (id: string, patch: Parameters<typeof api.updateAgent>[1]) => {
    await api.updateAgent(id, patch); await reload();
  }, [reload]);

  const patchModel = useCallback(async (id: string, patch: Parameters<typeof api.updateModel>[1]) => {
    await api.updateModel(id, patch); await reload();
  }, [reload]);

  const setAgentModelsEnabled = useCallback(async (agentId: string, models: Array<{ id: string; enabled: boolean }>, enabled: boolean) => {
    const targets = models.filter((m) => m.enabled !== enabled);
    if (targets.length === 0) return;
    setBulkToggleBusy(agentId);
    setError(null);
    try {
      await Promise.all(targets.map((m) => api.updateModel(m.id, { enabled })));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkToggleBusy(null);
    }
  }, [reload]);

  const toggleAgent = async (a: AgentRecord) => {
    try {
      setError(null);
      await api.updateAgent(a.id, { enabled: !a.enabled });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeModel = useCallback(async (id: string) => {
    await api.deleteModel(id); await reload();
  }, [reload]);

  const applyBulkPatch = useCallback(async (targets: ModelRecord[], patch: BulkModelPatch) => {
    if (!patchHasChanges(patch)) return;
    setBusy(BULK_BUSY);
    setError(null);
    try {
      await Promise.all(
        targets.map((m) => {
          const req: Parameters<typeof api.updateModel>[1] = {};
          if (patch.spawns !== null) req.maxConcurrentSpawns = patch.spawns;
          if (patch.grand !== null) req.maxGrandchildSpawns = patch.grand;
          if (patch.vision !== null) req.vision = patch.vision;
          if (patch.steer !== null) req.steer = patch.steer;
          return api.updateModel(m.id, req);
        }),
      );
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [reload]);

  // Build dropdown options: "All agents" first, then one per agent (sorted).
  const options = useMemo<SelectOption[]>(() => {
    const agentOpts = agents
      .map((a) => {
        const agentModels = models.filter((m) => m.agentId === a.id);
        const count = agentModels.length;
        const enabledCount = agentModels.filter((m) => m.enabled).length;
        const status = agentHealthStatus(a, count);
        const modelNames = agentModels.flatMap((m) => [
          m.label.toLowerCase(),
          m.modelName.toLowerCase(),
        ]);
        return {
          id: a.id,
          label: a.label,
          status,
          meta: optionMeta(status, enabledCount, count),
          modelNames,
          behind: a.behind === true,
          installedVersion: a.installedVersion ?? null,
          latestVersion: a.latestVersion ?? null,
        };
      })
      .sort((x, y) => x.label.localeCompare(y.label));
    const installedCount = agents.filter((a) => a.installed).length;
    const behindCount = agents.filter((a) => a.behind === true).length;
    const allOption: SelectOption = {
      id: ALL,
      label: 'All agents',
      status: 'all',
      meta: `${installedCount}/${agents.length} installed${behindCount > 0 ? ` · ${behindCount} behind` : ''}`,
      modelNames: [],
      behind: false,
      installedVersion: null,
      latestVersion: null,
    };
    return [allOption, ...agentOpts];
  }, [agents, models]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const batchRunning = batch?.running === true;
  const installAllCount = agents.filter(
    (a) => a.upgradeable && (!a.installed || a.behind === true) && !a.upgrading,
  ).length;
  const lastCheckedAt = useMemo(() => {
    const ts = agents.map((a) => a.versionCheckedAt).filter((t): t is number => typeof t === 'number');
    return ts.length ? Math.max(...ts) : undefined;
  }, [agents]);

  const scopedModels = useMemo(() => {
    const q = debouncedModelSearch.trim();
    const pool = selectedId === ALL ? models : models.filter((m) => m.agentId === selectedId);
    return pool.filter((m) => {
      const agent = agentById.get(m.agentId);
      return modelMatchesQuery(m, agent?.label ?? '', q);
    });
  }, [models, selectedId, debouncedModelSearch, agentById]);

  const requestBulkApply = useCallback(() => {
    const spawns = parseSpawnCap(bulkSpawns);
    const grand = parseSpawnCap(bulkGrand);
    if (spawns === 'invalid' || grand === 'invalid') {
      setError('Concurrency values must be non-negative numbers');
      return;
    }
    const patch: BulkModelPatch = {
      spawns,
      grand,
      vision: parseTriState(bulkVision),
      steer: parseTriState(bulkSteer),
    };
    if (!patchHasChanges(patch)) return;
    if (scopedModels.length === 0) return;
    setBulkConfirm({ targets: scopedModels, patch });
  }, [bulkSpawns, bulkGrand, bulkVision, bulkSteer, scopedModels]);

  const visibleAgents = useMemo(() => {
    let list = selectedId === ALL ? agents : agents.filter((a) => a.id === selectedId);
    const q = debouncedModelSearch.trim();
    if (q && selectedId === ALL) {
      list = list.filter((a) => {
        const agentModels = models.filter((m) => m.agentId === a.id);
        return agentModels.some((m) => modelMatchesQuery(m, a.label, q));
      });
    }
    return list;
  }, [agents, models, selectedId, debouncedModelSearch]);

  const isFiltered = selectedId !== ALL;
  const bulkBusy = busy === BULK_BUSY;
  const searchQuery = debouncedModelSearch.trim();
  const searchPending = globalModelSearch.trim() !== searchQuery;

  const bulkHasInput =
    bulkSpawns.trim() !== '' ||
    bulkGrand.trim() !== '' ||
    bulkVision !== '' ||
    bulkSteer !== '';

  const searchRow = (
    <div className="catalogue-global-bulk-row">
      <input
        className="catalogue-add-input catalogue-global-search-input"
        placeholder="Search models… (multi-term, regex)"
        value={globalModelSearch}
        onChange={(e) => setGlobalModelSearch(e.target.value)}
      />
      <span className={`catalogue-spawn-bulk-label${searchPending ? ' catalogue-spawn-bulk-label--pending' : ''}`}>
        {searchPending ? '…' : `${scopedModels.length} target${scopedModels.length === 1 ? '' : 's'}`}
      </span>
    </div>
  );

  const versionsRow = (
    <div className="catalogue-versions-row">
      <button
        type="button"
        className="modal-btn"
        disabled={versionsRefreshing}
        title="Re-check installed and latest versions for all agents"
        onClick={checkVersions}
      >
        {versionsRefreshing ? 'Checking…' : 'Check for updates'}
      </button>
      <span
        className="catalogue-versions-checked"
        title={lastCheckedAt !== undefined ? new Date(lastCheckedAt).toLocaleString() : 'never checked'}
      >
        {lastCheckedAt !== undefined ? `checked ${agoLabel(lastCheckedAt)}` : 'never checked'}
      </span>
      <button
        type="button"
        className="modal-btn primary"
        disabled={batchRunning || installAllCount === 0}
        title="Install missing agents and update the ones behind latest — runs one install at a time"
        onClick={startInstallAll}
      >
        {batchRunning ? `Installing… (${batch?.remaining.length ?? 0} left)` : `Install & update all (${installAllCount})`}
      </button>
    </div>
  );

  const fieldsRow = (
    <div className="catalogue-global-bulk-row catalogue-global-bulk-row--fields">
      <input
        type="number"
        min={0}
        className="catalogue-model-spawn-input"
        placeholder="spawns"
        title="max concurrent sub-agents (blank = leave unchanged)"
        value={bulkSpawns}
        onChange={(e) => setBulkSpawns(e.target.value)}
        disabled={bulkBusy}
      />
      <input
        type="number"
        min={0}
        className="catalogue-model-spawn-input"
        placeholder="grand"
        title="max grandchildren (blank = leave unchanged)"
        value={bulkGrand}
        onChange={(e) => setBulkGrand(e.target.value)}
        disabled={bulkBusy}
      />
      <div className="catalogue-bulk-tristate" title="vision capable (— = leave unchanged)">
        <SelectDropdown<BulkTriState>
          options={bulkVisionOptions}
          value={bulkVision}
          onChange={setBulkVision}
          disabled={bulkBusy}
          placement="bottom"
        />
      </div>
      <div className="catalogue-bulk-tristate" title="steer capable (— = leave unchanged)">
        <SelectDropdown<BulkTriState>
          options={bulkSteerOptions}
          value={bulkSteer}
          onChange={setBulkSteer}
          disabled={bulkBusy}
          placement="bottom"
        />
      </div>
      <button
        type="button"
        className="modal-btn catalogue-spawn-bulk-apply"
        disabled={bulkBusy || scopedModels.length === 0 || !bulkHasInput || searchPending}
        onClick={requestBulkApply}
      >
        {bulkBusy ? 'Applying…' : 'Apply'}
      </button>
    </div>
  );

  const tools = (
    <>
      {versionsRow}
      {fieldsRow}
    </>
  );

  const inner = (
    <>
      {!embedded && (
        <div className="catalogue-drawer-header">
          <div className="catalogue-drawer-title">Agents &amp; Models</div>
          <button className="catalogue-drawer-close" onClick={onClose} title="Close" aria-label="Close">×</button>
        </div>
      )}

        <div className="catalogue-agent-selector">
          <AgentSelect options={options} value={selectedId} onChange={setSelectedId} />
          {isFiltered && (
            <button className="catalogue-agent-back" onClick={() => setSelectedId(ALL)} title="Show all agents">
              Show all
            </button>
          )}
        </div>

        {isPhone ? (
          <>
            <div className="catalogue-global-bulk">{searchRow}</div>
            <details className="catalogue-phone-tools">
              <summary>Tools · versions, bulk edit</summary>
              {tools}
            </details>
          </>
        ) : (
          <>
            {versionsRow}
            <div className="catalogue-global-bulk">
              <span className="modal-label">Bulk edit</span>
              {searchRow}
              {fieldsRow}
            </div>
          </>
        )}

        {error && <div className="catalogue-global-error">{error}</div>}
        {notice && <div className="catalogue-global-notice">{notice}</div>}

        {isPhone && selectedId !== ALL && (
          <div className="catalogue-phone-back" ref={phoneAnchorRef}>
            <button type="button" onClick={() => setSelectedId(ALL)}>‹ Agents</button>
            <span>{agentById.get(selectedId)?.label ?? selectedId}</span>
          </div>
        )}

        <div className="catalogue-drawer-body" ref={isPhone && selectedId === ALL ? phoneAnchorRef : undefined}>
          {visibleAgents.length === 0 ? (
            <div className="catalogue-agent-empty">
              {searchQuery ? `No models match "${searchQuery}".` : 'No agents found.'}
            </div>
          ) : isPhone && selectedId === ALL ? (
            visibleAgents.map((a) => {
              const agentModels = models.filter((m) => m.agentId === a.id);
              const enabledCount = agentModels.filter((m) => m.enabled).length;
              const status = agentHealthStatus(a, agentModels.length);
              return (
                <div key={a.id} className="catalogue-phone-agent-row">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={a.enabled}
                    aria-label={`${a.label} enabled`}
                    className={`toggle-switch${a.enabled ? ' on' : ''}`}
                    onClick={(e) => { e.stopPropagation(); void toggleAgent(a); }}
                    title={a.enabled ? 'agent enabled' : (a.installed ? 'agent disabled' : 'not installed')}
                  >
                    <span className="toggle-knob" />
                  </button>
                  <button
                    type="button"
                    className="catalogue-phone-agent-open"
                    onClick={() => setSelectedId(a.id)}
                  >
                    <span className={`catalogue-agent-option-dot ${DOT_CLASS[status]}`} />
                    <span className="catalogue-phone-agent-label">{a.label}</span>
                    {a.behind && (
                      <span className="catalogue-version-badge-behind">behind</span>
                    )}
                    <span className="catalogue-phone-agent-meta">
                      {a.installed ? `${enabledCount}/${agentModels.length} models` : 'not installed'}
                    </span>
                    <span className="catalogue-phone-agent-chevron" aria-hidden="true">›</span>
                  </button>
                </div>
              );
            })
          ) : (
            visibleAgents.map((a) => {
              const agentModels = models.filter((m) => m.agentId === a.id);
              const filteredModels = agentModels.filter((m) => modelMatchesQuery(m, a.label, searchQuery));
              const enabledCount = agentModels.filter((m) => m.enabled).length;
              const status = agentHealthStatus(a, agentModels.length);
              const canDiscover = a.supportsModelDiscovery !== false;

              return (
                <div key={a.id} className="catalogue-agent-card">
                  {/* ── Zone 1: Header ── */}
                  <div className="catalogue-agent-head">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={a.enabled}
                      aria-label={`${a.label} enabled`}
                      className={`toggle-switch${a.enabled ? ' on' : ''}`}
                      onClick={() => toggleAgent(a)}
                      title={a.enabled ? 'agent enabled' : (a.installed ? 'agent disabled' : 'not installed')}
                    >
                      <span className="toggle-knob" />
                    </button>
                    <span className="catalogue-agent-name">{a.label}</span>

                    <span className={`catalogue-status-badge ${STATUS_CLASS[status]}`}>
                      <span className="catalogue-status-dot" />
                      {statusLabel(status, enabledCount, agentModels.length)}
                    </span>

                    {a.installedVersion && (
                      <span
                        className="catalogue-agent-version"
                        title={a.latestVersion ? `installed v${a.installedVersion} · latest ${a.latestVersion}` : `installed v${a.installedVersion}`}
                      >
                        v{a.installedVersion}
                      </span>
                    )}

                    {a.behind && a.latestVersion && (
                      <span
                        className="catalogue-version-badge-behind"
                        title={`installed ${a.installedVersion} · latest ${a.latestVersion}`}
                      >
                        behind
                      </span>
                    )}

                    {a.installed && isRemoteLoginAgent(a.type) && a.loggedIn === false && !a.login?.running && (
                      <button
                        type="button"
                        className="catalogue-pull-btn"
                        onClick={() => startLogin(a.type)}
                      >
                        Log in
                      </button>
                    )}
                    {a.login?.running && (
                      <span className="rh-chip installing">
                        Waiting for {loginAgentLabel(a.type)} authorization…
                      </span>
                    )}
                    {a.installed && a.loggedIn === false && !isRemoteLoginAgent(a.type) && (
                      <span
                        className="catalogue-status-badge catalogue-status-needs-auth"
                        title={notLoggedInTitle(a.type, 'in a terminal on this hub')}
                      >
                        <span className="catalogue-status-dot" />
                        Not logged in
                      </span>
                    )}

                    {a.upgradeable && (a.behind || !a.installedVersion) && (
                      <button
                        type="button"
                        className="catalogue-pull-btn"
                        disabled={upgradeBusy === a.id || a.upgrading}
                        title={a.latestVersion ? `installed ${a.installedVersion ?? '—'} · latest ${a.latestVersion}` : undefined}
                        onClick={() => upgrade(a.id)}
                      >
                        {upgradeBusy === a.id || a.upgrading
                          ? (a.installed ? 'Updating…' : 'Installing…')
                          : (a.installed ? 'Update' : 'Install')}
                      </button>
                    )}

                    {a.installed && canDiscover && (
                      <button className="catalogue-pull-btn" disabled={busy === a.id} onClick={() => pull(a.id)}>
                        {busy === a.id ? 'Pulling…' : 'Pull models'}
                      </button>
                    )}
                  </div>

                  {a.login && shouldShowLoginResume(loginGate(a.type)) && (
                    <div className="rh-login-resume">
                      <div>{loginResumeMessage(a.login, 'this hub')}</div>
                      <div className="rh-login-resume-actions">
                        <button type="button" className="modal-btn primary" onClick={() => reopenLogin(a.type)}>Re-open</button>
                        <button type="button" className="modal-btn" onClick={() => restartLogin(a.type)}>Restart</button>
                        <button type="button" className="modal-btn" onClick={() => dismissLogin(a.type, a.login!.running)}>Dismiss</button>
                      </div>
                    </div>
                  )}

                  {!a.installed && a.installHint && (
                    <div className="catalogue-install-hint">{a.installHint}</div>
                  )}

                  {a.upgradeResult && !a.upgradeResult.ok && (
                    <div className="rh-install-error">
                      <strong>{a.label}</strong> {a.installed ? 'update' : 'install'} failed
                      {lastErrorLine(a.upgradeResult.tail) ? `: ${lastErrorLine(a.upgradeResult.tail)}` : ''}
                      {a.upgradeResult.tail ? (
                        <details><summary>output</summary><pre className="rh-install-tail">{a.upgradeResult.tail}</pre></details>
                      ) : null}
                    </div>
                  )}

                  {a.upgradeResult?.ok && !a.installed && (
                    <div className="catalogue-install-hint">
                      Installed, but the binary is not on the service PATH. Add its directory to PATH in the prod env file and restart the API.
                    </div>
                  )}

                  {/* ── Zone 2: Model list + add form ── */}
                  {a.installed && (
                    <div className="catalogue-models-section">
                      {agentModels.length === 0 && !canDiscover && (
                        <div className="catalogue-callout">
                          No models configured. Add the model IDs you want Tierwyn to use —
                          these can be any model this agent supports.
                        </div>
                      )}

                      {agentModels.length > 0 && (
                        <>
                          {filteredModels.length > 1 && (
                            <div className="catalogue-models-bulk-bar">
                              <button
                                type="button"
                                className="catalogue-pull-btn"
                                disabled={bulkToggleBusy === a.id || filteredModels.every((m) => m.enabled)}
                                onClick={() => setAgentModelsEnabled(a.id, filteredModels, true)}
                              >
                                All on
                              </button>
                              <button
                                type="button"
                                className="catalogue-pull-btn"
                                disabled={bulkToggleBusy === a.id || filteredModels.every((m) => !m.enabled)}
                                onClick={() => setAgentModelsEnabled(a.id, filteredModels, false)}
                              >
                                All off
                              </button>
                            </div>
                          )}
                          <div className="catalogue-models-list">
                            {filteredModels.length === 0 ? (
                              <div className="catalogue-models-empty">
                                No models match &ldquo;{searchQuery}&rdquo;.
                              </div>
                            ) : (
                              filteredModels.map((m) => (
                            <div key={m.id} className={`catalogue-model-item${expandedModelId === m.id ? ' is-expanded' : ''}`}>
                              <div className="catalogue-model-row">
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={m.enabled}
                                  className={`toggle-switch catalogue-model-toggle${m.enabled ? ' on' : ''}`}
                                  onClick={() => patchModel(m.id, { enabled: !m.enabled })}
                                  title={m.enabled ? 'enabled' : 'disabled'}
                                >
                                  <span className="toggle-knob" />
                                </button>
                                <input
                                  className="catalogue-model-label-input"
                                  defaultValue={m.label.replace(/^[^·]+·\s*/, '')}
                                  title="label"
                                  onBlur={(e) => {
                                    const rawVal = e.target.value.trim();
                                    if (!rawVal) return;
                                    const newVal = withAgentLabelPrefix(a.label, rawVal);
                                    if (newVal !== m.label) patchModel(m.id, { label: newVal });
                                  }}
                                />
                                <input
                                  className="catalogue-model-provider-input"
                                  defaultValue={m.provider ?? ''}
                                  title="provider"
                                  placeholder="provider"
                                  onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== m.provider) patchModel(m.id, { provider: v }); }}
                                />
                                <button
                                  className={`catalogue-model-cap-btn${m.vision ? ' active' : ''}`}
                                  title="vision capable"
                                  onClick={() => patchModel(m.id, { vision: !m.vision })}
                                >👁</button>
                                <button
                                  className={`catalogue-model-cap-btn${m.steer ? ' active' : ''}`}
                                  title="steer capable"
                                  onClick={() => patchModel(m.id, { steer: !m.steer })}
                                >⇄</button>
                                <button
                                  className="catalogue-model-delete-btn"
                                  title="delete model"
                                  onClick={() => { if (window.confirm(`Delete model "${m.label}"?`)) void removeModel(m.id); }}
                                >×</button>
                                <button
                                  type="button"
                                  className="catalogue-model-expand"
                                  aria-expanded={expandedModelId === m.id}
                                  aria-label="Model details"
                                  onClick={() => setExpandedModelId(id => id === m.id ? null : m.id)}
                                >▾</button>
                              </div>
                              <div className="catalogue-model-subrow">
                                <span className="ms-trigger-custom" style={{ opacity: 0.9, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                  <span className="ms-trigger-agent" style={{ fontSize: '9px', padding: '1px 5px', lineHeight: '1.2' }}>{a.label}</span>
                                  <span className="ms-trigger-dot">·</span>
                                  <input
                                    className="catalogue-model-name-input"
                                    defaultValue={m.modelName}
                                    title="model name (id segment)"
                                    onBlur={(e) => {
                                      const v = e.target.value.trim();
                                      if (v && v !== m.modelName) patchModel(m.id, { modelName: v });
                                    }}
                                    style={{ width: `${Math.max(8, m.modelName.length + 2)}ch` }}
                                  />
                                </span>
                                <input
                                  type="number"
                                  min={0}
                                  defaultValue={m.maxConcurrentSpawns ?? ''}
                                  title="max concurrent sub-agents when this profile is the spawner (0 / blank = cannot spawn)"
                                  placeholder="spawns"
                                  onBlur={(e) => {
                                    const raw = e.target.value.trim();
                                    const v = raw === '' ? 0 : Number(raw);
                                    if (v !== (m.maxConcurrentSpawns ?? 0)) patchModel(m.id, { maxConcurrentSpawns: v });
                                  }}
                                  className="catalogue-model-spawn-input"
                                />
                                <input
                                  type="number"
                                  min={0}
                                  defaultValue={m.maxGrandchildSpawns ?? ''}
                                  title="max grandchildren a single child of this profile may spawn (0 / blank = no grandchildren)"
                                  placeholder="grand"
                                  onBlur={(e) => {
                                    const raw = e.target.value.trim();
                                    const v = raw === '' ? 0 : Number(raw);
                                    if (v !== (m.maxGrandchildSpawns ?? 0)) patchModel(m.id, { maxGrandchildSpawns: v });
                                  }}
                                  className="catalogue-model-spawn-input"
                                />
                              </div>
                            </div>
                          ))
                        )}
                          </div>
                        </>
                      )}

                      {canDiscover ? (
                        <details className="catalogue-manual-details">
                          <summary>＋ add manually</summary>
                          <AddModelForm agentId={a.id} agentLabel={a.label} onAdded={reload} />
                        </details>
                      ) : (
                        <AddModelForm agentId={a.id} agentLabel={a.label} onAdded={reload} />
                      )}
                    </div>
                  )}

                  {a.installed && <AgentCommands agentId={a.id} />}

                  {/* ── Zone 3: Agent configuration (collapsible) ── */}
                  <details className="catalogue-config-details">
                    <summary>Agent configuration · vault, paths, JSON env</summary>
                    <div className="catalogue-config-body">
                      <AgentEnvSection
                        agentType={a.type}
                        vars={(agentEnv?.vars ?? []).filter((v) => v.agentType === a.type)}
                        vaultAvailable={agentEnv?.vaultAvailable !== false}
                        vaultUnavailableReason={agentEnv?.vaultUnavailableReason}
                        sandboxOff={!resolveSandbox({ hostId: 'hub', agentType: a.type, settings: sandboxDoc }).on}
                        onChanged={reloadEnv}
                      />
                      <div className="catalogue-config-field">
                        <label className="catalogue-config-label">Label</label>
                        <input
                          className="catalogue-config-input"
                          defaultValue={a.label}
                          onBlur={(e) => { if (e.target.value !== a.label) patchAgent(a.id, { label: e.target.value }); }}
                        />
                      </div>
                      <div className="catalogue-config-field">
                        <label className="catalogue-config-label">Description</label>
                        <input
                          className="catalogue-config-input"
                          defaultValue={a.description}
                          onBlur={(e) => { if (e.target.value !== a.description) patchAgent(a.id, { description: e.target.value }); }}
                        />
                      </div>
                      <div className="catalogue-config-field">
                        <label className="catalogue-config-label">Executable path (optional override)</label>
                        <input
                          className="catalogue-config-input"
                          defaultValue={a.executablePath ?? ''}
                          placeholder="auto (PATH)"
                          onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== a.executablePath) patchAgent(a.id, { executablePath: v }); }}
                        />
                      </div>
                      <div className="catalogue-config-field">
                        <label className="catalogue-config-label">Non-secret env vars (JSON) — saved only, not applied to agent processes</label>
                        <input
                          className="catalogue-config-input"
                          defaultValue={JSON.stringify(a.envVars)}
                          onBlur={(e) => {
                            try {
                              const v = JSON.parse(e.target.value || '{}');
                              patchAgent(a.id, { envVars: v });
                              setError(null);
                            } catch {
                              setError(`Invalid JSON for ${a.label} env vars`);
                            }
                          }}
                        />
                      </div>
                    </div>
                  </details>
                </div>
              );
            })
          )}
        </div>

      {bulkConfirm && (
        <div className="modal-overlay" onClick={() => setBulkConfirm(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">Apply model settings</div>
            <div className="modal-body catalogue-bulk-confirm-body">
              <p>
                Update <strong>{bulkConfirm.targets.length}</strong> model
                {bulkConfirm.targets.length === 1 ? '' : 's'}?
              </p>
              <ul className="catalogue-bulk-confirm-changes">
                {bulkConfirm.patch.spawns !== null && (
                  <li>max concurrent spawns → <strong>{bulkConfirm.patch.spawns}</strong></li>
                )}
                {bulkConfirm.patch.grand !== null && (
                  <li>max grandchildren → <strong>{bulkConfirm.patch.grand}</strong></li>
                )}
                {bulkConfirm.patch.vision !== null && (
                  <li>vision → <strong>{bulkConfirm.patch.vision ? 'on' : 'off'}</strong></li>
                )}
                {bulkConfirm.patch.steer !== null && (
                  <li>steer → <strong>{bulkConfirm.patch.steer ? 'on' : 'off'}</strong></li>
                )}
              </ul>
              <p className="catalogue-bulk-confirm-scope">
                {isFiltered
                  ? `Agent: ${agentById.get(selectedId)?.label ?? selectedId}`
                  : 'All agents'}
                {searchQuery ? ` · matching “${searchQuery}”` : ''}
              </p>
              <div className="catalogue-bulk-confirm-agents">
                <div className="catalogue-bulk-confirm-agents-head">
                  <span>Agent</span>
                  <span>Models</span>
                </div>
                {groupTargetsByAgent(bulkConfirm.targets, agentById).map((row) => (
                  <div key={row.label} className="catalogue-bulk-confirm-agents-row">
                    <span className="catalogue-bulk-confirm-agent-name">{row.label}</span>
                    <span className="catalogue-bulk-confirm-agent-count">{row.count}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="modal-btn" onClick={() => setBulkConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn primary"
                disabled={bulkBusy}
                onClick={() => {
                  const { targets, patch } = bulkConfirm;
                  setBulkConfirm(null);
                  void applyBulkPatch(targets, patch);
                }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {installAllConfirm && (
        <div className="modal-overlay" onClick={() => setInstallAllConfirm(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">Install &amp; update agents</div>
            <div className="modal-body catalogue-bulk-confirm-body">
              <p>
                Run <strong>{installAllConfirm.targets.length}</strong> install
                {installAllConfirm.targets.length === 1 ? '' : 's'}? They run one at a time.
              </p>
              <div className="catalogue-bulk-confirm-agents">
                <div className="catalogue-bulk-confirm-agents-head">
                  <span>Agent</span>
                  <span>Action</span>
                </div>
                {installAllConfirm.targets.map((id) => (
                  <div key={id} className="catalogue-bulk-confirm-agents-row">
                    <span className="catalogue-bulk-confirm-agent-name">{agentById.get(id)?.label ?? id}</span>
                    <span className="catalogue-bulk-confirm-agent-count">
                      {agentById.get(id)?.installed ? 'update' : 'install'}
                    </span>
                  </div>
                ))}
              </div>
              {installAllConfirm.manual.length > 0 && (
                <p className="catalogue-bulk-confirm-scope">
                  No install command (install manually): {installAllConfirm.manual.join(', ')}
                </p>
              )}
              <p className="catalogue-bulk-confirm-scope">
                Agents with live sessions on the server are skipped.
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="modal-btn" onClick={() => setInstallAllConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="modal-btn primary" onClick={() => { void runInstallAll(); }}>
                Install &amp; update
              </button>
            </div>
          </div>
        </div>
      )}

      {agents.filter((a) => a.login && shouldShowLoginModal(loginGate(a.type))).map((a) => (
        <AgentLoginModalFor
          key={a.type}
          targetName="this hub"
          login={a.login!}
          onClosed={() => dismissLogin(a.type, Boolean(a.login?.running))}
          actions={localActions(a.type)}
        />
      ))}
    </>
  );

  if (embedded) return inner;
  return (
    <div className="catalogue-drawer-overlay" onClick={onClose}>
      <div className="catalogue-drawer" role="dialog" aria-modal="true" aria-label="Agents & Models" onClick={(e) => e.stopPropagation()}>
        {inner}
      </div>
    </div>
  );
}
