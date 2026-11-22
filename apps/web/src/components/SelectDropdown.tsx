import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

export interface SelectDropdownOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  /** Small pill rendered after the label — e.g. origin tag. Matched by search. */
  badge?: string;
}

interface SelectDropdownBaseProps<T extends string> {
  options: SelectDropdownOption<T>[];
  disabled?: boolean;
  placement?: 'top' | 'bottom';
  searchable?: boolean;
}

interface SingleProps<T extends string> extends SelectDropdownBaseProps<T> {
  multiple?: false;
  value: T;
  onChange: (value: T) => void;
}

interface MultiProps<T extends string> extends SelectDropdownBaseProps<T> {
  multiple: true;
  value: T[];
  onChange: (value: T[]) => void;
  /** Trigger text when nothing is selected. Default 'None selected'. */
  placeholder?: string;
}

type SelectDropdownProps<T extends string = string> = SingleProps<T> | MultiProps<T>;

const PANEL_GAP = 8;
const VIEWPORT_PAD = 8;
/** Search row + borders — subtracted when sizing the scrollable list. */
const SEARCH_CHROME = 48;

/** Fixed coords for a portaled panel so modal overflow:hidden cannot clip it. */
export function panelPosition(
  trigger: DOMRect,
  preferred: 'top' | 'bottom',
  searchable: boolean,
): { style: React.CSSProperties; placement: 'top' | 'bottom'; listMaxHeight: number } {
  const winWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const winHeight = typeof window !== 'undefined' ? window.innerHeight : 768;
  const isMobile = winWidth <= 640;

  let left: number;
  let minWidth: number;
  let maxWidth: number;
  let width: React.CSSProperties['width'];

  if (isMobile && trigger.width >= 160) {
    // Mobile full-width / header picker: match the trigger width and align directly below it.
    width = Math.min(trigger.width, winWidth - 16);
    minWidth = width;
    maxWidth = width;
    left = Math.max(8, Math.min(trigger.left, winWidth - width - 8));
  } else {
    minWidth = Math.max(trigger.width, 200);
    maxWidth = Math.min(480, Math.max(minWidth, winWidth - 16));
    width = isMobile ? maxWidth : 'max-content';
    // Shift left only if minWidth overflows right edge. Never clamp against maxWidth.
    left = Math.max(8, Math.min(trigger.left, winWidth - minWidth - 8));
  }

  const spaceBelow = winHeight - trigger.bottom - PANEL_GAP - VIEWPORT_PAD;
  const spaceAbove = trigger.top - PANEL_GAP - VIEWPORT_PAD;

  // Flip when the preferred side can't fit a useful menu and the other side is roomier.
  let placement = preferred;
  if (preferred === 'bottom' && spaceBelow < 160 && spaceAbove > spaceBelow) placement = 'top';
  else if (preferred === 'top' && spaceAbove < 160 && spaceBelow > spaceAbove) placement = 'bottom';

  const available = placement === 'bottom' ? spaceBelow : spaceAbove;
  const chrome = searchable ? SEARCH_CHROME : 8;
  const listMaxHeight = Math.max(120, Math.min(320, available - chrome));

  const style: React.CSSProperties = placement === 'bottom'
    ? {
        position: 'fixed',
        top: trigger.bottom + PANEL_GAP,
        left,
        minWidth,
        maxWidth,
        width,
        maxHeight: available,
        zIndex: 2000,
      }
    : {
        position: 'fixed',
        bottom: winHeight - trigger.top + PANEL_GAP,
        left,
        minWidth,
        maxWidth,
        width,
        maxHeight: available,
        zIndex: 2000,
      };

  return { style, placement, listMaxHeight };
}

/** Toggle `val` in `current`, then emit values in `options` order (not click order). */
export function toggleMultiValue<T extends string>(
  options: SelectDropdownOption<T>[],
  current: readonly T[],
  val: T,
): T[] {
  const next = new Set(current);
  if (next.has(val)) next.delete(val);
  else next.add(val);
  return options.filter((o) => next.has(o.value)).map((o) => o.value);
}

export function multiTriggerLabel<T extends string>(
  options: SelectDropdownOption<T>[],
  values: readonly T[],
  placeholder?: string,
): string {
  const selected = options.filter((o) => values.includes(o.value));
  const k = selected.length;
  const n = options.length;
  if (k === 0) return placeholder ?? 'None selected';
  if (k === n) return `All (${n})`;
  if (k <= 3) return selected.map((o) => o.label).join(', ');
  return `${k} of ${n} selected`;
}

export function SelectDropdown<T extends string = string>(props: SelectDropdownProps<T>) {
  const {
    options,
    disabled,
    placement = 'bottom',
    searchable = false,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const [coords, setCoords] = useState<React.CSSProperties>({});
  const [resolvedPlacement, setResolvedPlacement] = useState<'top' | 'bottom'>(placement);
  const [listMaxHeight, setListMaxHeight] = useState(220);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const filtered = useMemo(() => {
    if (!searchable || !query) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q)
      || o.description?.toLowerCase().includes(q)
      || o.badge?.toLowerCase().includes(q));
  }, [options, query, searchable]);

  const selected = props.multiple ? props.value : [props.value];
  const selectedOption = props.multiple
    ? undefined
    : (options.find((o) => o.value === props.value) ?? options[0]);
  const triggerLabel = props.multiple
    ? multiTriggerLabel(options, props.value, props.placeholder)
    : (selectedOption ? selectedOption.label : 'Select...');
  const triggerTitle = props.multiple
    ? options.filter((o) => selected.includes(o.value)).map((o) => o.label).join(', ')
    : selectedOption?.description;

  const updateCoords = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const next = panelPosition(el.getBoundingClientRect(), placement, searchable);
    setCoords(next.style);
    setResolvedPlacement(next.placement);
    setListMaxHeight(next.listMaxHeight);
  }, [placement, searchable]);

  useLayoutEffect(() => {
    if (!open) return;
    updateCoords();
  }, [open, updateCoords, filtered.length]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updateCoords();
    window.addEventListener('resize', onScrollOrResize);
    // capture scroll from modal-body etc.
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, updateCoords]);

  // Reset highlight + focus search when panel opens
  useEffect(() => {
    if (open) {
      setQuery('');
      if (props.multiple) {
        setHighlighted(0);
      } else {
        const selectedIndex = options.findIndex((o) => o.value === props.value);
        setHighlighted(selectedIndex >= 0 ? selectedIndex : 0);
      }
      if (searchable) setTimeout(() => searchRef.current?.focus(), 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-clamp highlight when filter changes
  useEffect(() => {
    setHighlighted((h) => Math.min(h, Math.max(filtered.length - 1, 0)));
  }, [filtered]);

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

  const select = useCallback((val: T) => {
    if (props.multiple) {
      props.onChange(toggleMultiValue(options, props.value, val));
      return;
    }
    props.onChange(val);
    setOpen(false);
    setQuery('');
  }, [options, props]);

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
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = filtered[highlighted];
      if (o) select(o.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }, [open, highlighted, filtered, select]);

  const panel = open ? createPortal(
    <div
      ref={panelRef}
      className={`ms-panel ms-panel--${resolvedPlacement} ms-panel--portaled`}
      role="listbox"
      aria-multiselectable={props.multiple || undefined}
      style={coords}
    >
      {searchable && (
        <div className="ms-search-row">
          <input
            ref={searchRef}
            className="ms-search"
            type="text"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      <div className="ms-list" style={{ maxHeight: listMaxHeight }}>
        {filtered.length === 0 ? (
          <div className="ms-empty">No match</div>
        ) : filtered.map((option, idx) => {
          const isSelected = selected.includes(option.value);
          return (
            <div
              key={option.value === '' ? '__empty__' : option.value}
              ref={(el) => { itemRefs.current[idx] = el; }}
              className={`ms-item${idx === highlighted ? ' ms-item--hi' : ''}${isSelected ? ' ms-item--sel' : ''}`}
              role="option"
              aria-selected={isSelected}
              onMouseDown={(e) => { if (props.multiple) e.preventDefault(); select(option.value); }}
              onMouseEnter={() => setHighlighted(idx)}
              title={option.description}
            >
              {(props.multiple || isSelected) && (
                <span className="ms-check" style={isSelected ? undefined : { visibility: 'hidden' }}>✓</span>
              )}
              {props.multiple ? (
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span className="ms-item-label">{option.label}</span>
                  {option.description && <span className="ms-item-desc">{option.description}</span>}
                </span>
              ) : (
                <span className="ms-item-label">{option.label}</span>
              )}
              {option.badge && <span className="ms-item-badge">{option.badge}</span>}
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={wrapperRef} className="model-selector" onKeyDown={handleKeyDown}>
      <button
        type="button"
        className={`ms-trigger${open ? ' ms-open' : ''}`}
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        disabled={disabled}
        title={triggerTitle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ms-trigger-label">{triggerLabel}</span>
        <span className="ms-chevron" aria-hidden="true">▾</span>
      </button>
      {panel}
    </div>
  );
}
