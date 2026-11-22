import React, { useState } from 'react';
import type { SandboxSetting } from '@tierwyn/shared';
import type { SandboxControlState } from '../sandboxControl.js';
import { SandboxModal } from './SandboxModal.js';

export interface SandboxPillProps {
  state: SandboxControlState | null;
  value: SandboxSetting | null;
  disabled?: boolean;
  asMenuItem?: boolean;
  onChange: (v: SandboxSetting | null) => void;
}

export function SandboxPill({
  state,
  value,
  disabled,
  asMenuItem = false,
  onChange,
}: SandboxPillProps) {
  const [modalOpen, setModalOpen] = useState(false);

  if (state === null) return null;

  const triggerDisabled = !!(disabled || state.locked);
  const title = state.locked
    ? `${state.label} — enforced by remote host policy`
    : state.warning
      ? `${state.label} — turn ran (or will run) unsandboxed`
      : `${state.label} (click to configure)`;

  const isOn = state.on;
  const badgeColor = state.warning
    ? 'var(--amber, #f59e0b)'
    : isOn ? 'var(--emerald, #10b981)' : 'var(--text-3, #888888)';
  const badgeBg = state.warning
    ? 'rgba(245, 158, 11, 0.15)'
    : isOn ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.08)';
  const warningClass = state.warning ? ' sandbox-pill-warning' : '';

  const lockIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );

  const badge = (
    <span
      style={{
        fontSize: asMenuItem ? 10 : 11,
        fontWeight: 600,
        padding: asMenuItem ? '2px 6px' : undefined,
        borderRadius: asMenuItem ? 4 : undefined,
        color: badgeColor,
        background: asMenuItem ? badgeBg : undefined,
        textTransform: 'uppercase',
        letterSpacing: asMenuItem ? '0.04em' : '0.03em',
      }}
    >
      {isOn ? 'on' : 'off'}
    </span>
  );

  return (
    <>
      {asMenuItem ? (
        <button
          type="button"
          className={`attach-menu-item sandbox-menu-item${warningClass}`}
          onClick={() => { if (!triggerDisabled) setModalOpen(true); }}
          disabled={triggerDisabled}
          title={title}
          aria-label={state.label}
          style={{ justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {lockIcon}
            <span>Sandbox</span>
          </div>
          {badge}
        </button>
      ) : (
        <div className={`effort-pill sandbox-pill${warningClass}`}>
          <button
            type="button"
            className="effort-pill-trigger"
            onClick={() => { if (!triggerDisabled) setModalOpen(true); }}
            disabled={triggerDisabled}
            title={title}
            aria-label={state.label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', height: 28, boxSizing: 'border-box' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', color: badgeColor }}>
              {lockIcon}
            </span>
            {badge}
          </button>
        </div>
      )}

      {modalOpen && (
        <SandboxModal
          state={state}
          value={value}
          onClose={() => setModalOpen(false)}
          onChange={onChange}
        />
      )}
    </>
  );
}
