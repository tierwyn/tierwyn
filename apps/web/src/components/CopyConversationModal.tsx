import type { ConversationCopyMode } from '../conversationCopy.js';

interface Props {
  onChoose: (mode: ConversationCopyMode) => void;
  onCancel: () => void;
}

export function CopyConversationModal({ onChoose, onCancel }: Props) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content handoff-choice-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Copy conversation</span>
          <button className="usage-close" onClick={onCancel} style={{ fontSize: '18px' }}>×</button>
        </div>
        <p className="handoff-choice-intro">
          Choose what to include in the clipboard export.
        </p>
        <div className="handoff-choice-cards">
          <button
            type="button"
            className="handoff-choice-card"
            onClick={() => onChoose('markdown')}
          >
            <div className="handoff-choice-card-title">Conversation only</div>
            <div className="handoff-choice-card-body">
              User prompts and agent markdown responses. Tool calls, results, and
              file changes are omitted — good for sharing or pasting into docs.
            </div>
          </button>
          <button
            type="button"
            className="handoff-choice-card"
            onClick={() => onChoose('full')}
          >
            <div className="handoff-choice-card-title">Full transcript</div>
            <div className="handoff-choice-card-body">
              Everything in chronological order: prompts, responses, tool calls,
              results, file changes, errors, and interactions.
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
