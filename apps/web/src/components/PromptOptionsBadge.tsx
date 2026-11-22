import { useMemo, type KeyboardEvent } from 'react';
import type { PromptOptionDescriptor, PromptOptions } from '@tierwyn/shared';

export interface PromptOptionsBadgeProps {
  descriptors: readonly PromptOptionDescriptor[];
  options: PromptOptions;
  count: number;
  error?: string | null;
  disabled?: boolean;
  disabledReason?: string;
  sticky?: boolean;
  onOpenModal: () => void;
  onClear: () => void;
  compact?: boolean;
  /** When true, mutates from pill button to a visually matching popover item. */
  asMenuItem?: boolean;
}

function SlidersIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color: 'var(--red, #ef4444)' }}
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function PromptOptionsBadge({
  descriptors,
  options,
  count,
  error = null,
  disabled = false,
  disabledReason,
  sticky = false,
  onOpenModal,
  onClear,
  compact = false,
  asMenuItem = false,
}: PromptOptionsBadgeProps) {
  const tags = useMemo(() => {
    if (!descriptors || descriptors.length === 0) return [];
    const list: string[] = [];
    for (const desc of descriptors) {
      const val = options[desc.key];
      if (val === undefined || val === null) continue;
      if (desc.kind === 'select') {
        if (typeof val === 'string' && val !== desc.choices[0]?.value) {
          list.push(desc.key === 'toolsPolicy' && val === 'readOnly' ? 'read-only' : val);
        }
      } else if (desc.kind === 'toggle') {
        if (val === true) {
          if (desc.key === 'sandbox') list.push('sandbox');
          else if (desc.key === 'disableSlashCommands') list.push('no-slash');
          else if (desc.key === 'autoReview') list.push('auto-review');
          else if (desc.key === 'assistedApproval') list.push('assisted');
          else list.push(desc.key);
        }
      } else if (desc.kind === 'text') {
        if (typeof val === 'string' && val.trim()) {
          if (desc.key === 'jsonSchema') list.push('schema');
          else list.push(desc.key);
        }
      }
    }
    // Generic fallback for any other active option not in descriptors
    for (const [k, v] of Object.entries(options)) {
      if (descriptors.some((d) => d.key === k)) continue;
      if (v === true || (typeof v === 'string' && v)) list.push(k);
    }
    return list;
  }, [descriptors, options]);

  const summaryLabel = useMemo(() => {
    if (compact) {
      if (tags.length === 0) return 'Options';
      return tags[0] + (tags.length > 1 ? ` +${tags.length - 1}` : '');
    }
    if (tags.length <= 2) {
      return tags.join(' · ');
    }
    return `${tags.slice(0, 2).join(' · ')} · +${tags.length - 2}`;
  }, [tags, compact]);

  const fullTooltip = useMemo(() => {
    if (error) return `Prompt options error: ${error}`;
    if (disabledReason) return disabledReason;
    if (tags.length === 0) {
      return sticky
        ? 'Configure prompt options (sticky for this agent in this conversation)'
        : 'Configure prompt options (next message only)';
    }
    return sticky
      ? `Sticky options (until you turn sticky off):\n${tags.map((t) => `• ${t}`).join('\n')}`
      : `Staged options (next message only):\n${tags.map((t) => `• ${t}`).join('\n')}`;
  }, [error, disabledReason, tags, sticky]);

  // If no descriptors for this adapter, don't render anything (checked AFTER all hooks)
  if (!descriptors || descriptors.length === 0) {
    return null;
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!disabled) onOpenModal();
    }
  };

  const menuLabel = compact ? 'Options' : (count === 0 ? 'Prompt Options…' : 'Prompt Options');

  if (asMenuItem) {
    if (error) {
      return (
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          className={`attach-menu-item prompt-options-menu-item is-error${disabled ? ' is-disabled' : ''}`}
          title={fullTooltip}
          onClick={() => {
            if (!disabled) onOpenModal();
          }}
          onKeyDown={handleKeyDown}
          aria-label={`Prompt options error: ${error}`}
        >
          <WarningIcon />
          <span className="prompt-options-menu-label">{menuLabel}</span>
          <span className="prompt-options-menu-badge prompt-options-menu-badge-error">
            <span className="prompt-options-armed-icon" aria-hidden="true">⚠️</span>
            <span className="prompt-options-menu-badge-text">{summaryLabel || 'Invalid'}</span>
          </span>
          <button
            type="button"
            className="prompt-options-unstage-btn"
            aria-label="Clear staged prompt options"
            title="Clear invalid options"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
          >
            ✕
          </button>
        </div>
      );
    }

    if (count === 0) {
      return (
        <button
          type="button"
          className="attach-menu-item prompt-options-menu-item"
          title={fullTooltip}
          disabled={disabled}
          onClick={onOpenModal}
        >
          <SlidersIcon />
          <span className="prompt-options-menu-label">{menuLabel}</span>
        </button>
      );
    }

    return (
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        className={`attach-menu-item prompt-options-menu-item is-armed${disabled ? ' is-disabled' : ''}`}
        title={fullTooltip}
        onClick={() => {
          if (!disabled) onOpenModal();
        }}
        onKeyDown={handleKeyDown}
        aria-label={`Prompt options: ${tags.join(', ')}`}
      >
        <SlidersIcon />
        <span className="prompt-options-menu-label">{menuLabel}</span>
        <span className="prompt-options-menu-badge">
          <span className="prompt-options-armed-icon" aria-hidden="true">{sticky ? '📌' : '⚡'}</span>
          <span className="prompt-options-menu-badge-text">{summaryLabel}</span>
        </span>
        <button
          type="button"
          className="prompt-options-unstage-btn"
          aria-label="Clear staged prompt options"
          title="Clear staged options"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        className={`prompt-options-pill prompt-options-pill-armed prompt-options-pill-error${disabled ? ' is-disabled' : ''}`}
        title={fullTooltip}
        onClick={() => {
          if (!disabled) onOpenModal();
        }}
        onKeyDown={handleKeyDown}
        aria-label={`Prompt options error: ${error}`}
      >
        <span className="prompt-options-armed-icon" aria-hidden="true">⚠️</span>
        <span className="prompt-options-pill-label">{summaryLabel || 'Invalid option'}</span>
        <button
          type="button"
          className="prompt-options-unstage-btn"
          aria-label="Clear staged prompt options"
          title="Clear invalid options"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  if (count === 0) {
    return (
      <button
        type="button"
        className="prompt-options-pill prompt-options-pill-idle"
        title={fullTooltip}
        disabled={disabled}
        onClick={onOpenModal}
      >
        <span className="prompt-options-pill-icon" aria-hidden="true">🎛</span>
        <span className="prompt-options-pill-label">Options</span>
      </button>
    );
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      className={`prompt-options-pill prompt-options-pill-armed${disabled ? ' is-disabled' : ''}`}
      title={fullTooltip}
      onClick={() => {
        if (!disabled) onOpenModal();
      }}
      onKeyDown={handleKeyDown}
      aria-label={`Prompt options: ${tags.join(', ')}`}
    >
      <span className="prompt-options-armed-icon" aria-hidden="true">{sticky ? '📌' : '⚡'}</span>
      <span className="prompt-options-pill-label">{summaryLabel}</span>
      <button
        type="button"
        className="prompt-options-unstage-btn"
        aria-label="Clear staged prompt options"
        title="Clear staged options"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
      >
        ✕
      </button>
    </div>
  );
}
