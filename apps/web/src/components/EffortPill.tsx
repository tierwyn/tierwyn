import { useState, useRef, useEffect, useCallback } from 'react';
import type { EffortLevel, EffortPreference } from '@tierwyn/shared';

export type EffortSessionState = 'active' | 'next-session' | 'immediate';

interface EffortPillProps {
  levels: readonly EffortLevel[];
  /** Stored preference shown on the badge — a level, or 'off' (omit flag). */
  value: EffortPreference;
  sessionState: EffortSessionState;
  disabled?: boolean;
  onChange: (level: EffortPreference) => void;
}

function sessionSuffix(state: EffortSessionState): string {
  if (state === 'active') return ' (active)';
  if (state === 'next-session') return ' (next session)';
  return '';
}

/**
 * Compact effort-level picker next to ModelSelector.
 * At rest always shows the effective level (B1). Popover lists allowed levels.
 * Styled like ModelSelector (.ms-trigger / .ms-panel); selected via .selected.
 */
export function EffortPill({ levels, value, sessionState, disabled, onChange }: EffortPillProps) {
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

  const select = useCallback((level: EffortPreference) => {
    onChange(level);
    setOpen(false);
  }, [onChange]);

  if (levels.length === 0) return null;

  const fullLabel = `Effort: ${value}${sessionSuffix(sessionState)}`;

  return (
    <div ref={wrapperRef} className="effort-pill">
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
          <span className="effort-pill-prefix">Effort: </span>
          {value}
          {sessionSuffix(sessionState)}
        </span>
        <span className="effort-pill-chevron" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="effort-pill-panel" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={value === 'off'}
            title="Omit the effort flag at spawn — for agents/models that reject it"
            className={`effort-pill-item${value === 'off' ? ' selected' : ''}`}
            onClick={() => select('off')}
          >
            {value === 'off' && <span className="effort-pill-check">✓</span>}
            <span>off</span>
          </button>
          {levels.map((level) => {
            const isSelected = level === value;
            return (
              <button
                key={level}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`effort-pill-item${isSelected ? ' selected' : ''}`}
                onClick={() => select(level)}
              >
                {isSelected && <span className="effort-pill-check">✓</span>}
                <span>{level}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
