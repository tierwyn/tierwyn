import type { BtwQuery } from '@tierwyn/shared';

interface Props {
  queries: BtwQuery[];
  onSelect: (q: BtwQuery) => void;
  onClose: () => void;
}

function relativeTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function BtwListModal({ queries, onSelect, onClose }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content summary-list-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>BTW Side Questions</span>
          <button type="button" className="usage-close" onClick={onClose} style={{ fontSize: '18px' }} aria-label="Close">×</button>
        </div>
        <div className="summary-list-body">
          {queries.length === 0 ? (
            <div className="summary-list-empty">No /btw questions yet for this conversation.</div>
          ) : (
            <ul className="summary-list">
              {queries.map((q) => (
                <li key={q.id}>
                  <button
                    type="button"
                    className="summary-list-row"
                    onClick={() => onSelect(q)}
                  >
                    <div className="summary-list-row-head">
                      <span className="summary-list-route">
                        <span className={`btw-dot btw-dot-${q.status}`} style={{ flexShrink: 0 }} />
                        <span>{q.question.slice(0, 120)}{q.question.length > 120 ? '…' : ''}</span>
                      </span>
                      <span className="summary-list-time">{relativeTime(q.createdAt)}</span>
                    </div>
                    {q.status === 'done' && q.answer && (
                      <div className="summary-list-preview">{q.answer.slice(0, 140)}{(q.answer.length) > 140 ? '…' : ''}</div>
                    )}
                    {q.status === 'error' && (
                      <div className="summary-list-preview" style={{ color: 'var(--red)' }}>{q.errorMessage ?? 'Error'}</div>
                    )}
                    {q.status === 'asking' && (
                      <div className="summary-list-preview" style={{ color: 'var(--text-3)' }}>Asking…</div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
