import { useEffect, useMemo, useState } from 'react';
import type {
  GitBranchDiffResponse,
  GitBranchRef,
  GitCommitFileStatus,
  VoiceTtsSettings,
} from '@tierwyn/shared';
import { fetchGitBranchDiff, UnauthorizedError } from '../api.js';
import { Modal } from './Modal.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';
import { GitCommitFileModal } from './GitCommitFileModal.js';
import { renderStatusBadge, splitPath } from './gitStatusBadge.js';

interface Props {
  cwd: string;
  conversationId?: string;
  projectId?: string;
  branches: GitBranchRef[];
  initialBase?: string;
  initialTarget?: string;
  onClose: () => void;
  onUnauthorized?: () => void;
  tts?: VoiceTtsSettings | null;
  ttsSummarizeAvailable?: boolean;
}

export function GitBranchCompareModal({
  cwd,
  conversationId,
  projectId,
  branches,
  initialBase,
  initialTarget,
  onClose,
  onUnauthorized,
  tts,
  ttsSummarizeAvailable = false,
}: Props) {
  const ctx = { cwd, conversationId, projectId };

  const currentBranch = useMemo(
    () => branches.find((b) => b.isCurrent)?.name ?? '',
    [branches],
  );

  const defaultBase = useMemo(() => {
    if (initialBase) return initialBase;
    const prodBranch = branches.find((b) => b.name === 'main' || b.name === 'master');
    if (prodBranch && prodBranch.name !== currentBranch) return prodBranch.name;
    const remoteProd = branches.find((b) => b.name === 'origin/main' || b.name === 'origin/master');
    if (remoteProd && remoteProd.name !== currentBranch) return remoteProd.name;
    const other = branches.find((b) => b.name !== currentBranch);
    return other?.name ?? currentBranch ?? 'HEAD';
  }, [branches, currentBranch, initialBase]);

  const defaultTarget = useMemo(() => {
    if (initialTarget) return initialTarget;
    return currentBranch || branches[0]?.name || 'HEAD';
  }, [branches, currentBranch, initialTarget]);

  const [base, setBase] = useState(defaultBase);
  const [target, setTarget] = useState(defaultTarget);
  const [diff, setDiff] = useState<GitBranchDiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileOpen, setFileOpen] = useState<{
    path: string;
    status?: GitCommitFileStatus;
  } | null>(null);

  const options: SelectDropdownOption[] = useMemo(() => {
    return branches.map((b) => ({
      value: b.name,
      label: b.name,
      badge: b.isRemote ? 'remote' : undefined,
    }));
  }, [branches]);

  useEffect(() => {
    let cancelled = false;
    if (!base || !target) return;

    setLoading(true);
    setError(null);

    fetchGitBranchDiff(ctx, base, target)
      .then((res) => {
        if (cancelled) return;
        setDiff(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.();
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setDiff(null);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, target, cwd, conversationId, projectId, onUnauthorized]);

  const handleSwap = () => {
    setBase(target);
    setTarget(base);
  };

  return (
    <>
      <Modal
        title="Compare branches"
        onClose={() => {
          if (!fileOpen) onClose();
        }}
        className="git-compare-modal"
        overlayClassName="modal-overlay--stack-2"
      >
        <div className="git-compare-selectors">
          <div className="git-compare-branch-col">
            <span className="git-compare-label">Base</span>
            <SelectDropdown
              options={options}
              value={base}
              onChange={setBase}
              searchable
              placement="bottom"
            />
          </div>
          <button
            type="button"
            className="icon-btn git-compare-swap-btn"
            onClick={handleSwap}
            title="Swap base and target"
            aria-label="Swap base and target"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="17 1 21 5 17 9" />
              <path d="M3 5h18" />
              <polyline points="7 23 3 19 7 15" />
              <path d="M21 19H3" />
            </svg>
          </button>
          <div className="git-compare-branch-col">
            <span className="git-compare-label">Compare (target)</span>
            <SelectDropdown
              options={options}
              value={target}
              onChange={setTarget}
              searchable
              placement="bottom"
            />
          </div>
        </div>

        {error && <div className="git-wt-feedback git-wt-feedback--error">{error}</div>}

        {loading && <p className="git-wt-empty">Comparing branches…</p>}

        {!loading && diff && (
          <>
            <div className="git-compare-summary">
              <span>
                {diff.files.length} {diff.files.length === 1 ? 'file' : 'files'}
                {' · '}
                <span className="diff-stat-added">+{diff.stats.added}</span>{' '}
                <span className="diff-stat-removed">−{diff.stats.deleted}</span>
                {' · '}
                changes on <strong>{target}</strong> since it forked from <strong>{base}</strong>
              </span>
            </div>

            <div className="git-compare-files">
              {diff.files.length === 0 ? (
                <p className="git-wt-empty">No differences between branches.</p>
              ) : (
                <div className="git-history-files">
                  {diff.files.map((f) => {
                    const { dir, file } = splitPath(f.path);
                    return (
                      <button
                        type="button"
                        key={f.path}
                        className="git-history-file-row"
                        title={f.path}
                        onClick={() =>
                          setFileOpen({
                            path: f.path,
                            status: f.status,
                          })
                        }
                      >
                        {renderStatusBadge(f.status)}
                        <span className="git-wt-path">
                          {dir && <span className="git-wt-dir">{dir}</span>}
                          <span className="git-wt-file">{file}</span>
                        </span>
                        {f.binary ? (
                          <span className="git-wt-pill">binary</span>
                        ) : (
                          <span className="git-history-file-stats">
                            {f.addedLines != null && (
                              <span className="diff-stat-added">+{f.addedLines}</span>
                            )}
                            {f.deletedLines != null && (
                              <span className="diff-stat-removed">−{f.deletedLines}</span>
                            )}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </Modal>

      {fileOpen && diff && (
        <GitCommitFileModal
          cwd={cwd}
          conversationId={conversationId}
          projectId={projectId}
          sha={diff.targetSha}
          shortSha={diff.targetSha.slice(0, 7)}
          path={fileOpen.path}
          status={fileOpen.status}
          compareFromSha={diff.mergeBaseSha}
          onClose={() => setFileOpen(null)}
          onUnauthorized={onUnauthorized}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
        />
      )}
    </>
  );
}
