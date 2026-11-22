import { resolvePromptVariables, type PromptCollectionEntry } from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { MarkdownBody } from './MarkdownBody.js';
import { downloadPromptPack, promptFilename } from '../promptPackFile.js';

interface Props {
  entry: PromptCollectionEntry;
  onInsert: (entry: PromptCollectionEntry) => void;
  onEdit?: (entry: PromptCollectionEntry) => void;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
}

export function PromptPreviewModal({ entry, onInsert, onEdit, onClose, onOpenFile }: Props) {
  const vars = resolvePromptVariables(entry);

  return (
    <Modal title={entry.name} onClose={onClose} className="prompt-collection-modal">
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 8 }}>
        {entry.description && (
          <div className="summary-list-preview" style={{ flex: 1, minWidth: 0 }}>
            {entry.description}
          </div>
        )}
        <span className="prompt-origin-chip">{entry.origin === 'preset' ? 'Preset' : 'Custom'}</span>
      </div>
      {vars.length > 0 && (
        <div className="prompt-variable-chips">
          <span className="prompt-variable-chips-label">Variables:</span>
          {vars.map((v) => (
            <span key={v.name} className="prompt-origin-chip">{`{{${v.name}}}`}</span>
          ))}
        </div>
      )}
      <div className="prompt-collection-body prompt-collection-body--full prompt-collection-markdown">
        <MarkdownBody className="event-message" onOpenFile={onOpenFile}>{entry.body}</MarkdownBody>
      </div>
      <div className="modal-footer" style={{ marginTop: 12 }}>
        <button type="button" className="modal-btn" onClick={onClose}>
          Close
        </button>
        {entry.origin === 'custom' && onEdit && (
          <button
            type="button"
            className="modal-btn"
            onClick={() => onEdit(entry)}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          className="modal-btn"
          onClick={() => downloadPromptPack([entry], promptFilename(entry))}
        >
          Export
        </button>
        <button
          type="button"
          className="modal-btn primary"
          autoFocus
          onClick={() => onInsert(entry)}
        >
          Insert
        </button>
      </div>
    </Modal>
  );
}
