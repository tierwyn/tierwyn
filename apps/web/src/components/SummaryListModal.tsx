import { useState } from 'react';
import type { Handoff, Summary } from '@tierwyn/shared';
import { api } from '../api.js';

interface Props {
  /** Current conversation id — used for the ?tree=1 fetch when the toggle is ON. */
  conversationId: string;
  summaries: Summary[];
  handoffsBySummaryId?: Record<string, Handoff>;
  profileLabels?: Record<string, string>;
  onSelect: (text: string, handoff?: Handoff) => void;
  onClose: () => void;
}

function relativeTime(ms: number): string {
  const d = new Date(ms);
  // Europe/London, 24h, en-GB date per project locale.
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function resolvedModeLabel(handoff: Handoff): string {
  if (handoff.resolved_mode === 'compacted') return 'Compacted';
  if (handoff.resolved_mode === 'transcript') return 'Transcript';
  return 'Fresh';
}

/**
 * Lists all summaries recorded for a conversation. Each row opens the
 * existing HandoffSummaryModal when clicked. Reachable from the top-right
 * options dropdown so the user can browse summaries without scrolling
 * to find an inline "View summary" button.
 *
 * Tree-mode toggle (analog of TtsRecordingsModal): when ON, shows summaries
 * for the root ancestor + ALL descendants (semantics A — whole tree under
 * root, from any node). Per decision Q1=A, cross-conversation rows have no
 * matching handoff, so they degrade to the existing "Compaction" tag and
 * `onSelect` falls back to `s.summary_text` — no tree-handoffs route is
 * built. Each row shows a `↳ <title>` source label ONLY in tree mode.
 *
 * Tree state is modal-local (resets on close) by design — keeping it out of
 * App.tsx prevents the dropdown-enable gate from ever being wired to the
 * tree count.
 */
export function SummaryListModal({ conversationId, summaries, handoffsBySummaryId, profileLabels, onSelect, onClose }: Props) {
  // Modal-local tree state — resets to OFF every time the modal opens.
  const [treeMode, setTreeMode] = useState(false);
  const [treeSummaries, setTreeSummaries] = useState<Summary[] | null>(null);
  /** id→title map for source labels, built from the `conversations` field of
   *  the ?tree=1 response. Null when not in tree mode or still loading. */
  const [titleByConvId, setTitleByConvId] = useState<Record<string, string> | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enableTree = async () => {
    setTreeMode(true);
    setTreeLoading(true);
    setError(null);
    try {
      const r = await api.summaries(conversationId, { tree: true });
      setTreeSummaries(r.summaries);
      const map: Record<string, string> = {};
      for (const c of r.conversations ?? []) map[c.id] = c.title;
      setTitleByConvId(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTreeMode(false);
      setTreeSummaries(null);
      setTitleByConvId(null);
    } finally {
      setTreeLoading(false);
    }
  };

  const disableTree = () => {
    setTreeMode(false);
    setTreeSummaries(null);
    setTitleByConvId(null);
  };

  // Effective list rendered in the body: tree set when toggled on, else the
  // per-conversation snapshot passed in via props.
  const effective = treeMode ? (treeSummaries ?? []) : summaries;

  const sourceLabel = (convId: string): string => {
    const title = titleByConvId?.[convId];
    if (title) return `↳ ${title}`;
    return `↳ ${convId.slice(0, 8)}`;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content summary-list-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Summaries</span>
          <button type="button" className="usage-close" onClick={onClose} style={{ fontSize: '18px' }} aria-label="Close">×</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
          <button
            type="button"
            role="switch"
            aria-checked={treeMode}
            aria-label="Show summaries for whole spawn tree"
            className={`toggle-switch${treeMode ? ' on' : ''}`}
            disabled={treeLoading}
            onClick={() => { treeMode ? disableTree() : void enableTree(); }}
          >
            <span className="toggle-knob" />
          </button>
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>
            {treeLoading ? 'Loading tree…' : 'Show whole spawn tree (root + all children)'}
          </span>
        </div>
        <div className="summary-list-body">
          {error && (
            <div className="summary-list-empty" style={{ color: 'var(--danger, #ef4444)' }}>
              {error}
            </div>
          )}
          {effective.length === 0 && !(treeMode && treeLoading) ? (
            <div className="summary-list-empty">
              {treeMode
                ? 'No summaries anywhere in this spawn tree.'
                : 'No summaries yet for this conversation.'}
            </div>
          ) : (
            <ul className="summary-list">
              {effective.map((s) => {
                const handoff = s.id ? handoffsBySummaryId?.[s.id] : undefined;
                const fromLabel = handoff ? (profileLabels?.[handoff.from_profile_id] ?? handoff.from_profile_id) : undefined;
                const toLabel = handoff ? (profileLabels?.[handoff.to_profile_id] ?? handoff.to_profile_id) : undefined;
                const preview = (handoff?.priming_context ?? s.summary_text).slice(0, 140);
                const previewSource = handoff?.priming_context ?? s.summary_text;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="summary-list-row"
                      onClick={() => onSelect(handoff?.priming_context ?? s.summary_text, handoff)}
                    >
                      <div className="summary-list-row-head">
                        <span className="summary-list-route">
                          {handoff ? (
                            <>
                              <span>{fromLabel}</span>
                              <span className="summary-list-arrow">→</span>
                              <span>{toLabel}</span>
                              <span className="summary-list-mode-pill">{resolvedModeLabel(handoff)}</span>
                            </>
                          ) : (
                            <span className="summary-list-no-route">Compaction</span>
                          )}
                        </span>
                        <span className="summary-list-time">{relativeTime(s.created_at)}</span>
                      </div>
                      {treeMode && (
                        <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: -2 }}>
                          {sourceLabel(s.conversation_id)}
                        </div>
                      )}
                      <div className="summary-list-preview">{preview}{previewSource.length > 140 ? '…' : ''}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
