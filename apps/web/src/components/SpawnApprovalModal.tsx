import { useState } from 'react';
import type { SpawnRequestRow } from '@tierwyn/shared';

function relativeTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

interface Props {
  requests: SpawnRequestRow[];
  onApprove: (id: string) => Promise<void>;
  onDeny: (id: string, reason?: string) => Promise<void>;
  onClose: () => void;
}

function SpawnRequestRow({ req, onApprove, onDeny }: {
  req: SpawnRequestRow;
  onApprove: (id: string) => Promise<void>;
  onDeny: (id: string, reason?: string) => Promise<void>;
}) {
  const [denyExpanded, setDenyExpanded] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setBusy(true); setError(null);
    try { await onApprove(req.id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  const handleDeny = async () => {
    setBusy(true); setError(null);
    try { await onDeny(req.id, denyReason || undefined); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  const label = req.role ?? req.profileId ?? 'unknown';
  const workdirBadge = req.workdir ?? 'shared';
  // The queue is operator-global — requests may belong to a conversation the
  // operator isn't viewing. Surface the parent conversation (short id) so it's
  // clear which session the spawn came from.
  const parentShort = req.parentConversationId.slice(0, 8);

  return (
    <li className="spawn-approval-row">
      <div className="spawn-approval-row-head">
        <span className="spawn-approval-role">{label}</span>
        <span className="spawn-approval-workdir">{workdirBadge}</span>
        <span className="spawn-approval-parent" title={`parent conversation: ${req.parentConversationId}`}>from {parentShort}</span>
        <span className="summary-list-time">{relativeTime(req.createdAt)}</span>
      </div>
      {/* Full prompt — scrollable pre, not truncated */}
      <pre className="spawn-approval-prompt">{req.prompt}</pre>
      <div className="spawn-approval-actions">
        <button type="button" className="spawn-approval-btn approve" disabled={busy} onClick={() => void handleApprove()}>
          Approve
        </button>
        {denyExpanded ? (
          <>
            <input
              className="spawn-approval-reason"
              type="text"
              placeholder="Deny reason (optional)"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleDeny(); }}
              autoFocus
            />
            <button type="button" className="spawn-approval-btn deny" disabled={busy} onClick={() => void handleDeny()}>
              Confirm Deny
            </button>
            <button type="button" className="spawn-approval-btn cancel" disabled={busy} onClick={() => { setDenyExpanded(false); setDenyReason(''); }}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="spawn-approval-btn deny" disabled={busy} onClick={() => setDenyExpanded(true)}>
            Deny
          </button>
        )}
      </div>
      {error && <div className="spawn-approval-error">{error} — refreshing…</div>}
    </li>
  );
}

export function SpawnApprovalModal({ requests, onApprove, onDeny, onClose }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content summary-list-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Pending Spawn Requests</span>
          <button type="button" className="usage-close" onClick={onClose} style={{ fontSize: '18px' }} aria-label="Close">×</button>
        </div>
        <div className="summary-list-body">
          {requests.length === 0 ? (
            <div className="summary-list-empty">No pending spawn requests across any conversation.</div>
          ) : (
            <ul className="summary-list spawn-approval-list">
              {requests.map((req) => (
                <SpawnRequestRow key={req.id} req={req} onApprove={onApprove} onDeny={onDeny} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
