import { formatElapsedMs, type SubtreeTimeSummary } from '@tierwyn/shared';
import { Modal } from './Modal.js';

interface Props {
  summary: SubtreeTimeSummary;
  runningIds: Set<string>;
  waitingMs: number | null;
  onOpenConversation?: (id: string) => void;
  onClose: () => void;
}

export function SubagentStatsModal({ summary, runningIds, waitingMs, onOpenConversation, onClose }: Props) {
  const subs = summary.nodes.filter((n) => n.depth > 0);
  const running = subs.filter((n) => runningIds.has(n.conversationId)).length;
  const ge = running > 0 ? '≥ ' : '';
  const maxDepth = subs.reduce((m, n) => Math.max(m, n.depth), 0);
  const turns = subs.reduce((s, n) => s + n.turns, 0);
  const stats: [string, string][] = [
    ['This conversation', formatElapsedMs(summary.selfMs)],
    ...(waitingMs != null && waitingMs > 0 ? [['Waiting for you', formatElapsedMs(waitingMs)] as [string, string]] : []),
    ['Subagent tree', ge + formatElapsedMs(summary.descendantsMs)],
    ['Total effort', ge + formatElapsedMs(summary.totalMs)],
    ['Subagents', `${summary.descendantCount}${summary.truncated ? ` + ${summary.omittedCount} omitted (tree truncated)` : ''}`],
    ['Running now', String(running)],
    ['Subagent turns', String(turns)],
    ['Max depth', String(maxDepth)],
  ];
  return (
    <Modal title="Subagent stats" onClose={onClose} className="subagent-stats-modal">
      <dl className="subagent-stats-grid">
        {stats.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      <table className="subagent-stats-table">
        <thead>
          <tr><th>Subagent</th><th>Worked</th><th>Turns</th><th>Last activity</th></tr>
        </thead>
        <tbody>
          {subs.map((n) => (
            <tr key={n.conversationId}>
              <td style={{ paddingLeft: 6 + (n.depth - 1) * 14 }}>
                <button
                  type="button"
                  className="conversation-elapsed-node"
                  onClick={() => { onClose(); onOpenConversation?.(n.conversationId); }}
                >
                  {n.title}{runningIds.has(n.conversationId) ? ' ●' : ''}
                </button>
              </td>
              <td>{formatElapsedMs(n.workedMs)}</td>
              <td>{n.turns}</td>
              <td>{n.lastEventTs ? new Date(n.lastEventTs).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="subagent-stats-note">Computed {new Date(summary.computedAt).toLocaleTimeString()} · click a subagent to open it.</p>
    </Modal>
  );
}
