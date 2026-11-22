import type { HandoffOverride } from '@tierwyn/shared';
import type { HandoffChoiceOptions } from '../handoffChoice.js';

interface PendingHandoff {
  fromLabel: string;
  toLabel: string;
}

interface Props {
  pending: PendingHandoff;
  options: HandoffChoiceOptions;
  onChoose: (choice: 'continue' | HandoffOverride) => void;
  onCancel: () => void;
}

// Splits a profile label into [agent, model] on the " · " separator the
// catalogue emits. When there's no separator (e.g. a raw fallback string),
// returns [label, ''] so the pill renders one line cleanly instead of an
// empty second line.
function splitLabel(label: string): [string, string] {
  const idx = label.indexOf(' · ');
  if (idx === -1) return [label, ''];
  return [label.slice(0, idx), label.slice(idx + 3)];
}

function RoutePill({ label, variant }: { label: string; variant: 'from' | 'to' }) {
  const [agent, model] = splitLabel(label);
  return (
    <span className={`handoff-route-pill ${variant}`}>
      <span className="handoff-route-pill-agent">{agent}</span>
      {model && <span className="handoff-route-pill-model">{model}</span>}
    </span>
  );
}

export function HandoffChoiceModal({ pending, options, onChoose, onCancel }: Props) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content handoff-choice-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Switch agent / model</span>
          <button className="usage-close" onClick={onCancel} style={{ fontSize: '18px' }}>×</button>
        </div>
        <div className="handoff-route">
          <RoutePill label={pending.fromLabel} variant="from" />
          <span className="handoff-route-arrow">→</span>
          <RoutePill label={pending.toLabel} variant="to" />
        </div>
        <p className="handoff-choice-intro">How should this conversation continue?</p>
        <div className="handoff-choice-cards">
          {options.continue && (
            <button type="button" className="handoff-choice-card" onClick={() => onChoose('continue')}>
              <div className="handoff-choice-card-title">Continue same session</div>
              <div className="handoff-choice-card-body">
                Keep the agent&apos;s own session; only the model changes.
              </div>
            </button>
          )}
          {options.fresh && (
            <button type="button" className="handoff-choice-card" onClick={() => onChoose('fresh')}>
              <div className="handoff-choice-card-title">New session</div>
              <div className="handoff-choice-card-body">
                Start clean. The agent sees none of the earlier turns (the transcript stays here).
              </div>
            </button>
          )}
          {options.summary && (
            <button type="button" className="handoff-choice-card" onClick={() => onChoose('summary')}>
              <div className="handoff-choice-card-title">Hand off · Summary</div>
              <div className="handoff-choice-card-body">
                Run a summarizer over the history and pass a compact summary.
                Faster, smaller context — but lossy.
              </div>
            </button>
          )}
          {options.transcript && (
            <button type="button" className="handoff-choice-card" onClick={() => onChoose('transcript')}>
              <div className="handoff-choice-card-title">Hand off · Full transcript</div>
              <div className="handoff-choice-card-body">
                Send the entire conversation verbatim. Faithful, but uses more
                context and may not fit on long conversations.
              </div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
