import { useState } from 'react';
import type { Checkpoint, RewindConversationResponse } from '@tierwyn/shared';
import { Modal } from './Modal.js';

type Step = 'choose' | 'confirm' | 'running' | 'result';
type Selection = 'conv-only' | 'both' | 'code-only';

interface RestoreChoiceModalProps {
  checkpoint: Checkpoint;
  hasCodeChanges: boolean;
  isSharedRoot: boolean;
  /** Call the rewind API; throws on failure (error carries .status / .codeSkippedReason). */
  onRestore: (opts: {
    rewindConversation: boolean;
    rewindCode: boolean;
    confirmSharedCode: boolean;
  }) => Promise<RewindConversationResponse>;
  onClose: () => void;
}

// ponytail: copy map for every codeSkippedReason the server can return.
const CODE_SKIPPED_COPY: Record<string, string> = {
  shared_tree: 'Shared root rewrite needs explicit confirmation.',
  diverged: 'Code restore could not complete (a git operation failed). Your files were not changed.',
  no_ref: 'This checkpoint has no code snapshot to restore.',
  not_git: "Project directory isn't a git repository; code restore is unavailable.",
  remote_host: 'Code restore is not available for remote-host projects yet.',
};

function codeBlock(cmd: string) {
  return (
    <code style={{ fontFamily: 'var(--mono)', fontSize: '12px', background: 'var(--accent-bg)', padding: '1px 5px', borderRadius: '3px' }}>
      {cmd}
    </code>
  );
}

export function RestoreChoiceModal({
  checkpoint: cp,
  hasCodeChanges,
  isSharedRoot,
  onRestore,
  onClose,
}: RestoreChoiceModalProps) {
  const [step, setStep] = useState<Step>('choose');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [result, setResult] = useState<RewindConversationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pick(sel: Selection) {
    setSelection(sel);
    setStep('confirm');
  }

  async function runRestore() {
    if (!selection) return;
    setStep('running');
    try {
      const r = await onRestore({
        rewindConversation: selection !== 'code-only',
        rewindCode: selection !== 'conv-only',
        confirmSharedCode: isSharedRoot,
      });
      setResult(r);
      setStep('result');
    } catch (err) {
      const e = err as Error & { codeSkippedReason?: string; status?: number; error?: string };
      let msg: string;
      if (e.status === 409 && e.error === 'conversation has a live session') {
        msg = 'Stop the current agent turn before restoring.';
      } else if (e.codeSkippedReason && CODE_SKIPPED_COPY[e.codeSkippedReason]) {
        msg = CODE_SKIPPED_COPY[e.codeSkippedReason];
      } else if ((e.error ?? e.message ?? '').includes('not available for remote-host projects (P3)')) {
        msg = CODE_SKIPPED_COPY.remote_host;
      } else {
        msg = e.message ?? 'Restore failed.';
      }
      setError(msg);
      setStep('result');
    }
  }

  // ── Step: choose ──────────────────────────────────────────────────────────
  if (step === 'choose') {
    const previewText = cp.promptPreview ? cp.promptPreview.replace(/\s+/g, ' ').trim() : '';
    const previewShort = previewText.slice(0, 80);
    const titleHint = previewShort
      || cp.label
      || (cp.turnIndex != null ? `Turn ${cp.turnIndex}` : '');
    return (
      <Modal title={titleHint ? `Restore checkpoint — ${titleHint}` : 'Restore checkpoint'} onClose={onClose}>
        {(previewShort || cp.turnIndex != null) && (
          <div className="summary-list-preview" style={{ marginBottom: '12px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {cp.turnIndex != null && (
              <span className="summary-list-mode-pill">Turn {cp.turnIndex}</span>
            )}
            {previewShort && <span>{previewShort}{previewText.length > 80 ? '…' : ''}</span>}
          </div>
        )}
        <p style={{ fontSize: '13px', color: 'var(--text-3)', marginBottom: '16px' }}>
          How should this checkpoint be restored?
        </p>
        <div className="handoff-choice-cards">
          <button type="button" className="handoff-choice-card" onClick={() => pick('conv-only')}>
            <div className="handoff-choice-card-title">Conversation only</div>
            <div className="handoff-choice-card-body">
              Rewind the transcript to this point. Events after it are removed. Your files are left untouched.
            </div>
          </button>
          {hasCodeChanges && (
            <button type="button" className="handoff-choice-card" onClick={() => pick('both')}>
              <div className="handoff-choice-card-title">
                Code + conversation
                <span style={{ fontSize: '11px', background: 'var(--accent-bg)', color: 'var(--accent)', border: '1px solid var(--accent-border)', borderRadius: '4px', padding: '1px 6px', marginLeft: '8px' }}>
                  Recommended
                </span>
              </div>
              <div className="handoff-choice-card-body">
                Rewind the transcript <em>and</em> restore the project files to this checkpoint, so code and conversation stay in sync.
              </div>
            </button>
          )}
          {hasCodeChanges && (
            <button type="button" className="handoff-choice-card" onClick={() => pick('code-only')} style={{ opacity: 0.75 }}>
              <div className="handoff-choice-card-title">
                Code only
                <span style={{ fontSize: '11px', color: 'var(--text-3)', marginLeft: '8px' }}>(advanced)</span>
              </div>
              <div className="handoff-choice-card-body">
                Restore files only. The transcript will <strong>not</strong> match the restored code.
              </div>
            </button>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose}>Cancel</button>
        </div>
      </Modal>
    );
  }

  // ── Step: confirm ─────────────────────────────────────────────────────────
  if (step === 'confirm') {
    const codeInvolved = selection !== 'conv-only';
    // Destructive = worktree reset --hard (not shared-root restore which is more reversible)
    const isDestructiveWorktree = codeInvolved && !isSharedRoot;

    let confirmBody: React.ReactNode;
    if (!codeInvolved) {
      confirmBody = <p>Events after this checkpoint will be removed. Continue?</p>;
    } else if (isSharedRoot) {
      confirmBody = (
        <p>
          This overwrites tracked files in the <strong>shared project root</strong> with the
          checkpoint's contents and stages the change. Your current uncommitted edits are
          saved to a <em>Before restore</em> checkpoint first, so you can undo. Your branch
          history (HEAD) is not moved.
        </p>
      );
    } else {
      // Worktree destructive path
      confirmBody = (
        <>
          <p>
            This runs {codeBlock('git reset --hard')} + {codeBlock('git clean -fd')} on this
            chat's worktree.
          </p>
          {/* ponytail: inline rgba consistent with the accent-alpha convention; no red hardcode */}
          <p style={{ marginTop: '10px', fontWeight: 600, borderLeft: '3px solid rgba(239,68,68,0.5)', paddingLeft: '10px' }}>
            Uncommitted changes in the worktree will be permanently lost.
          </p>
          {selection === 'code-only' && (
            <p style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-3)' }}>
              A one-off <em>Before restore</em> checkpoint will be saved first so you can undo.
            </p>
          )}
        </>
      );
    }

    return (
      <Modal title="Confirm restore" onClose={() => setStep('choose')}>
        <div style={{ fontSize: '14px', color: 'var(--text-2)', lineHeight: 1.7 }}>
          {confirmBody}
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={() => setStep('choose')}>Back</button>
          <button
            type="button"
            className={`modal-btn ${isDestructiveWorktree ? 'danger' : 'primary'}`}
            onClick={() => { void runRestore(); }}
          >
            {isDestructiveWorktree ? 'Restore (destructive)' : 'Restore'}
          </button>
        </div>
      </Modal>
    );
  }

  // ── Step: running ─────────────────────────────────────────────────────────
  if (step === 'running') {
    return (
      <Modal title="Restoring…" onClose={() => {}}>
        <div style={{ fontSize: '14px', color: 'var(--text-2)', padding: '8px 0' }}>
          Working…
        </div>
      </Modal>
    );
  }

  // ── Step: result ──────────────────────────────────────────────────────────
  if (error) {
    return (
      <Modal title="Restore failed" onClose={onClose}>
        <div style={{ fontSize: '14px', color: 'var(--text-2)', lineHeight: 1.6 }}>
          <p>{error}</p>
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn primary" onClick={onClose}>OK</button>
        </div>
      </Modal>
    );
  }

  // Success result
  const infoLines: string[] = [];
  if (result?.nativeDrift) {
    infoLines.push(
      "Conversation rewound. Native session couldn't be forked — the next turn will use compaction over the trimmed transcript.",
    );
  } else if (selection !== 'code-only') {
    infoLines.push('Conversation rewound to this checkpoint.');
  }
  if (result?.codeApplied) {
    infoLines.push('Project files restored to this checkpoint.');
  }
  if (result?.codeSkippedReason) {
    infoLines.push(
      CODE_SKIPPED_COPY[result.codeSkippedReason] ?? `Code not restored: ${result.codeSkippedReason}`,
    );
  }

  return (
    <Modal title="Restore complete" onClose={onClose}>
      <div style={{ fontSize: '14px', color: 'var(--text-2)', lineHeight: 1.6 }}>
        {infoLines.length > 0 ? (
          <ul style={{ paddingLeft: '16px', margin: 0 }}>
            {infoLines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        ) : (
          <p>Done.</p>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="modal-btn primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
