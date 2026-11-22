import { useEffect, useState } from 'react';
import type { Checkpoint } from '@tierwyn/shared';
import { api } from '../api.js';
import { CheckpointDiffModal } from './CheckpointDiffModal.js';

interface Props {
  conversationId: string;
  checkpoints: Checkpoint[];
  workdirPath?: string;
  isRunning: boolean;
  /** True while a restore is already in flight — prevent launching a second. */
  restoreInFlight?: boolean;
  onRestore: (checkpoint: Checkpoint, hasCodeChanges: boolean) => void;
  onClose: () => void;
  /** Remote-host projects 409 on code-diff (P3) — skip fetch, no code restore. */
  skipCodeDiff?: boolean;
}

function relativeTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}


/** Lists checkpoints newest-first with a single "Restore…" action per row. */
export function CheckpointListModal({
  conversationId,
  checkpoints,
  workdirPath: _workdirPath,
  isRunning,
  restoreInFlight = false,
  onRestore,
  onClose,
  skipCodeDiff = false,
}: Props) {
  const sorted = [...checkpoints].sort((a, b) => b.createdAt - a.createdAt);
  const [diffByCheckpointId, setDiffByCheckpointId] = useState<Record<string, { hasChanges: boolean; add: number; del: number } | undefined>>({});
  const [diffViewerFor, setDiffViewerFor] = useState<Checkpoint | null>(null);

  useEffect(() => {
    if (skipCodeDiff) {
      setDiffByCheckpointId({});
      return;
    }
    let cancelled = false;
    const withCode = checkpoints.filter((cp) => cp.codeRef);
    setDiffByCheckpointId((prev) => {
      const next: Record<string, { hasChanges: boolean; add: number; del: number } | undefined> = {};
      for (const cp of withCode) next[cp.id] = prev[cp.id];
      return next;
    });
    for (const cp of withCode) {
      void api.checkpointCodeDiff(conversationId, cp.id, 'captured')
        .then((diff) => {
          if (cancelled) return;
          const text = typeof diff === 'string' ? diff : '';
          // ponytail: count unified-diff +/− body lines, skip +++/--- file headers.
          let add = 0; let del = 0;
          for (const line of text.split('\n')) {
            if (line.startsWith('+++') || line.startsWith('---')) continue;
            if (line.startsWith('+')) add++;
            else if (line.startsWith('-')) del++;
          }
          const hasChanges = text.trim().length > 0;
          setDiffByCheckpointId((prev) => ({ ...prev, [cp.id]: { hasChanges, add, del } }));
        })
        .catch(() => {
          if (cancelled) return;
          setDiffByCheckpointId((prev) => ({ ...prev, [cp.id]: { hasChanges: true, add: 0, del: 0 } }));
        });
    }
    return () => { cancelled = true; };
  }, [conversationId, checkpoints, skipCodeDiff]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content summary-list-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Checkpoints</span>
          <button type="button" className="usage-close" onClick={onClose} style={{ fontSize: '18px' }} aria-label="Close">×</button>
        </div>
        <div className="summary-list-body">
          {sorted.length === 0 ? (
            <div className="summary-list-empty">No checkpoints yet for this conversation.</div>
          ) : (
            <ul className="summary-list">
              {sorted.map((cp) => {
                const diffStat = cp.codeRef ? diffByCheckpointId[cp.id] : undefined;
                const hasCodeChanges = !!diffStat?.hasChanges;
                const blocked = isRunning || restoreInFlight;
                const previewText = cp.promptPreview ? cp.promptPreview.replace(/\s+/g, ' ').trim() : '';
                const preview = previewText.slice(0, 140);
                const previewTrunc = previewText.length > 140;
                return (
                  <li key={cp.id}>
                    <div className="summary-list-row" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
                      <div className="summary-list-row-head">
                        <span className="summary-list-route">
                          {cp.label ?? (cp.kind === 'auto' ? 'Auto checkpoint' : 'Manual checkpoint')}
                          {cp.pinned && <span className="summary-list-mode-pill" style={{ marginLeft: '6px' }}>Pinned</span>}
                          {cp.codeRef && <span className="summary-list-mode-pill" style={{ marginLeft: '6px' }}>Code</span>}
                          {cp.turnIndex != null && <span className="summary-list-mode-pill" style={{ marginLeft: '6px' }}>Turn {cp.turnIndex}</span>}
                          {hasCodeChanges && diffStat && (diffStat.add > 0 || diffStat.del > 0) && (
                            <span className="summary-list-mode-pill" style={{ marginLeft: '6px' }}>
                              <span style={{ color: 'var(--accent)' }}>+{diffStat.add}</span>
                              {' / '}
                              <span style={{ color: 'var(--red, #ef4444)' }}>−{diffStat.del}</span>
                            </span>
                          )}
                        </span>
                        <span className="summary-list-time">{relativeTime(cp.createdAt)}</span>
                      </div>
                      {preview && (
                        <div className="summary-list-preview">{preview}{previewTrunc ? '…' : ''}</div>
                      )}
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="modal-btn primary"
                          disabled={blocked}
                          title={blocked ? 'Wait for the current turn to finish' : 'Restore this checkpoint'}
                          onClick={() => onRestore(cp, hasCodeChanges)}
                        >
                          Restore…
                        </button>
                        {hasCodeChanges && (
                          <button
                            type="button"
                            className="modal-btn"
                            title="View the code diff for this checkpoint"
                            onClick={() => setDiffViewerFor(cp)}
                          >
                            View Diff
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {diffViewerFor && (
        <CheckpointDiffModal
          conversationId={conversationId}
          checkpoint={diffViewerFor}
          onClose={() => setDiffViewerFor(null)}
        />
      )}
    </div>
  );
}
