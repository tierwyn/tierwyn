import { useRef, useState } from 'react';
import {
  buildCustomGitPrompt,
  buildMergedWorktreesPrompt,
  buildSplitCommitsPrompt,
  canSubmitGitPrompt,
  gitPromptSubmitHint,
  type GitLlmSubmitTarget,
} from '../gitLlmPrompts.js';
import { shortenCwd } from '../gitWorkingTree.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Modal } from './Modal.js';

interface Props {
  cwd: string;
  onClose: () => void;
  onSubmit: (text: string) => void;
  target?: GitLlmSubmitTarget;
}

export function GitLlmOpsModal({ cwd, onClose, onSubmit, target }: Props) {
  const [customText, setCustomText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sentRef = useRef(false);
  const [sent, setSent] = useState(false);
  const canSubmit = canSubmitGitPrompt(target);
  const hint = gitPromptSubmitHint(target);
  const customPrompt = buildCustomGitPrompt(cwd, customText);

  const agentLine = canSubmit && target?.profileLabel
    ? `${target.profileLabel}${target.conversationTitle ? ` · "${target.conversationTitle}"` : ''}`
    : (hint ?? '');

  const send = (text: string) => {
    if (sentRef.current) return;
    if (!canSubmit) {
      setConfirmDelete(false);
      return;
    }
    sentRef.current = true;
    setSent(true);
    onSubmit(text);
  };

  const sendCustom = () => {
    if (customPrompt) send(customPrompt);
  };

  return (
    <>
      <Modal
        title="LLM git operations"
        overlayClassName="modal-overlay--stack-2"
        onClose={() => { if (!confirmDelete) onClose(); }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          <div>
            <span>Target: </span>
            <span style={{ fontFamily: 'var(--mono)' }}>{shortenCwd(cwd)}</span>
          </div>
          <div>Agent: {agentLine}</div>
          {canSubmit && hint && <div>{hint}</div>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
          <div>
            <button
              type="button"
              className="modal-btn"
              style={{ width: '100%' }}
              disabled={!canSubmit}
              onClick={() => send(buildSplitCommitsPrompt(cwd))}
            >
              Split into logical commits
            </button>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
              Reviews every staged and unstaged change and commits them in coherent groups.
            </div>
          </div>
          <div>
            <button
              type="button"
              className="modal-btn danger"
              style={{ width: '100%' }}
              disabled={!canSubmit}
              onClick={() => setConfirmDelete(true)}
            >
              Delete merged worktrees
            </button>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
              Lists the project's worktrees and removes only those fully merged into the main branch.
            </div>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Custom git prompt</div>
          <textarea
            className="git-wt-commit-textarea"
            rows={4}
            placeholder="e.g. rebase my branch onto main and resolve conflicts"
            value={customText}
            disabled={!canSubmit}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                sendCustom();
              }
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button
              type="button"
              className="modal-btn primary"
              disabled={!canSubmit || !customPrompt}
              onClick={sendCustom}
            >
              Send
            </button>
          </div>
        </div>
      </Modal>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete merged worktrees?"
          danger
          overlayClassName="modal-overlay--stack-3"
          confirmLabel="Send to agent"
          busy={sent}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => send(buildMergedWorktreesPrompt(cwd))}
          body={(
            <>
              The agent will list the worktrees of <span style={{ fontFamily: 'var(--mono)' }}>{cwd}</span> and
              remove only those whose branch is fully merged into the main branch. It never touches the primary
              checkout and never uses --force. Review its report before trusting the result.
            </>
          )}
        />
      )}
    </>
  );
}
