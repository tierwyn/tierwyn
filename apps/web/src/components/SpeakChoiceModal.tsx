import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SpeakMode } from '../speak.js';

interface Props {
  summarizeAvailable: boolean;
  /** When false, Speak as-is is shown disabled (e.g. source files). Default true. */
  asIsAvailable?: boolean;
  /** When true, offer "Explain changes" for a git diff. Default false. */
  explainDiffAvailable?: boolean;
  /** When true, show the 4th "Targeted summary…" option. Default false. */
  allowSummarizeGuidance?: boolean;
  /** Optional hint under Summarize (defaults differ for chat vs code). */
  summarizeHint?: string;
  /** Optional hint under Explain changes. */
  explainDiffHint?: string;
  busy?: boolean;
  onChoose: (mode: SpeakMode, opts?: { guidance?: string; targetMinutes?: number }) => void;
  onClose: () => void;
  container?: HTMLElement | null;
}

const MODES: SpeakMode[] = ['as-is', 'summarize', 'explain-diff'];
const TARGET_MINUTE_OPTIONS = [1, 2, 3, 5, 10, 15, 20, 30] as const;

/** Choice dialog for speaker clicks — Cancel leaves current speech running.
 *  ArrowUp/ArrowDown selects option. Enter activates. */
export function SpeakChoiceModal({
  summarizeAvailable,
  asIsAvailable = true,
  explainDiffAvailable = false,
  allowSummarizeGuidance = false,
  summarizeHint,
  explainDiffHint,
  busy,
  onChoose,
  onClose,
  container,
}: Props) {
  const targetedAvailable = allowSummarizeGuidance && summarizeAvailable;
  const enabled: Array<0 | 1 | 2 | 3> = [
    ...(asIsAvailable ? [0 as const] : []),
    ...(summarizeAvailable ? [1 as const] : []),
    ...(explainDiffAvailable ? [2 as const] : []),
    ...(targetedAvailable ? [3 as const] : []),
  ];
  const [selected, setSelected] = useState<0 | 1 | 2 | 3>(() => enabled[0] ?? 0);
  const [step, setStep] = useState<'choice' | 'targeted'>('choice');
  const [guidance, setGuidance] = useState('');
  const [minutes, setMinutes] = useState(0);
  const asIsRef = useRef<HTMLButtonElement>(null);
  const summarizeRef = useRef<HTMLButtonElement>(null);
  const explainRef = useRef<HTMLButtonElement>(null);
  const targetedRef = useRef<HTMLButtonElement>(null);
  const guidanceRef = useRef<HTMLTextAreaElement>(null);

  const chooseTargeted = () => onChoose('summarize', {
    ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
    ...(minutes > 0 ? { targetMinutes: minutes } : {}),
  });

  useEffect(() => {
    setSelected(enabled[0] ?? 0);
    // Recompute when availability flags change; `enabled` is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asIsAvailable, summarizeAvailable, explainDiffAvailable, allowSummarizeGuidance]);

  useEffect(() => {
    if (step !== 'choice') return;
    if (selected === 0) asIsRef.current?.focus();
    else if (selected === 1) summarizeRef.current?.focus();
    else if (selected === 2) explainRef.current?.focus();
    else targetedRef.current?.focus();
  }, [selected, step]);

  useEffect(() => {
    if (step === 'targeted') guidanceRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (step === 'targeted') {
        if (e.key === 'Escape') {
          e.preventDefault();
          setStep('choice');
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return;
        if (e.key === 'Enter') {
          if (e.target instanceof HTMLButtonElement) return;
          const inTextarea = e.target === guidanceRef.current;
          if (inTextarea && e.shiftKey) return;
          e.preventDefault();
          chooseTargeted();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (enabled.length < 2) return;
        e.preventDefault();
        setSelected((prev) => {
          const idx = enabled.indexOf(prev);
          const base = idx < 0 ? 0 : idx;
          const next = e.key === 'ArrowDown'
            ? enabled[(base + 1) % enabled.length]!
            : enabled[(base - 1 + enabled.length) % enabled.length]!;
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (enabled.includes(selected)) {
          if (selected === 3) setStep('targeted');
          else onChoose(MODES[selected]!);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, enabled, onChoose, onClose, step, guidance, minutes]);

  const summarizeBody = summarizeHint
    ?? (summarizeAvailable
      ? 'LLM rewrite into conversational spoken language'
      : 'Configure Voice → Transcript cleanup provider/model first');

  const explainBody = explainDiffHint
    ?? (explainDiffAvailable
      ? 'What this diff changes, in plain English'
      : 'Open a diff and configure the TTS summarize LLM first');

  const btnStyle = { textAlign: 'left' as const, display: 'flex' as const, flexDirection: 'column' as const, gap: 4, padding: '12px 14px' };

  const target =
    container ??
    (typeof document !== 'undefined' ? (document.fullscreenElement as HTMLElement | null) : null) ??
    (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;

  // ponytail: portal to body (or fullscreen element when active) — FileModal's
  // .file-modal-md is overflow:hidden + animated when windowed.
  // Must stack above FileModal and host Modals (modal-overlay--top z-index: 1200).
  return createPortal(
    <div
      className="modal-overlay"
      style={{ zIndex: 1300 }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal-content"
        style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="speak-choice-title"
      >
        {step === 'choice' ? (
          <>
        <div className="modal-header" id="speak-choice-title">Read aloud</div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            ref={asIsRef}
            type="button"
            className={`modal-btn${selected === 0 ? ' primary' : ''}`}
            disabled={busy || !asIsAvailable}
            onClick={() => onChoose('as-is')}
            onMouseEnter={() => { if (asIsAvailable) setSelected(0); }}
            title={asIsAvailable ? undefined : 'Not available for source files — use Summarize for speech'}
            style={btnStyle}
          >
            <span style={{ fontWeight: 600 }}>Speak as-is</span>
            <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>
              {asIsAvailable
                ? 'Local cleanup — skips code and tables'
                : 'Not available for source files'}
            </span>
          </button>
          <button
            ref={summarizeRef}
            type="button"
            className={`modal-btn${selected === 1 ? ' primary' : ''}`}
            disabled={busy || !summarizeAvailable}
            onClick={() => onChoose('summarize')}
            onMouseEnter={() => { if (summarizeAvailable) setSelected(1); }}
            title={summarizeAvailable ? undefined : 'Configure Voice → Transcript cleanup provider/model first'}
            style={btnStyle}
          >
            <span style={{ fontWeight: 600 }}>Summarize for speech</span>
            <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>
              {summarizeBody}
            </span>
          </button>
          <button
            ref={explainRef}
            type="button"
            className={`modal-btn${selected === 2 ? ' primary' : ''}`}
            disabled={busy || !explainDiffAvailable}
            onClick={() => onChoose('explain-diff')}
            onMouseEnter={() => { if (explainDiffAvailable) setSelected(2); }}
            title={explainDiffAvailable ? undefined : 'Open a diff and configure the TTS summarize LLM first'}
            style={btnStyle}
          >
            <span style={{ fontWeight: 600 }}>Explain changes</span>
            <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>
              {explainBody}
            </span>
          </button>
          {targetedAvailable && (
            <button
              ref={targetedRef}
              type="button"
              className={`modal-btn${selected === 3 ? ' primary' : ''}`}
              disabled={busy}
              onClick={() => setStep('targeted')}
              onMouseEnter={() => setSelected(3)}
              style={btnStyle}
            >
              <span style={{ fontWeight: 600 }}>Targeted summary…</span>
              <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>
                Focus the summary and set how long it should run
              </span>
            </button>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
          </>
        ) : (
          <>
        <div className="modal-header" id="speak-choice-title">Targeted summary</div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            Focus
            <textarea
              ref={guidanceRef}
              className="modal-input"
              maxLength={500}
              rows={3}
              placeholder="What should the summary focus on? e.g. only the migration steps"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              disabled={busy}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            Target length
            <select
              className="modal-input"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              disabled={busy}
            >
              <option value={0}>Auto</option>
              {TARGET_MINUTE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'minute' : 'minutes'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={() => setStep('choice')} disabled={busy}>
            Back
          </button>
          <button type="button" className="modal-btn primary" onClick={chooseTargeted} disabled={busy}>
            Read aloud
          </button>
          <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
          </>
        )}
      </div>
    </div>,
    target,
  );
}
