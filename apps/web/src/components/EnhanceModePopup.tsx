import type { EnhanceMode } from '@tierwyn/shared';

interface Props {
  onPick: (mode: EnhanceMode) => void;
  /** False when only project reads are configured (direct profile unset). */
  quickAvailable?: boolean;
  /** When false, Context-aware is hidden (no active conversation to draw from). */
  contextAvailable?: boolean;
  /** Enhance with the project — server projectConfigured && a conversation is open. */
  projectAvailable?: boolean;
}

/** Quick / Context-aware / Enhance with the project. */
export function EnhanceModePopup({
  onPick, quickAvailable = true, contextAvailable = true, projectAvailable = false,
}: Props) {
  return (
    <div className="enhance-mode-popup" role="menu" aria-label="Enhance mode">
      {quickAvailable && (
        <button type="button" className="enhance-mode-option" role="menuitem" onClick={() => onPick('quick')}>
          <span className="enhance-mode-option-title">Quick</span>
          <span className="enhance-mode-option-hint">Rewrite the draft only</span>
        </button>
      )}
      {quickAvailable && contextAvailable && (
        <button type="button" className="enhance-mode-option" role="menuitem" onClick={() => onPick('context')}>
          <span className="enhance-mode-option-title">Context-aware</span>
          <span className="enhance-mode-option-hint">Use recent conversation</span>
        </button>
      )}
      {projectAvailable && (
        <button type="button" className="enhance-mode-option" role="menuitem" onClick={() => onPick('project')}>
          <span className="enhance-mode-option-title">Enhance with the project</span>
          <span className="enhance-mode-option-hint">May read the project to fix names and speech errors. Does not carry out the prompt.</span>
        </button>
      )}
    </div>
  );
}
