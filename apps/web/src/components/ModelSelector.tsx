import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { AgentProfile } from '@tierwyn/shared';
import { api } from '../api.js';
import { modelSelectorEmptyCopy, modelSelectorTriggerLabel } from '../modelSelectorLabel.js';
import { readStoredModelQuery, writeStoredModelQuery } from '../modelSelectorQuery.js';

/** Fixed coords for a portaled panel so modal overflow:hidden cannot clip it. */
function panelPosition(
  trigger: DOMRect,
  placement: 'top' | 'bottom',
): React.CSSProperties {
  const minWidth = Math.max(trigger.width, 280);
  const maxWidth = Math.min(480, Math.max(minWidth, window.innerWidth - 16));
  const left = Math.min(trigger.left, window.innerWidth - maxWidth - 8);
  if (placement === 'bottom') {
    return {
      position: 'fixed',
      top: trigger.bottom + 8,
      left: Math.max(8, left),
      minWidth,
      maxWidth,
      width: 'max-content',
      zIndex: 2000,
    };
  }
  return {
    position: 'fixed',
    bottom: window.innerHeight - trigger.top + 8,
    left: Math.max(8, left),
    minWidth,
    maxWidth,
    width: 'max-content',
    zIndex: 2000,
  };
}

interface ModelSelectorProps {
  profiles: AgentProfile[];
  selectedProfileId: string;
  onChange: (profileId: string) => void;
  disabled?: boolean;
  placement?: 'top' | 'bottom';
  /** When true, render a "Select model" placeholder instead of falling back to
   *  profiles[0] while selectedProfileId is empty/unmatched. Callers that use
   *  ModelSelector as an always-bound control (chat input, compaction) leave
   *  this off so the trigger always reflects a concrete model. TemplateSettings
   *  turns it on so an unselected role row can't be mistaken for a picked one. */
  allowEmpty?: boolean;
  /** When 'prompt', bypass-only profiles are greyed out and unselectable.
   *  'questions' bypasses tool permissions so all agents remain available.
   *  Defaults to 'bypass' (no restriction). */
  permissionMode?: 'bypass' | 'questions' | 'prompt';
  /** Model profile IDs that belong to the active delegation template / roster. */
  rosterProfileIds?: string[];
  /** False until GET /profiles has successfully applied (including an empty
   *  array). Default true for isolated pickers that already waited on their
   *  own fetch. Chat surfaces must pass the live flag from useWs. */
  profilesLoaded?: boolean;
  /** When true, search filter query is restored from and saved to localStorage across sessions. */
  persistQuery?: boolean;
  /** Profile ids that cannot be selected on this host, mapped to a short reason. */
  unavailable?: Record<string, string>;
}

interface Group {
  agentType: string;
  label: string;
  profiles: AgentProfile[];
}

function humanize(t: string): string {
  return t.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function buildRegex(query: string): { re: RegExp | null; invalid: boolean } {
  if (!query) return { re: null, invalid: false };
  try {
    return { re: new RegExp(query, 'gi'), invalid: false };
  } catch {
    return { re: null, invalid: true };
  }
}

function applyHighlight(text: string, re: RegExp | null): React.ReactNode {
  if (!re) return text;
  const pat = new RegExp(re.source, 'gi');
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pat.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<mark key={m.index}>{m[0]}</mark>);
    last = m.index + m[0].length;
    if (m[0].length === 0) { pat.lastIndex++; break; }
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? <>{parts}</> : text;
}

export function ModelSelector({ profiles, selectedProfileId, onChange, disabled, placement = 'top', allowEmpty = false, permissionMode, rosterProfileIds, profilesLoaded = true, persistQuery = false, unavailable }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string>(() => (persistQuery ? readStoredModelQuery() : ''));
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    if (persistQuery) writeStoredModelQuery(query);
  }, [query, persistQuery]);
  const [agentLabels, setAgentLabels] = useState<Record<string, string>>({});
  const [coords, setCoords] = useState<React.CSSProperties>({});

  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    api.listAgents()
      .then((agents) => setAgentLabels(Object.fromEntries(agents.map((a) => [a.type, a.label]))))
      .catch(() => {});
  }, []);

  const agentLabel = useCallback((t: string) => agentLabels[t] ?? humanize(t), [agentLabels]);

  const matchedProfile = profiles.find((p) => p.id === selectedProfileId);
  const selectedProfile = matchedProfile;
  // Model labels already start with the agent name (e.g. "Pi · glm-4.7",
  // "Antigravity · Gemini 3.5 Flash (Low)"), so the trigger just renders the
  // label as-is — prepending agentLabel() here would double-prefix it.
  const triggerLabel = modelSelectorTriggerLabel(selectedProfile, profiles, allowEmpty, profilesLoaded);

  const parts = selectedProfile ? selectedProfile.label.split('·') : [];
  const agentPart = parts.length >= 2
    ? parts[0]?.trim()
    : (selectedProfile ? agentLabel(selectedProfile.agentType) : undefined);
  const modelPart = parts.length >= 2
    ? parts.slice(1).join('·').trim()
    : (selectedProfile ? selectedProfile.label.trim() : undefined);

  const { re, invalid: regexInvalid } = useMemo(() => buildRegex(query), [query]);
  
  const filteredGroups = useMemo((): Group[] => {
    // Build ordered group map preserving profiles array order
    const groupMap = new Map<string, Group>();
    for (const p of profiles) {
      if (!groupMap.has(p.agentType)) {
        groupMap.set(p.agentType, {
          agentType: p.agentType,
          label: agentLabels[p.agentType] ?? humanize(p.agentType),
          profiles: [],
        });
      }
      groupMap.get(p.agentType)!.profiles.push(p);
    }

    // Sort models within each agent section alphabetically by the stripped
    // label (group header already shows the agent name, so the per-item sort
    // key mirrors what the user actually sees in the list).
    for (const group of groupMap.values()) {
      group.profiles.sort((a, b) => {
        const key = (label: string) => label.replace(/^[^·]+·\s*/, '').toLowerCase();
        return key(a.label).localeCompare(key(b.label));
      });
    }

    if (!query || regexInvalid) return Array.from(groupMap.values());

    const result: Group[] = [];
    for (const group of groupMap.values()) {
      const agentMatches = re ? new RegExp(re.source, 'gi').test(group.label) : false;
      const matched = agentMatches
        ? group.profiles
        : group.profiles.filter((p) => re ? new RegExp(re.source, 'gi').test(p.label) : false);
      if (matched.length > 0) result.push({ ...group, profiles: matched });
    }
    return result;
  }, [profiles, query, re, regexInvalid, agentLabels]);

  const flatProfiles = useMemo(() => filteredGroups.flatMap((g) => g.profiles), [filteredGroups]);

  // Reset highlight when query changes
  useEffect(() => { setHighlighted(0); }, [query]);

  // Auto-focus search and reset state when panel opens (desktop only)
  useEffect(() => {
    if (open) {
      setHighlighted(0);
      // ponytail: no autofocus on mobile — keyboard occludes the bottom sheet
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 600px), (max-height: 500px) and (orientation: landscape)').matches) return;
      setTimeout(() => searchRef.current?.select(), 0);
    }
  }, [open]);

  const updateCoords = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    setCoords(panelPosition(el.getBoundingClientRect(), placement));
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return;
    updateCoords();
  }, [open, updateCoords, flatProfiles.length]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updateCoords();
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, updateCoords]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open) return;
    itemRefs.current[highlighted]?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, open]);

  // Close on click-outside (panel is portaled — check both roots)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const select = useCallback((profileId: string) => {
    onChange(profileId);
    setOpen(false);
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, flatProfiles.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = flatProfiles[highlighted];
      if (!p) return;
      const bypassOnly = permissionMode === 'prompt' && !p.permissionCapable;
      if (bypassOnly || unavailable?.[p.id]) return;
      select(p.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }, [open, highlighted, flatProfiles, select, permissionMode, unavailable]);

  let flatIdx = 0;

  const panel = open ? createPortal(
    <>
      <div
        className="ms-backdrop"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
        }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className={`ms-panel ms-panel--${placement} ms-panel--portaled ms-panel--model-selector`}
        role="listbox"
        style={coords}
      >
        <div className="ms-search-row">
          <input
            ref={searchRef}
            className={`ms-search${regexInvalid ? ' ms-search--err' : ''}`}
            type="text"
            placeholder="Search… (regex)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            aria-label="Search models"
          />
          {query ? (
            <button
              type="button"
              className="ms-search-clear"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
              title="Clear search"
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </div>

        <div className="ms-list">
          {filteredGroups.length === 0 ? (
            <div className="ms-empty">
              {modelSelectorEmptyCopy(profiles, profilesLoaded)}
            </div>
          ) : (
            filteredGroups.map((group) => (
              <div key={group.agentType} className="ms-group">
                <div className="ms-group-header">
                  <span>{applyHighlight(group.label, re)}</span>
                  <span className="ms-group-count">{group.profiles.length}</span>
                </div>
                {group.profiles.map((profile) => {
                  const idx = flatIdx++;
                  const isSelected = profile.id === selectedProfileId;
                  // Group header already shows the agent name, so strip the
                  // "Agent · " prefix from each item to avoid duplication
                  // (e.g. "Pi · glm-4.7" → "glm-4.7" when grouped under "Pi").
                  const itemLabel = profile.label.replace(/^[^·]+·\s*/, '');
                  // ponytail: grey out bypass-only profiles only in full 'prompt' mode
                  const bypassOnly = permissionMode === 'prompt' && !profile.permissionCapable;
                  const reason = unavailable?.[profile.id];
                  const blocked = bypassOnly || Boolean(reason);
                  const inRoster = Boolean(rosterProfileIds?.includes(profile.id));
                  const title = [reason, bypassOnly ? `${profile.label} runs bypass-equivalent regardless of permission mode` : undefined]
                    .filter(Boolean)
                    .join(' — ') || undefined;
                  return (
                    <div
                      key={profile.id}
                      ref={(el) => { itemRefs.current[idx] = el; }}
                      className={`ms-item${idx === highlighted ? ' ms-item--hi' : ''}${isSelected ? ' ms-item--sel' : ''}${blocked ? ' ms-item--bypass-only' : ''}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={blocked || undefined}
                      title={title}
                      onMouseDown={() => { if (!blocked) select(profile.id); }}
                      onMouseEnter={() => setHighlighted(idx)}
                    >
                      {isSelected && <span className="ms-check">✓</span>}
                      <span className="ms-item-label">{applyHighlight(itemLabel, re)}</span>
                      {inRoster && <span className="ms-roster-badge">in roster</span>}
                      {reason && <span className="ms-bypass-badge">{reason}</span>}
                      {bypassOnly && <span className="ms-bypass-badge">bypass only</span>}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="ms-footer">
          {regexInvalid
            ? <span className="ms-footer--err">invalid regex — showing all</span>
            : <span>{flatProfiles.length} result{flatProfiles.length !== 1 ? 's' : ''}</span>
          }
          <span>↑↓ Enter Esc</span>
        </div>
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <div ref={wrapperRef} className="model-selector" onKeyDown={handleKeyDown}>
      <button
        type="button"
        className={`ms-trigger${open ? ' ms-open' : ''}`}
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        disabled={disabled}
        title={selectedProfile?.description}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ms-trigger-label">
          {agentPart && modelPart ? (
            <span className="ms-trigger-custom">
              <span className="ms-trigger-agent">{agentPart}</span>
              <span className="ms-trigger-dot">·</span>
              <span className="ms-trigger-model">{modelPart}</span>
            </span>
          ) : (
            triggerLabel
          )}
        </span>
        <span className="ms-chevron" aria-hidden="true">▾</span>
      </button>
      {panel}
    </div>
  );
}
