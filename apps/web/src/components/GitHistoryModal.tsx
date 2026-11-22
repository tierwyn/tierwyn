import { copyText } from '../clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitBranchRef, GitCommitDetail, GitCommitFileStatus, GitCommitSummary, VoiceTtsSettings } from '@tierwyn/shared';
import {
  fetchGitBranches, fetchGitHistory, fetchGitCommitDetail, UnauthorizedError,
} from '../api.js';
import { formatRelativeTime } from '../agentActivity.js';
import { Modal } from './Modal.js';
import { GitCommitFileModal } from './GitCommitFileModal.js';
import { renderStatusBadge, splitPath } from './gitStatusBadge.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

interface Props {
  cwd: string;
  conversationId?: string;
  projectId?: string;
  branch: string;
  onClose: () => void;
  onUnauthorized?: () => void;
  tts?: VoiceTtsSettings | null;
  ttsSummarizeAvailable?: boolean;
}

const PAGE = 50;

export function GitHistoryModal({
  cwd,
  conversationId,
  projectId,
  branch,
  onClose,
  onUnauthorized,
  tts,
  ttsSummarizeAvailable = false,
}: Props) {
  const ctx = { cwd, conversationId, projectId };
  const [ref, setRef] = useState<string>(branch || 'HEAD');
  const [branches, setBranches] = useState<GitBranchRef[]>([]);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [skip, setSkip] = useState(0);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileOpen, setFileOpen] = useState<{ path: string; sha: string; shortSha: string; status?: GitCommitFileStatus } | null>(null);
  const [showMessageModal, setShowMessageModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedMessage, setCopiedMessage] = useState(false);
  const detailReq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void fetchGitBranches(ctx)
      .then((res) => {
        if (cancelled) return;
        setBranches(res.branches);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.();
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, conversationId, projectId, onUnauthorized]);

  const branchOptions: SelectDropdownOption[] = useMemo(() => {
    const opts: SelectDropdownOption[] = branches.map((b) => ({
      value: b.name,
      label: b.name,
      badge: b.isRemote ? 'remote' : undefined,
    }));
    if (ref && !opts.some((o) => o.value === ref)) {
      opts.unshift({ value: ref, label: ref });
    }
    return opts;
  }, [branches, ref]);

  const loadHistory = useCallback(async (fromSkip: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchGitHistory({ ...ctx, ref, limit: PAGE, skip: fromSkip });
      setHasMore(res.hasMore);
      setSkip(fromSkip);
      setCommits((prev) => {
        if (!append) return res.commits;
        const seen = new Set(prev.map((c) => c.sha));
        return [...prev, ...res.commits.filter((c) => !seen.has(c.sha))];
      });
      if (!append) {
        const first = res.commits[0];
        setSelectedSha(first ? first.sha : null);
        if (!first) setDetail(null);
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // ctx is rebuilt each render; depend on its fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, conversationId, projectId, ref, onUnauthorized]);

  useEffect(() => {
    void loadHistory(0, false);
  }, [loadHistory]);

  useEffect(() => {
    if (!selectedSha) return;
    const id = ++detailReq.current;
    setDetailLoading(true);
    void fetchGitCommitDetail(ctx, selectedSha)
      .then((d) => {
        if (id !== detailReq.current) return;
        setDetail(d);
        setDetailLoading(false);
      })
      .catch((err: unknown) => {
        if (id !== detailReq.current) return;
        setDetailLoading(false);
        if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
        setError(err instanceof Error ? err.message : String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSha, cwd, conversationId, projectId, onUnauthorized]);

  useEffect(() => {
    setShowMessageModal(false);
    setCopiedMessage(false);
  }, [selectedSha]);

  const copySha = async (sha: string) => {
    try {
      await copyText(sha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  const copyCommitMessage = async (subject: string, body: string) => {
    const text = subject + (body ? `\n\n${body}` : '');
    try {
      await copyText(text);
      setCopiedMessage(true);
      window.setTimeout(() => setCopiedMessage(false), 1500);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  const showFullMessageBtn = detail != null
    && (detail.body.trim() !== '' || detail.subject.length > 72);

  const title = ref && ref !== (branch || 'HEAD') ? `Git history (${ref})` : 'Git history';

  return (
    <>
      <Modal
        title={title}
        onClose={() => { if (!fileOpen && !showMessageModal) onClose(); }}
        className="git-history-modal"
        overlayClassName="modal-overlay--stack-2"
        headerActions={(
          <button
            type="button"
            className="icon-btn"
            disabled={loading}
            onClick={() => void loadHistory(0, false)}
            title="Refresh commit history"
            aria-label="Refresh commit history"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={loading ? 'git-wt-spin' : undefined}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        )}
      >
        <div className="git-history-body">
          <div className="git-history-list">
            <div className="git-history-list-head">
              {branches.length > 0 ? (
                <SelectDropdown
                  options={branchOptions}
                  value={ref}
                  onChange={(newRef) => setRef(newRef)}
                  searchable
                  placement="bottom"
                />
              ) : (
                <span className="git-wt-pill git-wt-pill--branch">{ref || branch || 'HEAD'}</span>
              )}
              <span className="git-history-cwd" title={cwd}>{cwd}</span>
            </div>
            {error && <div className="git-wt-feedback git-wt-feedback--error">{error}</div>}
            {commits.length === 0 && !loading && (
              <p className="git-wt-empty">No commits yet.</p>
            )}
            {commits.map((c) => (
              <button
                type="button"
                key={c.sha}
                className={`git-history-row${c.sha === selectedSha ? ' git-history-row--active' : ''}`}
                onClick={() => setSelectedSha(c.sha)}
              >
                <span className="git-history-sha">{c.shortSha}</span>
                <span className="git-history-subject" title={c.subject}>{c.subject}</span>
                <span
                  className="git-history-time"
                  title={new Date(c.timestamp).toISOString()}
                >
                  {formatRelativeTime(c.timestamp)}
                </span>
                <span className="git-history-author">{c.authorName}</span>
                {c.refs.length > 0 && (
                  <span className="git-history-refs">
                    {c.refs.map((r) => (
                      <span key={r} className="git-wt-pill">{r}</span>
                    ))}
                  </span>
                )}
              </button>
            ))}
            {hasMore && (
              <button
                type="button"
                className="modal-btn git-history-load-more"
                disabled={loading}
                onClick={() => void loadHistory(skip + PAGE, true)}
              >
                {loading ? 'Loading…' : 'Load more commits…'}
              </button>
            )}
          </div>

          <div className="git-history-detail">
            {detailLoading && !detail && <p className="git-wt-empty">Loading commit…</p>}
            {detail && (
              <>
                <div className="git-history-detail-header">
                  <div className="git-history-detail-head">
                    <span className="git-history-sha git-history-sha--full">{detail.sha}</span>
                    <button type="button" className="modal-btn" onClick={() => void copySha(detail.sha)}>
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="git-history-detail-subject-row">
                    <h3 className="git-history-detail-subject">{detail.subject}</h3>
                    {showFullMessageBtn && (
                      <button
                        type="button"
                        className="git-history-view-msg-btn modal-btn"
                        onClick={() => setShowMessageModal(true)}
                      >
                        View full message
                      </button>
                    )}
                  </div>
                  {detail.body.trim() !== '' && (
                    <pre className="git-history-body-text">{detail.body}</pre>
                  )}
                  <p className="git-history-meta">
                    {detail.authorName} &lt;{detail.authorEmail}&gt;
                    {' · '}
                    {new Date(detail.timestamp).toISOString()}
                  </p>
                </div>
                {detail.isMerge ? (
                  <p className="git-wt-empty">Merge commit — per-file changes not shown</p>
                ) : (
                  <div className="git-wt-group git-history-files-group">
                    <div className="git-wt-group-head">
                      <div className="git-wt-group-title-wrap">
                        <span className="git-wt-group-title">Changed files</span>
                        <span className="git-wt-count-badge">{detail.stats.filesCount}</span>
                      </div>
                      <div className="git-history-file-stats git-history-stats">
                        <span className="diff-stat-added">+{detail.stats.added}</span>
                        <span className="diff-stat-removed">−{detail.stats.deleted}</span>
                      </div>
                    </div>
                    <div className="git-history-files">
                      {detail.files.map((f) => {
                        const { dir, file } = splitPath(f.path);
                        return (
                          <button
                            type="button"
                            key={f.path}
                            className="git-history-file-row"
                            title={f.path}
                            onClick={() => setFileOpen({
                              path: f.path,
                              sha: detail.sha,
                              shortSha: detail.shortSha,
                              status: f.status,
                            })}
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
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </Modal>

      {fileOpen && (
        <GitCommitFileModal
          cwd={cwd}
          conversationId={conversationId}
          projectId={projectId}
          sha={fileOpen.sha}
          shortSha={fileOpen.shortSha}
          path={fileOpen.path}
          status={fileOpen.status}
          onClose={() => setFileOpen(null)}
          onUnauthorized={onUnauthorized}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
        />
      )}

      {showMessageModal && detail && (
        <Modal
          title="Commit message"
          onClose={() => setShowMessageModal(false)}
          overlayClassName="modal-overlay--stack-3"
          className="git-commit-msg-modal"
        >
          <div className="git-commit-msg-modal-meta">
            <span className="git-history-sha">{detail.shortSha}</span>
            <span>{detail.authorName} &lt;{detail.authorEmail}&gt;</span>
            <span title={new Date(detail.timestamp).toISOString()}>
              {new Date(detail.timestamp).toISOString()}
            </span>
            <button
              type="button"
              className="modal-btn"
              onClick={() => void copyCommitMessage(detail.subject, detail.body)}
            >
              {copiedMessage ? 'Copied' : 'Copy message'}
            </button>
          </div>
          <h3 className="git-commit-msg-modal-subject">{detail.subject}</h3>
          {detail.body.trim() !== '' && (
            <pre className="git-commit-msg-modal-body">{detail.body}</pre>
          )}
          <div className="modal-footer">
            <button
              type="button"
              className="modal-btn"
              onClick={() => setShowMessageModal(false)}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
