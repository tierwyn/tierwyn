import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { PROMPT_NAME_MAX, PROMPT_DESCRIPTION_MAX, type PromptCollectionEntry } from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { api } from '../api.js';

interface Props {
  initialBody: string;
  onClose: () => void;
  onSaved?: (entry: PromptCollectionEntry) => void;
}

export function SavePromptModal({ initialBody, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave =
    name.trim() !== '' &&
    description.trim() !== '' &&
    body.trim() !== '' &&
    !busy;

  async function handleSave(e?: FormEvent) {
    if (e) e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const payload: PromptCollectionEntry = {
        id: '',
        name: name.trim(),
        description: description.trim(),
        body: body.trim(),
        origin: 'custom',
      };
      const list = await api.saveCustomPrompt(payload);
      const saved = list.find((item) => item.name === payload.name) ?? payload;
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSave();
    }
  }

  return (
    <Modal title="Save to Prompt Collection" onClose={onClose} className="prompt-collection-modal save-prompt-modal">
      <form onSubmit={handleSave} className="prompt-collection-form" onKeyDown={onKeyDown}>
        <label className="modal-field">
          <span className="modal-label">Name</span>
          <input
            type="text"
            className="modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={PROMPT_NAME_MAX}
            placeholder="e.g. Code Review Checklist"
            autoFocus
          />
        </label>
        <label className="modal-field">
          <span className="modal-label">Description</span>
          <input
            type="text"
            className="modal-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={PROMPT_DESCRIPTION_MAX}
            placeholder="e.g. Detailed correctness and security checklist for code changes"
          />
        </label>
        <label className="modal-field">
          <span className="modal-label">Prompt Body</span>
          <textarea
            className="modal-input prompt-collection-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            placeholder="Enter the prompt body..."
          />
        </label>
        {error && <div style={{ color: 'var(--red)', fontSize: '13px' }}>{error}</div>}
        <div className="modal-footer" style={{ marginTop: 12 }}>
          <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="modal-btn primary" disabled={!canSave}>
            {busy ? 'Saving…' : 'Save to Collection'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
