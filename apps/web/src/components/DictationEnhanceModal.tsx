import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  cycleSlowChoice, enabledSlowChoices, initialSlowChoice, SLOW_ENHANCE_ORDER, type SlowEnhanceChoice,
} from '../dictationEnhance.js';

interface Props {
  contextAvailable: boolean;
  projectAvailable: boolean;
  projectUnavailableReason?: string;
  defaultChoice: SlowEnhanceChoice;
  onChoose: (choice: SlowEnhanceChoice) => void;
  onClose: () => void;
}

const CONTEXT_HINT = 'Configure Settings → Enhance (provider + model) first';
const PROJECT_HINT = 'Configure Settings → Enhance project reads (adapter + model) first';

const ROWS: Record<SlowEnhanceChoice, { title: string; sub: string }> = {
  project: {
    title: 'Enhance with the project',
    sub: 'One rewrite of the raw transcript; may read the project to correct names. Whisper cleanup LLM is skipped.',
  },
  context: { title: 'Enhance with context', sub: 'One rewrite: fix the transcript and use the recent conversation' },
  cleanup: { title: 'Cleanup only', sub: 'Whisper + transcript cleanup' },
};

/** Slow dictation: project / context / cleanup. ArrowUp/ArrowDown cycle the
 *  enabled rows, Enter activates. Escape / Cancel must not start the mic. */
export function DictationEnhanceModal({
  contextAvailable, projectAvailable, projectUnavailableReason, defaultChoice, onChoose, onClose,
}: Props) {
  const enabledKey = enabledSlowChoices({ contextAvailable, projectAvailable }).join(',');
  const enabledList = (): SlowEnhanceChoice[] => enabledKey.split(',') as SlowEnhanceChoice[];
  const [selected, setSelected] = useState<SlowEnhanceChoice>(() => initialSlowChoice(defaultChoice, enabledList()));
  const refs = useRef<Partial<Record<SlowEnhanceChoice, HTMLButtonElement | null>>>({});

  useEffect(() => {
    setSelected(initialSlowChoice(defaultChoice, enabledKey.split(',') as SlowEnhanceChoice[]));
  }, [defaultChoice, enabledKey]);

  useEffect(() => { refs.current[selected]?.focus(); }, [selected]);

  useEffect(() => {
    const list = enabledKey.split(',') as SlowEnhanceChoice[];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((prev) => cycleSlowChoice(prev, e.key === 'ArrowDown' ? 1 : -1, list));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onChoose(list.includes(selected) ? selected : 'cleanup');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, enabledKey, onChoose, onClose]);

  const disabledHint = (c: SlowEnhanceChoice): string | undefined => {
    if (c === 'context' && !contextAvailable) return CONTEXT_HINT;
    if (c === 'project' && !projectAvailable) return projectUnavailableReason ?? PROJECT_HINT;
    return undefined;
  };

  return createPortal(
    <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={onClose} role="presentation">
      <div
        className="modal-content"
        style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="dictation-enhance-title"
      >
        <div className="modal-header" id="dictation-enhance-title">Slow dictation</div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {SLOW_ENHANCE_ORDER.map((c) => {
            const hint = disabledHint(c);
            return (
              <button
                key={c}
                ref={(el) => { refs.current[c] = el; }}
                type="button"
                className={`modal-btn${selected === c ? ' primary' : ''}`}
                disabled={Boolean(hint)}
                onClick={() => onChoose(c)}
                onMouseEnter={() => { if (!hint) setSelected(c); }}
                title={hint}
                style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px' }}
              >
                <span style={{ fontWeight: 600 }}>{ROWS[c].title}</span>
                <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>{hint ?? ROWS[c].sub}</span>
              </button>
            );
          })}
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
