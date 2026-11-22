import { useState, type KeyboardEvent } from 'react';
import { ENHANCE_INSTRUCTION_MAX, type EnhanceMode, type PromptCollectionEntry } from '@tierwyn/shared';
import { Modal } from './Modal.js';

interface Props {
  entry: PromptCollectionEntry;
  contextAvailable: boolean;
  projectAvailable?: boolean;
  onRun: (mode: EnhanceMode, instruction?: string) => void;
  onClose: () => void;
}

export function PromptEnhanceModal({ entry, contextAvailable, projectAvailable = false, onRun, onClose }: Props) {
  const [instruction, setInstruction] = useState('');

  function run(mode: EnhanceMode) {
    const trimmed = instruction.trim();
    onRun(mode, trimmed || undefined);
  }

  function onInstructionKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run('quick');
    }
  }

  return (
    <Modal title={`Enhance: ${entry.name}`} onClose={onClose} className="prompt-collection-modal">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run('quick');
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="modal-label">Extra instructions (optional)</span>
          <textarea
            className="modal-input"
            style={{ width: '100%' }}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={onInstructionKeyDown}
            placeholder="e.g. focus on the auth middleware; keep it under 10 bullet points"
            maxLength={ENHANCE_INSTRUCTION_MAX}
            autoFocus
            rows={4}
          />
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => run('quick')}
            style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px' }}
          >
            <span style={{ fontWeight: 600 }}>Enhance</span>
            <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>
              Rewrite this template only
            </span>
          </button>
          {contextAvailable && (
            <button
              type="button"
              className="modal-btn"
              onClick={() => run('context')}
              style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px' }}
            >
              <span style={{ fontWeight: 600 }}>Enhance with context</span>
              <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>
                Use the recent conversation to adapt it
              </span>
            </button>
          )}
          {projectAvailable && (
            <button
              type="button"
              className="modal-btn"
              onClick={() => run('project')}
              style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px' }}
            >
              <span style={{ fontWeight: 600 }}>Enhance with the project</span>
              <span style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>
                May read the project to fix names and speech errors. Does not carry out the prompt.
              </span>
            </button>
          )}
        </div>
        <div className="modal-footer" style={{ marginTop: 12 }}>
          <button type="button" className="modal-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
