import { useState, useRef, useEffect, useCallback } from 'react';
import type { InteractionMode } from '@tierwyn/shared';

export interface PermissionModePillProps {
  value: InteractionMode | null;
  defaultMode: InteractionMode;
  permissionCapable: boolean;
  disabled?: boolean;
  onChange: (mode: InteractionMode | null) => void;
}

/**
 * Sticky per-conversation permission mode pill (WP-2.1).
 * Reuses .effort-pill CSS classes for visual parity with EffortPill.
 */
export function PermissionModePill({
  value,
  defaultMode,
  permissionCapable,
  disabled,
  onChange,
}: PermissionModePillProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const select = useCallback((mode: InteractionMode | null) => {
    onChange(mode);
    setOpen(false);
  }, [onChange]);

  const displayValue = value ?? 'default';
  const fullLabel = `Permission mode: ${displayValue}`;

  const options: Array<{
    id: 'default' | InteractionMode;
    val: InteractionMode | null;
    label: string;
    disabled?: boolean;
    title?: string;
  }> = [
    {
      id: 'default',
      val: null,
      label: `Default (global: ${defaultMode})`,
    },
    {
      id: 'bypass',
      val: 'bypass',
      label: 'bypass',
    },
    {
      id: 'questions',
      val: 'questions',
      label: 'questions',
    },
    {
      id: 'prompt',
      val: 'prompt',
      label: 'prompt',
      disabled: !permissionCapable,
      title: !permissionCapable
        ? 'This agent cannot surface tool permission prompts — prompt mode is unavailable'
        : undefined,
    },
  ];

  return (
    <div ref={wrapperRef} className="effort-pill permission-mode-pill">
      <button
        type="button"
        className={`effort-pill-trigger${open ? ' effort-pill-open' : ''}`}
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        disabled={disabled}
        title={fullLabel}
        aria-label={fullLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="effort-pill-label">
          <span className="effort-pill-prefix">Mode: </span>
          {displayValue}
        </span>
        <span className="effort-pill-chevron" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="effort-pill-panel" role="listbox">
          {options.map((opt) => {
            const isSelected = opt.val === value;
            return (
              <button
                key={opt.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled}
                disabled={opt.disabled}
                title={opt.title ?? opt.label}
                className={`effort-pill-item${isSelected ? ' selected' : ''}${opt.disabled ? ' disabled' : ''}`}
                onClick={() => {
                  if (!opt.disabled) select(opt.val);
                }}
              >
                {isSelected && <span className="effort-pill-check">✓</span>}
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
