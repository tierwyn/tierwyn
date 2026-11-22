import { useState, useRef, useEffect, useMemo, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { AgentProfile, SpawnTemplate, SpawnTemplateRole } from '@tierwyn/shared';

export interface VariableValueComboboxProps {
  value: string;
  onChange: (value: string) => void;
  templateName?: string;
  templates: SpawnTemplate[];
  profiles: AgentProfile[];
  placeholder?: string;
  style?: React.CSSProperties;
  autoOpenOnFocus?: boolean;
}

export function detectVarMode(
  key: string,
  value: string,
  templateName?: string,
  templates: SpawnTemplate[] = [],
  profiles: AgentProfile[] = [],
): 'text' | 'dropdown' {
  const k = key.trim().toLowerCase();
  const v = value.trim();

  // Pure numbers or booleans should always be text
  if (/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false') {
    return 'text';
  }
  // Keys that explicitly denote numeric/count/time configs
  if (/^(max|min|count|limit|streak|timeout|delay|port|retries)/i.test(k)) {
    return 'text';
  }
  // Keys naming roles, profiles, models, templates, agents
  if (/(role|profile|model|template|agent|roster)/i.test(k)) {
    return 'dropdown';
  }
  // If value matches a role or profile in the active template
  const attached = templates.find((t) => t.name === templateName);
  if (attached && attached.roles.some((r) => r.role === v || r.profileId === v)) {
    return 'dropdown';
  }
  // If value matches any profile ID
  if (profiles.some((p) => p.id === v)) {
    return 'dropdown';
  }
  // If value matches a template name
  if (templates.some((t) => t.name === v)) {
    return 'dropdown';
  }

  return 'text';
}

export interface ComboboxItem {
  id: string;
  category: 'roster_role' | 'roster_model' | 'template' | 'system_model';
  categoryLabel: string;
  value: string;
  label: string;
  badge: string;
  description?: string;
}

export function buildComboboxItems(
  templates: SpawnTemplate[],
  profiles: AgentProfile[],
  templateName?: string,
): ComboboxItem[] {
  const list: ComboboxItem[] = [];
  const attachedTemplate = templates.find((t) => t.name === templateName);

  // 1. Roles in the active roster
  if (attachedTemplate && attachedTemplate.roles.length > 0) {
    for (const r of attachedTemplate.roles) {
      list.push({
        id: `role-${r.role}-${r.profileId}`,
        category: 'roster_role',
        categoryLabel: `Roster Roles (${attachedTemplate.name})`,
        value: r.role,
        label: r.role,
        badge: 'Role',
        description: `Model: ${r.profileId}`,
      });
    }
  }

  // 2. Models in the active roster
  if (attachedTemplate && attachedTemplate.roles.length > 0) {
    const seenProfiles = new Set<string>();
    for (const r of attachedTemplate.roles) {
      if (!seenProfiles.has(r.profileId)) {
        seenProfiles.add(r.profileId);
        list.push({
          id: `roster-model-${r.profileId}`,
          category: 'roster_model',
          categoryLabel: `Roster Models (${attachedTemplate.name})`,
          value: r.profileId,
          label: r.profileId,
          badge: 'Roster Model',
          description: `Used by role: ${r.role}`,
        });
      }
    }
  }

  // 3. Available Rosters / Templates
  if (templates.length > 0) {
    for (const t of templates) {
      list.push({
        id: `template-${t.name}`,
        category: 'template',
        categoryLabel: 'Available Rosters / Templates',
        value: t.name,
        label: t.name,
        badge: 'Roster',
        description: `${t.roles.length} roles defined`,
      });
    }
  }

  // 4. All system models (excluding those already in roster_model)
  const rosterModelIds = new Set(attachedTemplate?.roles.map((r: SpawnTemplateRole) => r.profileId) ?? []);
  for (const p of profiles) {
    if (!rosterModelIds.has(p.id)) {
      list.push({
        id: `profile-${p.id}`,
        category: 'system_model',
        categoryLabel: 'Other System Models',
        value: p.id,
        label: p.id,
        badge: p.agentType,
        description: p.label,
      });
    }
  }

  return list;
}

export function filterAndGroupComboboxItems(
  items: ComboboxItem[],
  query: string,
): Array<{ label: string; items: ComboboxItem[] }> {
  const q = query.trim().toLowerCase();
  const filtered = !q
    ? items
    : items.filter(
        (item) =>
          item.value.toLowerCase().includes(q) ||
          item.label.toLowerCase().includes(q) ||
          (item.description && item.description.toLowerCase().includes(q)),
      );

  const groups: Array<{ label: string; items: ComboboxItem[] }> = [];
  const map = new Map<string, ComboboxItem[]>();
  for (const item of filtered) {
    if (!map.has(item.categoryLabel)) {
      const arr: ComboboxItem[] = [];
      map.set(item.categoryLabel, arr);
      groups.push({ label: item.categoryLabel, items: arr });
    }
    map.get(item.categoryLabel)!.push(item);
  }
  return groups;
}

export function VariableValueCombobox({
  value,
  onChange,
  templateName,
  templates,
  profiles,
  placeholder = 'value (or pick from roster/models)',
  style,
  autoOpenOnFocus = false,
}: VariableValueComboboxProps) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<React.CSSProperties>({});

  const items = useMemo(
    () => buildComboboxItems(templates, profiles, templateName),
    [templates, profiles, templateName],
  );

  const groupedItems = useMemo(
    () => filterAndGroupComboboxItems(items, value),
    [items, value],
  );

  // Flat list of visible items for keyboard indexing
  const flatVisibleItems = useMemo(
    () => groupedItems.flatMap((g) => g.items),
    [groupedItems],
  );

  const updatePosition = useCallback(() => {
    if (!inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placeBottom = spaceBelow >= 200 || spaceBelow >= spaceAbove;
    const width = Math.max(rect.width, 280);
    const left = Math.min(rect.left, window.innerWidth - width - 12);

    if (placeBottom) {
      setPanelPos({
        position: 'fixed',
        top: rect.bottom + 4,
        left: Math.max(8, left),
        width,
        maxHeight: Math.min(320, spaceBelow - 16),
        zIndex: 2200,
      });
    } else {
      setPanelPos({
        position: 'fixed',
        bottom: window.innerHeight - rect.top + 4,
        left: Math.max(8, left),
        width,
        maxHeight: Math.min(320, spaceAbove - 16),
        zIndex: 2200,
      });
    }
  }, []);

  useLayoutEffect(() => {
    if (open) {
      updatePosition();
      const onReposition = () => updatePosition();
      window.addEventListener('resize', onReposition);
      window.addEventListener('scroll', onReposition, true);
      return () => {
        window.removeEventListener('resize', onReposition);
        window.removeEventListener('scroll', onReposition, true);
      };
    }
  }, [open, updatePosition]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        wrapRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const selectItem = (item: ComboboxItem) => {
    onChange(item.value);
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlightedIndex(0);
      } else {
        setHighlightedIndex((prev) =>
          prev + 1 < flatVisibleItems.length ? prev + 1 : 0,
        );
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlightedIndex(flatVisibleItems.length - 1);
      } else {
        setHighlightedIndex((prev) =>
          prev - 1 >= 0 ? prev - 1 : flatVisibleItems.length - 1,
        );
      }
    } else if (e.key === 'Enter') {
      if (open && flatVisibleItems[highlightedIndex]) {
        e.preventDefault();
        selectItem(flatVisibleItems[highlightedIndex]!);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  return (
    <div
      ref={wrapRef}
      className="var-combobox-wrap"
      style={{ position: 'relative', flex: 1, display: 'flex', minWidth: 0, ...style }}
    >
      <input
        ref={inputRef}
        type="text"
        className="modal-input var-combobox-input"
        style={{ flex: 1, paddingRight: 26, minWidth: 0 }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) setOpen(true);
          setHighlightedIndex(0);
        }}
        onFocus={() => {
          if (autoOpenOnFocus) {
            setOpen(true);
            setHighlightedIndex(0);
          }
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="var-combobox-toggle"
        tabIndex={-1}
        title="Browse roster roles, models, and templates"
        onClick={() => {
          setOpen((prev) => !prev);
          inputRef.current?.focus();
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="var-combobox-panel"
            style={panelPos}
            role="listbox"
          >
            {groupedItems.length === 0 ? (
              <div className="var-combobox-empty">
                No matching roles, models, or rosters
              </div>
            ) : (
              groupedItems.map((group) => (
                <div key={group.label} className="var-combobox-group">
                  <div className="var-combobox-group-title">{group.label}</div>
                  {group.items.map((item) => {
                    const idx = flatVisibleItems.indexOf(item);
                    const isSelected = item.value === value;
                    const isHighlighted = idx === highlightedIndex;
                    return (
                      <div
                        key={item.id}
                        className={`var-combobox-option${isSelected ? ' selected' : ''}${isHighlighted ? ' highlighted' : ''}`}
                        role="option"
                        aria-selected={isSelected}
                        onMouseEnter={() => setHighlightedIndex(idx)}
                        onClick={() => selectItem(item)}
                      >
                        <div className="var-combobox-option-header">
                          <span
                            className="var-combobox-option-label"
                            style={{
                              fontFamily:
                                item.category === 'roster_role'
                                  ? 'var(--ui)'
                                  : 'var(--mono)',
                              fontSize: item.category === 'roster_role' ? 12 : 11,
                            }}
                          >
                            {item.label}
                          </span>
                          <span
                            className={`var-combobox-badge ${item.category}`}
                          >
                            {item.badge}
                          </span>
                        </div>
                        {item.description && (
                          <div className="var-combobox-option-desc">
                            {item.description}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
