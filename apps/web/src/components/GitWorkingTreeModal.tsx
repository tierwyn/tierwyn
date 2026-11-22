import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Conversation,
  GitBranchesResponse,
  GitWorkingTreeFile,
  GitWorkingTreeStatus,
  Project,
  VoiceTtsSettings,
} from '@tierwyn/shared';
import { isDefaultBranchName } from '@tierwyn/shared';
import {
  commitWorkingTree, fetchWorkingTree, stageWorkingTreePath, unstageWorkingTreePath, pushWorkingTree,
  deleteWorkingTreeUntracked, discardWorkingTreePath, generateWorkingTreeCommitMessage,
  cancelWorkingTreeCommitMessage, putWorkingTreeCommitMessage,
  fetchGitBranches, switchWorkingTreeBranch, createWorkingTreeBranch, fetchWorkingTreeRemotes, pullWorkingTree,
  stashWorkingTree, popWorkingTreeStash, createOperatorWorktree, UnauthorizedError,
} from '../api.js';
import {
  chooseDefaultTree, commitConfirmWarnings, commitDisabledHint, isCommitEnabled,
  canGenerateCommitMessage, generateDisabledHint,
  showBulkStage, showBulkUnstage, stageAllPaths, unstageAllPaths,
  isPushEnabled, pushDisabledHint, pushConfirmWarnings,
  type GitPanelOpen,
  shortenCwd, canDiscardUnstaged, shouldCloseWorkingTreeModal,
  switchDisabledHint, isPullEnabled, pullDisabledHint, canStash, canPopStash, switchConfirmWarning, defaultWorktreeFolder,
} from '../gitWorkingTree.js';
import type { GitLlmSubmitTarget } from '../gitLlmPrompts.js';
import { Modal } from './Modal.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { FileModal } from './FileModal.js';
import { GitHistoryModal } from './GitHistoryModal.js';
import { GitLlmOpsModal } from './GitLlmOpsModal.js';
import { GitNameModal } from './GitNameModal.js';
import { GitBranchCompareModal } from './GitBranchCompareModal.js';
import { renderStatusBadge, splitPath } from './gitStatusBadge.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';


interface Props {
  open: GitPanelOpen;
  selectedConversation: Conversation | null;
  selectedProject: Project | null;
  onClose: () => void;
  onUnauthorized?: () => void;
  tts?: VoiceTtsSettings | null;
  ttsSummarizeAvailable?: boolean;
  fileEditsEnabled?: boolean;
  /** Latest git_commit_draft_updated frame seen by App; applied when cwd matches. */
  commitDraftFrame?: { cwd: string; message: string; generating: boolean; error?: string } | null;
  onSubmitPrompt?: (text: string) => void;
  submitTarget?: GitLlmSubmitTarget;
}

function branchLine(status: GitWorkingTreeStatus | null): string {
  if (!status) return '';
  if (!status.isRepo) return 'Not a git repository';
  if (status.detached) return `HEAD ${status.headSha || 'detached'}`;
  return status.branch;
}

export function GitWorkingTreeModal({
  open,
  selectedConversation,
  selectedProject,
  onClose,
  onUnauthorized,
  tts,
  ttsSummarizeAvailable = false,
  fileEditsEnabled,
  commitDraftFrame,
  onSubmitPrompt,
  submitTarget,
}: Props) {
  const context = useMemo(() => chooseDefaultTree({
    via: open.via,
    menuConversation: open.via === 'conversation' ? open.conversation : undefined,
    menuProject: open.via === 'folder' ? open.project : undefined,
    selectedConversation,
    selectedProject,
  }), [open, selectedConversation, selectedProject]);

  const [selectedCwd, setSelectedCwd] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<GitWorkingTreeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pushConfirmOpen, setPushConfirmOpen] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [busyBulk, setBusyBulk] = useState<'stage' | 'unstage' | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  /** Optimistic generate lock scoped to the cwd it was issued for — never sticks across tree switch. */
  const [genBusyCwd, setGenBusyCwd] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GitWorkingTreeFile | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<GitWorkingTreeFile | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [llmOpsOpen, setLlmOpsOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchesResponse | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState<'fetch' | 'pull' | null>(null);
  const [stashBusy, setStashBusy] = useState<'push' | 'pop' | null>(null);
  const [nameModal, setNameModal] = useState<'branch' | 'worktree' | null>(null);
  const [nameModalError, setNameModalError] = useState<string | null>(null);
  const [switchWarningText, setSwitchWarningText] = useState<string | null>(null);
  const [pendingSwitchBranch, setPendingSwitchBranch] = useState<string | null>(null);
  const [popConfirmOpen, setPopConfirmOpen] = useState(false);
  const [stashConfirmOpen, setStashConfirmOpen] = useState(false);
  const [pullConfirmOpen, setPullConfirmOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [openFile, setOpenFile] = useState<{
    path: string;
    conversationId?: string;
    projectId?: string;
  } | null>(null);
  const putTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPut = useRef<string | null>(null);
  /** Frames are immutable; identity compare makes each frame apply at most once per mount. */
  const lastAppliedDraftFrame = useRef<typeof commitDraftFrame>(null);

  const refresh = useCallback(async () => {
    if (!context) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWorkingTree({
        ...context,
        cwd: selectedCwd,
      });
      setStatus(res);
      // Do not clobber in-flight typing — stage/unstage refresh inside the 500 ms PUT debounce.
      if (pendingPut.current == null) setMessage(res.commitMessage ?? '');
      // Server idle ⇒ drop optimistic lock (missed WS / stale TTL recovery).
      if (!res.commitMessageGenerating) {
        setGenBusyCwd((c) => (c === res.cwd ? null : c));
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'UnauthorizedError') {
        onUnauthorized?.();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [context, selectedCwd, onUnauthorized]);

  useEffect(() => {
    setSelectedCwd(undefined);
    setStatus(null);
    setMessage('');
    setError(null);
    setSuccessNotice(null);
    setConfirmOpen(false);
    setPushConfirmOpen(false);
    setHistoryOpen(false);
    setLlmOpsOpen(false);
    setBranches(null);
    setBranchBusy(false);
    setSyncBusy(null);
    setStashBusy(null);
    setNameModal(null);
    setNameModalError(null);
    setSwitchWarningText(null);
    setPendingSwitchBranch(null);
    setPopConfirmOpen(false);
    setStashConfirmOpen(false);
    setPullConfirmOpen(false);
    setCompareOpen(false);
    setGenBusyCwd(null);
    lastAppliedDraftFrame.current = null;
  }, [context]);

  useEffect(() => {
    // Tree switch must never leave the new tree locked behind the previous generate.
    setGenBusyCwd(null);
  }, [selectedCwd]);

  useEffect(() => {
    if (context) void refresh();
  }, [context, selectedCwd, refresh]);

  const flushCommitDraft = useCallback(() => {
    if (putTimer.current) { clearTimeout(putTimer.current); putTimer.current = null; }
    const text = pendingPut.current;
    pendingPut.current = null;
    if (text == null || !status?.cwd || !context) return;
    void putWorkingTreeCommitMessage({ ...context, cwd: status.cwd, message: text })
      .catch(() => { /* ponytail: draft persistence is best-effort; the box still holds the text */ });
  }, [context, status?.cwd]);

  const onMessageChange = (text: string) => {
    setMessage(text);
    pendingPut.current = text;
    if (putTimer.current) clearTimeout(putTimer.current);
    putTimer.current = setTimeout(flushCommitDraft, 500);
  };

  useEffect(() => flushCommitDraft, [flushCommitDraft]);   // flush on unmount / cwd change

  useEffect(() => {
    if (!commitDraftFrame) return;
    // Clear optimistic busy for this frame's cwd even when viewing another tree —
    // otherwise a mid-generate switch leaves the new tree locked forever.
    setGenBusyCwd((c) => (c === commitDraftFrame.cwd ? null : c));
    if (!status?.cwd || commitDraftFrame.cwd !== status.cwd) return;
    if (lastAppliedDraftFrame.current === commitDraftFrame) return;
    lastAppliedDraftFrame.current = commitDraftFrame;
    if (commitDraftFrame.error) setError(commitDraftFrame.error);
    else setMessage(commitDraftFrame.message);
    setStatus((prev) => (prev ? { ...prev, commitMessageGenerating: commitDraftFrame.generating } : prev));
  }, [commitDraftFrame, status?.cwd]);

  const mutationCtx = useMemo(() => ({
    ...context,
    cwd: status?.cwd ?? '',
  }), [context, status?.cwd]);

  const loadBranches = useCallback(async () => {
    if (!context || (!selectedCwd && !status?.cwd)) return;
    const cwd = selectedCwd ?? status?.cwd ?? '';
    if (!cwd) return;
    try {
      const res = await fetchGitBranches({
        ...context,
        cwd,
      });
      setBranches(res);
    } catch {
      // ignore
    }
  }, [context, selectedCwd, status?.cwd]);

  useEffect(() => {
    if (status?.isRepo) {
      void loadBranches();
    } else {
      setBranches(null);
    }
  }, [status?.cwd, status?.isRepo, loadBranches]);

  const doSwitchBranch = useCallback(async (targetBranch: string) => {
    if (!mutationCtx.cwd) return;
    setBranchBusy(true);
    setError(null);
    try {
      const res = await switchWorkingTreeBranch({
        ...mutationCtx,
        branch: targetBranch,
      });
      setSuccessNotice(`Switched to ${res.branch}`);
      await refresh();
      await loadBranches();
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBranchBusy(false);
    }
  }, [mutationCtx, refresh, loadBranches, onUnauthorized]);

  const handleBranchSelect = (targetBranch: string) => {
    if (targetBranch === '__create__') {
      setNameModalError(null);
      setNameModal('branch');
      return;
    }
    if (targetBranch === '__compare__') {
      setCompareOpen(true);
      return;
    }
    const currentBranch = status?.detached ? 'HEAD' : (status?.branch ?? '');
    if (targetBranch === currentBranch) return;

    const hint = status ? switchDisabledHint(status) : '';
    if (hint) {
      setError(hint);
      return;
    }
    const warning = switchConfirmWarning(currentBranch, targetBranch, status?.detached ?? false);
    if (warning) {
      setPendingSwitchBranch(targetBranch);
      setSwitchWarningText(warning);
      return;
    }
    void doSwitchBranch(targetBranch);
  };

  const handleFetch = async () => {
    if (!mutationCtx.cwd) return;
    setSyncBusy('fetch');
    setError(null);
    try {
      await fetchWorkingTreeRemotes(mutationCtx);
      setSuccessNotice('Fetched latest commits from remotes');
      await refresh();
      await loadBranches();
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncBusy(null);
    }
  };

  const handlePull = async () => {
    if (!mutationCtx.cwd) return;
    setSyncBusy('pull');
    setError(null);
    try {
      await pullWorkingTree(mutationCtx);
      setSuccessNotice('Fast-forward pull complete');
      await refresh();
      await loadBranches();
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncBusy(null);
    }
  };

  const handleStash = async () => {
    if (!mutationCtx.cwd) return;
    setStashBusy('push');
    setError(null);
    try {
      await stashWorkingTree(mutationCtx);
      setSuccessNotice('Working tree stashed');
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStashBusy(null);
    }
  };

  const handlePopStash = async () => {
    if (!mutationCtx.cwd) return;
    setStashBusy('pop');
    setError(null);
    try {
      await popWorkingTreeStash(mutationCtx);
      setSuccessNotice('Stash popped successfully');
      setPopConfirmOpen(false);
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
      setError(err instanceof Error ? err.message : String(err));
      setPopConfirmOpen(false);
    } finally {
      setStashBusy(null);
    }
  };

  const branchOptions = useMemo((): SelectDropdownOption<string>[] => {
    if (!status?.isRepo) return [];
    const opts: SelectDropdownOption<string>[] = [];
    if (branches?.branches) {
      for (const b of branches.branches) {
        opts.push({
          value: b.name,
          label: b.name,
          badge: b.isRemote ? 'remote' : undefined,
        });
      }
    }
    const curr = status.detached ? 'HEAD' : (status.branch || '');
    if (curr && !opts.some((o) => o.value === curr)) {
      opts.unshift({
        value: curr,
        label: status.detached ? `HEAD (${status.headSha || 'detached'})` : curr,
      });
    }
    opts.push(
      { value: '__create__', label: '+ Create branch from HEAD…' },
      { value: '__compare__', label: 'Compare branches…' },
    );
    return opts;
  }, [branches?.branches, status?.isRepo, status?.detached, status?.headSha, status?.branch]);

  const treeOptions = useMemo((): SelectDropdownOption<string>[] => {
    if (!status?.trees) return [];
    const opts: SelectDropdownOption<string>[] = status.trees.map((t) => ({
      value: t.cwd,
      label: `${t.label} (${t.branch || 'detached'}) — ${shortenCwd(t.cwd)}`,
      description: t.cwd,
    }));
    if (status.isRepo) {
      opts.push({
        value: '__new_worktree__',
        label: '+ New worktree…',
      });
    }
    return opts;
  }, [status?.trees, status?.isRepo]);

  const stagedStats = useMemo(() => {
    if (!status?.staged) return { added: 0, deleted: 0 };
    let added = 0;
    let deleted = 0;
    for (const f of status.staged) {
      if (f.binary) continue;
      added += f.addedLines ?? 0;
      deleted += f.deletedLines ?? 0;
    }
    return { added, deleted };
  }, [status?.staged]);

  const unstagedStats = useMemo(() => {
    if (!status?.unstaged) return { added: 0, deleted: 0 };
    let added = 0;
    let deleted = 0;
    for (const f of status.unstaged) {
      if (f.binary) continue;
      added += f.addedLines ?? 0;
      deleted += f.deletedLines ?? 0;
    }
    return { added, deleted };
  }, [status?.unstaged]);

  const handleStage = async (path: string) => {
    if (!mutationCtx.projectId || !mutationCtx.cwd) return;
    setBusyPath(path);
    setError(null);
    setSuccessNotice(null);
    try {
      await stageWorkingTreePath({
        cwd: mutationCtx.cwd,
        path,
        conversationId: mutationCtx.conversationId,
        projectId: mutationCtx.projectId,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPath(null);
    }
  };

  const handleUnstage = async (path: string) => {
    if (!mutationCtx.projectId || !mutationCtx.cwd) return;
    setBusyPath(path);
    setError(null);
    setSuccessNotice(null);
    try {
      await unstageWorkingTreePath({
        cwd: mutationCtx.cwd,
        path,
        conversationId: mutationCtx.conversationId,
        projectId: mutationCtx.projectId,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPath(null);
    }
  };

  const runBulk = async (kind: 'stage' | 'unstage', paths: string[]) => {
    if (!mutationCtx.projectId || !mutationCtx.cwd || paths.length === 0) return;
    setBusyBulk(kind);
    setError(null);
    setSuccessNotice(null);
    try {
      for (const path of paths) {
        const body = {
          cwd: mutationCtx.cwd,
          path,
          conversationId: mutationCtx.conversationId,
          projectId: mutationCtx.projectId,
        };
        if (kind === 'stage') await stageWorkingTreePath(body);
        else await unstageWorkingTreePath(body);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refresh();
    } finally {
      setBusyBulk(null);
    }
  };

  const handleCommit = async () => {
    if (!mutationCtx.projectId || !mutationCtx.cwd || !status) return;
    pendingPut.current = null;
    if (putTimer.current) { clearTimeout(putTimer.current); putTimer.current = null; }
    setCommitBusy(true);
    setError(null);
    setSuccessNotice(null);
    try {
      const res = await commitWorkingTree({
        cwd: mutationCtx.cwd,
        message,
        conversationId: mutationCtx.conversationId,
        projectId: mutationCtx.projectId,
      });
      setMessage('');
      setSuccessNotice(`Committed ${res.sha}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmOpen(false);
      setCommitBusy(false);
    }
  };

  const handleGenerateCommitMessage = async () => {
    if (!context || !status) return;
    setGenBusyCwd(status.cwd);
    setError(null);
    setSuccessNotice(null);
    try {
      await generateWorkingTreeCommitMessage({ ...context, cwd: status.cwd });
    } catch (err) {
      setGenBusyCwd(null);
      if (err instanceof Error && err.name === 'UnauthorizedError') { onUnauthorized?.(); return; }
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancelGenerateCommitMessage = async () => {
    if (!context || !status) return;
    setGenBusyCwd(null);
    setStatus((prev) => (prev ? { ...prev, commitMessageGenerating: false } : prev));
    try {
      await cancelWorkingTreeCommitMessage({ ...context, cwd: status.cwd });
    } catch (err) {
      if (err instanceof Error && err.name === 'UnauthorizedError') { onUnauthorized?.(); return; }
    }
  };

  const handlePush = async (remote = 'origin') => {
    if (!mutationCtx.projectId || !mutationCtx.cwd || !status) return;
    setPushBusy(true);
    setError(null);
    setSuccessNotice(null);
    try {
      const res = await pushWorkingTree({
        cwd: mutationCtx.cwd,
        remote,
        conversationId: mutationCtx.conversationId,
        projectId: mutationCtx.projectId,
      });
      setSuccessNotice(`Pushed to ${res.remote}/${res.branch} successfully`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushConfirmOpen(false);
      setPushBusy(false);
    }
  };

  const handleDelete = async (file: GitWorkingTreeFile) => {
    if (!mutationCtx.projectId || !mutationCtx.cwd) return;
    setDeleteBusy(true);
    setError(null);
    setSuccessNotice(null);
    try {
      await deleteWorkingTreeUntracked({
        cwd: mutationCtx.cwd,
        path: file.path,
        conversationId: mutationCtx.conversationId,
        projectId: mutationCtx.projectId,
      });
      setSuccessNotice(`Deleted ${file.path}`);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleDiscard = async (file: GitWorkingTreeFile) => {
    if (!mutationCtx.projectId || !mutationCtx.cwd) return;
    setDiscardBusy(true);
    setError(null);
    setSuccessNotice(null);
    try {
      await discardWorkingTreePath({
        cwd: mutationCtx.cwd,
        path: file.path,
        conversationId: mutationCtx.conversationId,
        projectId: mutationCtx.projectId,
      });
      setSuccessNotice(`Discarded changes to ${file.path}`);
      setDiscardTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscardBusy(false);
    }
  };

  const openFileFromRow = (file: GitWorkingTreeFile) => {
    const tree = status?.trees.find((t) => t.cwd === status?.cwd);
    setOpenFile({
      path: file.absPath,
      conversationId: tree?.conversationId ?? context?.conversationId,
      projectId: context?.projectId,
    });
  };

  const commitEnabled = status ? isCommitEnabled({
    isRepo: status.isRepo,
    stagedCount: status.staged.length,
    hasConflicts: status.hasConflicts,
    message,
  }) : false;

  const disabledHint = status ? commitDisabledHint({
    isRepo: status.isRepo,
    stagedCount: status.staged.length,
    hasConflicts: status.hasConflicts,
    message,
  }) : '';

  const genReady = status?.commitMessageReady === true;
  const generating = (genBusyCwd != null && genBusyCwd === status?.cwd)
    || status?.commitMessageGenerating === true;
  const genEnabled = status ? canGenerateCommitMessage({
    isRepo: status.isRepo,
    stagedCount: status.staged.length,
    hasConflicts: status.hasConflicts,
    ready: genReady,
  }) : false;
  const genHint = status ? generateDisabledHint({
    isRepo: status.isRepo,
    stagedCount: status.staged.length,
    hasConflicts: status.hasConflicts,
    ready: genReady,
  }) : '';
  const genDisabled = !genEnabled || generating || commitBusy || pushBusy;

  const renderFileRow = (file: GitWorkingTreeFile, action: 'stage' | 'unstage') => {
    const { dir, file: filename } = splitPath(file.path);
    const isBusy = busyPath === file.path || busyBulk !== null;
    const canDelete = action === 'stage' && file.status === 'new';
    const canDiscard = action === 'stage' && canDiscardUnstaged(file.status);

    return (
      <div key={`${action}-${file.path}`} className="git-wt-row">
        {renderStatusBadge(file.status)}
        <button
          type="button"
          className="git-wt-path"
          onClick={() => openFileFromRow(file)}
          title={`View diff: ${file.path}`}
        >
          {dir && <span className="git-wt-dir">{dir}</span>}
          <span className="git-wt-file">{filename}</span>
        </button>
        {file.binary ? (
          <span className="git-wt-pill">binary</span>
        ) : (
          (file.addedLines != null || file.deletedLines != null) && (
            <span className="git-history-file-stats">
              {file.addedLines != null && (
                <span className="diff-stat-added">+{file.addedLines}</span>
              )}
              {file.deletedLines != null && (
                <span className="diff-stat-removed">−{file.deletedLines}</span>
              )}
            </span>
          )
        )}
        <div className="git-wt-row-actions">
          {file.status === 'conflicted' ? null : (
            <button
              type="button"
              className="git-wt-action modal-btn"
              disabled={!status?.isRepo || isBusy || deleteBusy || discardBusy}
              onClick={() => void (action === 'stage' ? handleStage(file.path) : handleUnstage(file.path))}
            >
              {isBusy && busyPath === file.path ? '…' : (action === 'stage' ? 'Stage' : 'Unstage')}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="git-wt-action modal-btn danger"
              disabled={!status?.isRepo || isBusy || deleteBusy || discardBusy}
              onClick={() => setDeleteTarget(file)}
              title={`Delete untracked file ${file.path}`}
            >
              Delete
            </button>
          )}
          {canDiscard && (
            <button
              type="button"
              className="git-wt-action modal-btn danger"
              disabled={!status?.isRepo || isBusy || deleteBusy || discardBusy}
              onClick={() => setDiscardTarget(file)}
              title={`Discard unstaged changes to ${file.path} (restore to index)`}
            >
              Undo
            </button>
          )}
        </div>
      </div>
    );
  };

  if (!context) {
    return (
      <Modal title="Git working tree" onClose={onClose} className="git-working-tree-modal">
        <p className="git-wt-empty">Select a project first.</p>
      </Modal>
    );
  }

  const hasRemotes = Boolean(status?.remotes && status.remotes.length > 0);
  const pushEnabled = status ? isPushEnabled(status) : false;
  const canCloseHost = shouldCloseWorkingTreeModal({
    historyOpen,
    hasStatus: Boolean(status),
    openFile: Boolean(openFile),
    deleteTarget: Boolean(deleteTarget),
    discardTarget: Boolean(discardTarget),
    confirmOpen,
    pushConfirmOpen,
    llmOpsOpen,
  }) && !compareOpen && nameModal === null && !switchWarningText && !popConfirmOpen && !stashConfirmOpen && !pullConfirmOpen && !cancelConfirmOpen;

  return (
    <>
      <Modal
        title="Git working tree"
        onClose={() => { if (canCloseHost) onClose(); }}
        className="git-working-tree-modal"
        headerActions={(
          <>
            <button
              type="button"
              className="icon-btn"
              disabled={!status?.isRepo}
              onClick={() => setHistoryOpen(true)}
              title="Browse commit history"
              aria-label="Browse commit history"
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
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M12 7v5l4 2" />
              </svg>
            </button>
            {onSubmitPrompt && (
              <button
                type="button"
                className="icon-btn"
                disabled={!status?.isRepo}
                onClick={() => setLlmOpsOpen(true)}
                title="LLM git operations"
                aria-label="LLM git operations"
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
                >
                  <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                  <path d="M5 3v4" />
                  <path d="M19 17v4" />
                  <path d="M3 5h4" />
                  <path d="M17 19h4" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              disabled={loading}
              onClick={() => void refresh()}
              title="Refresh working tree status"
              aria-label="Refresh working tree status"
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
          </>
        )}
      >
        {/* Header & Meta Card */}
        <div className="git-wt-header-card">
          <div className="git-wt-top-row">
            <div className="git-wt-switcher-wrap">
              {status && (status.trees.length > 1 || status.isRepo) ? (
                <SelectDropdown
                  options={treeOptions}
                  value={status.cwd}
                  onChange={(cwd) => {
                    if (cwd === '__new_worktree__') {
                      setNameModalError(null);
                      setNameModal('worktree');
                      return;
                    }
                    setSelectedCwd(cwd);
                  }}
                  placement="bottom"
                />
              ) : (
                <div className="git-wt-tree-name">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>{status?.trees[0]?.label ?? 'Repository'}</span>
                  <span className="git-wt-tree-path" title={status?.cwd}>{status?.cwd ? shortenCwd(status.cwd) : ''}</span>
                </div>
              )}
            </div>
          </div>

          <div className="git-wt-badges-row">
            {/* Branch badge / selector */}
            {status?.isRepo ? (
              <span title={switchDisabledHint(status)} style={{ display: 'inline-flex' }}>
                <SelectDropdown
                  options={branchOptions}
                  value={status.detached ? 'HEAD' : (status.branch || '')}
                  onChange={handleBranchSelect}
                  searchable
                  placement="bottom"
                  disabled={branchBusy || loading}
                />
              </span>
            ) : (
              <span className="git-wt-pill git-wt-pill--branch" title={branchLine(status)}>
                <span>{branchLine(status)}</span>
              </span>
            )}

            {/* Upstream sync badge */}
            {status?.upstream ? (
              <>
                {status.ahead && status.ahead > 0 ? (
                  <span className="git-wt-pill git-wt-pill--ahead" title={`${status.ahead} commit(s) ahead of ${status.upstream}`}>
                    ↑ {status.ahead} ahead
                  </span>
                ) : null}
                {status.behind && status.behind > 0 ? (
                  <span className="git-wt-pill git-wt-pill--behind" title={`${status.behind} commit(s) behind ${status.upstream}`}>
                    ↓ {status.behind} behind
                  </span>
                ) : null}
                {status.ahead === 0 && status.behind === 0 ? (
                  <span className="git-wt-pill git-wt-pill--sync" title={`In sync with ${status.upstream}`}>
                    ✓ in sync with {status.upstream}
                  </span>
                ) : null}
              </>
            ) : (hasRemotes ? (
              <span className="git-wt-pill git-wt-pill--sync">
                {status?.remotes?.map((r) => r.name).join(', ')} available
              </span>
            ) : (
              <span className="git-wt-pill git-wt-pill--sync">local only</span>
            ))}

            {/* Fetch & Pull buttons */}
            {hasRemotes && (
              <div className="git-wt-sync-actions">
                <button
                  type="button"
                  className="modal-btn"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  disabled={syncBusy !== null || !status?.isRepo}
                  onClick={() => void handleFetch()}
                  title="Fetch all remotes"
                >
                  {syncBusy === 'fetch' ? 'Fetching…' : 'Fetch'}
                </button>
                <button
                  type="button"
                  className="modal-btn"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  disabled={syncBusy !== null || !status || !isPullEnabled(status)}
                  onClick={() => {
                    if (isDefaultBranchName(status?.branch ?? '', status?.detached ?? false)) {
                      setPullConfirmOpen(true);
                    } else {
                      void handlePull();
                    }
                  }}
                  title={status ? pullDisabledHint(status) : ''}
                >
                  {syncBusy === 'pull'
                    ? 'Pulling…'
                    : status?.behind && status.behind > 0
                      ? `Pull (↓${status.behind})`
                      : 'Pull'}
                </button>
              </div>
            )}

            {/* Production branch warning */}
            {isDefaultBranchName(status?.branch ?? '', status?.detached ?? false) && (
              <span className="git-wt-pill git-wt-pill--warning" title="HEAD is main/master. Prod may serve this checkout.">
                production branch
              </span>
            )}

            {/* Live agents pill */}
            {status && status.liveAgents.length > 0 && (
              <span className="git-wt-pill git-wt-pill--warning" title={status.liveAgents.map((a) => a.title).join(', ')}>
                ⚡ {status.liveAgents.length} agent(s) active
              </span>
            )}
          </div>
        </div>


        {/* Staged Group */}
        <div className="git-wt-group">
          <div className="git-wt-group-head">
            <div className="git-wt-group-title-wrap">
              <span className="git-wt-group-title">Staged</span>
              <span className="git-wt-count-badge">{status?.staged.length ?? 0}</span>
              {status && (stagedStats.added > 0 || stagedStats.deleted > 0) && (
                <div className="git-history-file-stats git-history-stats">
                  <span className="diff-stat-added">+{stagedStats.added}</span>
                  <span className="diff-stat-removed">−{stagedStats.deleted}</span>
                </div>
              )}
            </div>
            {status && showBulkUnstage(status.staged) && (
              <div className="git-wt-group-actions">
                <button
                  type="button"
                  className="git-wt-action modal-btn"
                  disabled={!status.isRepo || busyBulk !== null}
                  onClick={() => void runBulk('unstage', unstageAllPaths(status.staged))}
                >
                  {busyBulk === 'unstage' ? 'Unstaging…' : 'Unstage all'}
                </button>
              </div>
            )}
          </div>
          <div className="git-wt-file-list">
            {status?.staged.length ? status.staged.map((f) => renderFileRow(f, 'unstage')) : (
              <div className="git-wt-empty">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                  <rect x="2" y="2" width="20" height="20" rx="3" strokeDasharray="4 4" />
                </svg>
                <span>Nothing staged to commit</span>
              </div>
            )}
          </div>
        </div>

        {/* Unstaged Group */}
        <div className="git-wt-group">
          <div className="git-wt-group-head">
            <div className="git-wt-group-title-wrap">
              <span className="git-wt-group-title">Unstaged</span>
              <span className="git-wt-count-badge">{status?.unstaged.length ?? 0}</span>
              {status && (unstagedStats.added > 0 || unstagedStats.deleted > 0) && (
                <div className="git-history-file-stats git-history-stats">
                  <span className="diff-stat-added">+{unstagedStats.added}</span>
                  <span className="diff-stat-removed">−{unstagedStats.deleted}</span>
                </div>
              )}
            </div>
            <div className="git-wt-group-actions">
              {status && canStash(status) && (
                <button
                  type="button"
                  className="git-wt-action modal-btn"
                  disabled={!status.isRepo || stashBusy !== null || busyBulk !== null}
                  onClick={() => {
                    if (isDefaultBranchName(status.branch ?? '', status.detached ?? false)) {
                      setStashConfirmOpen(true);
                    } else {
                      void handleStash();
                    }
                  }}
                  title="Stash working tree changes (including untracked files)"
                >
                  {stashBusy === 'push' ? 'Stashing…' : 'Stash'}
                </button>
              )}
              {status && canPopStash(status) && (
                <button
                  type="button"
                  className="git-wt-action modal-btn"
                  disabled={!status.isRepo || stashBusy !== null || busyBulk !== null}
                  onClick={() => setPopConfirmOpen(true)}
                  title={status.stashTop ?? `Pop most recent stash (${status.stashCount ?? 0} available)`}
                >
                  {stashBusy === 'pop' ? 'Popping…' : `Pop stash (${status.stashCount ?? 0})`}
                </button>
              )}
              {status && showBulkStage(status.unstaged) && (
                <button
                  type="button"
                  className="git-wt-action modal-btn"
                  disabled={!status.isRepo || busyBulk !== null}
                  onClick={() => void runBulk('stage', stageAllPaths(status.unstaged))}
                >
                  {busyBulk === 'stage' ? 'Staging…' : 'Stage all'}
                </button>
              )}
            </div>
          </div>
          <div className="git-wt-file-list">
            {status?.unstaged.length ? status.unstaged.map((f) => renderFileRow(f, 'stage')) : (
              <div className="git-wt-empty">
                {status && status.staged.length === 0 ? (
                  <span className="git-wt-empty-clean" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="m9 12 2 2 4-4" />
                    </svg>
                    Working tree clean
                  </span>
                ) : (
                  <span>No unstaged changes</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Feedback / Error Notifications */}
        {successNotice && (
          <div className="git-wt-feedback git-wt-feedback--success">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>{successNotice}</span>
          </div>
        )}

        {error && (
          <div className="git-wt-feedback git-wt-feedback--error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Generate commit message — above the box; Commit stays the only primary. */}
        <div className="git-wt-commit-toolbar">
          {generating ? (
            <div className="git-wt-generating-indicator">
              <span className="git-wt-generating-sparkle" aria-hidden="true">✨</span>
              <span className="git-wt-generating-text">Generating commit message</span>
              <span className="git-wt-generating-dots">
                <span>.</span><span>.</span><span>.</span>
              </span>
            </div>
          ) : (
            <div />
          )}

          {generating ? (
            <button
              type="button"
              className="modal-btn danger git-wt-cancel-btn"
              onClick={() => setCancelConfirmOpen(true)}
              title="Cancel commit message generation"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="modal-btn"
              disabled={genDisabled}
              title={!genEnabled ? (genHint || 'Loading…') : undefined}
              onClick={() => void handleGenerateCommitMessage()}
            >
              <span aria-hidden="true">✨ </span>
              {message.trim().length > 0 ? 'Regenerate' : 'Generate message'}
            </button>
          )}
        </div>

        {/* Commit Message Box */}
        <div className={`git-wt-commit-box-wrap${generating ? ' git-wt-commit-box-wrap--generating' : ''}`}>
          <textarea
            className={`git-wt-commit-textarea ${generating ? 'git-wt-commit-textarea--generating' : ''}`}
            placeholder={generating ? "Analyzing staged diff and generating conventional commit message…" : "Commit message… (Ctrl+Enter to commit)"}
            value={message}
            onChange={(e) => onMessageChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (commitEnabled && !commitBusy && !generating) setConfirmOpen(true);
              }
            }}
            rows={4}
            disabled={!status?.isRepo || generating}
          />
        </div>

        {/* Footer */}
        <div className="modal-footer git-wt-footer-wrap">
          <div className="git-wt-footer-status">
            {status && status.staged.length > 0 ? (
              <span style={{ color: 'var(--text-2)' }}>{status.staged.length} file(s) staged</span>
            ) : (!commitEnabled && disabledHint ? (
              <span style={{ color: 'var(--text-3)' }} title={disabledHint}>{disabledHint}</span>
            ) : null)}
          </div>

          <div className="git-wt-footer-actions">
            {hasRemotes && (
              <button
                type="button"
                className="modal-btn accent git-wt-push-btn"
                disabled={!pushEnabled || pushBusy || commitBusy}
                title={status ? (pushDisabledHint(status) || `Push commits to origin/${status.branch}`) : undefined}
                onClick={() => {
                  if (!status) return;
                  if (isDefaultBranchName(status.branch, status.detached) || status.liveAgents.length > 0) {
                    setPushConfirmOpen(true);
                  } else {
                    void handlePush('origin');
                  }
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
                <span>
                  {pushBusy ? 'Pushing…' : (status?.ahead && status.ahead > 0 ? `Push to origin (${status.ahead})` : 'Push to origin')}
                </span>
              </button>
            )}

            <button
              type="button"
              className="modal-btn primary"
              disabled={!commitEnabled || commitBusy || generating}
              onClick={() => setConfirmOpen(true)}
            >
              {commitBusy ? 'Committing…' : 'Commit'}
            </button>
          </div>
        </div>
      </Modal>

      {confirmOpen && status && (
        <ConfirmDialog
          title={`Commit ${status.staged.length} file(s)?`}
          danger={false}
          confirmLabel="Commit"
          busy={commitBusy}
          overlayClassName="modal-overlay--stack-2"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void handleCommit()}
          body={(
            <>
              <p>{status.cwd}</p>
              <p>{status.detached ? `detached HEAD ${status.headSha}` : status.branch}</p>
              <p>{status.staged.length} file(s)</p>
              <pre className="git-wt-commit-preview">{message}</pre>
              {commitConfirmWarnings({
                liveAgents: status.liveAgents,
                branch: status.branch,
                detached: status.detached,
              }).map((w) => (
                <p key={w} className="git-wt-warning" style={{ color: 'var(--amber)' }}>{w}</p>
              ))}
            </>
          )}
        />
      )}

      {pushConfirmOpen && status && (
        <ConfirmDialog
          title={`Push ${status.ahead ? `${status.ahead} commit(s)` : ''} to origin?`}
          danger={isDefaultBranchName(status.branch, status.detached)}
          confirmLabel="Push"
          busy={pushBusy}
          overlayClassName="modal-overlay--stack-2"
          onCancel={() => setPushConfirmOpen(false)}
          onConfirm={() => void handlePush('origin')}
          body={(
            <>
              <p><strong>Branch:</strong> {status.branch}</p>
              <p><strong>Remote:</strong> origin</p>
              {status.ahead ? <p>{status.ahead} commit(s) ahead of origin/{status.branch}</p> : null}
              {pushConfirmWarnings({
                branch: status.branch,
                detached: status.detached,
                liveAgents: status.liveAgents,
                remote: 'origin',
              }).map((w) => (
                <p key={w} className="git-wt-warning" style={{ color: 'var(--amber)', marginTop: 6 }}>{w}</p>
              ))}
            </>
          )}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete untracked file?"
          danger={true}
          confirmLabel="Delete permanently"
          busy={deleteBusy}
          overlayClassName="modal-overlay--stack-2"
          onCancel={() => {
            if (!deleteBusy) setDeleteTarget(null);
          }}
          onConfirm={() => void handleDelete(deleteTarget)}
          body={(
            <>
              <p>Are you sure you want to permanently delete this untracked file from disk?</p>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all', color: 'var(--text-1)', background: 'var(--surface-2)', padding: '6px 8px', borderRadius: 4, marginTop: 8 }}>
                {deleteTarget.path}
              </p>
              <p style={{ color: 'var(--text-3)', fontSize: 11.5, marginTop: 8 }}>
                This action cannot be undone. Only untracked files can be deleted.
              </p>
            </>
          )}
        />
      )}

      {discardTarget && (
        <ConfirmDialog
          title="Discard unstaged changes?"
          danger={true}
          confirmLabel="Discard changes"
          busy={discardBusy}
          overlayClassName="modal-overlay--stack-2"
          onCancel={() => {
            if (!discardBusy) setDiscardTarget(null);
          }}
          onConfirm={() => void handleDiscard(discardTarget)}
          body={(
            <>
              <p>Your edits to this file since the last staged or committed state will be reverted. This cannot be undone.</p>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all', color: 'var(--text-1)', background: 'var(--surface-2)', padding: '6px 8px', borderRadius: 4, marginTop: 8 }}>
                {discardTarget.path}
              </p>
              {discardTarget.status === 'deleted' && (
                <p style={{ color: 'var(--text-3)', fontSize: 11.5, marginTop: 8 }}>
                  The deleted file will be restored.
                </p>
              )}
            </>
          )}
        />
      )}

      {openFile && (
        <FileModal
          path={openFile.path}
          conversationId={openFile.conversationId}
          projectId={openFile.projectId}
          onClose={() => setOpenFile(null)}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
          fileEditsEnabled={fileEditsEnabled}
          initialGitDiff
        />
      )}

      {historyOpen && status && (
        <GitHistoryModal
          cwd={status.cwd}
          conversationId={mutationCtx.conversationId}
          projectId={mutationCtx.projectId}
          branch={status.branch}
          onClose={() => setHistoryOpen(false)}
          onUnauthorized={onUnauthorized}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
        />
      )}

      {llmOpsOpen && status && onSubmitPrompt && (
        <GitLlmOpsModal
          cwd={status.cwd}
          onClose={() => setLlmOpsOpen(false)}
          onSubmit={(text) => { onSubmitPrompt(text); onClose(); }}
          target={submitTarget}
        />
      )}

      {switchWarningText && (
        <ConfirmDialog
          title="Confirm branch switch"
          body={<p>{switchWarningText}</p>}
          confirmLabel="Switch branch"
          danger
          busy={branchBusy}
          overlayClassName="modal-overlay--stack-2"
          onCancel={() => {
            setSwitchWarningText(null);
            setPendingSwitchBranch(null);
          }}
          onConfirm={() => {
            if (pendingSwitchBranch) {
              const b = pendingSwitchBranch;
              setSwitchWarningText(null);
              setPendingSwitchBranch(null);
              void doSwitchBranch(b);
            }
          }}
        />
      )}

      {popConfirmOpen && (
        <ConfirmDialog
          title="Pop stash"
          body={(
            <>
              <p>Apply most recent stash?</p>
              {status?.stashTop && (
                <p style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all', color: 'var(--text-1)', background: 'var(--surface-2)', padding: '6px 8px', borderRadius: 4, marginTop: 8 }}>
                  {status.stashTop}
                </p>
              )}
              <p style={{ color: 'var(--text-3)', fontSize: 11.5, marginTop: 8 }}>
                Note: stash is repository-wide. If conflicts occur, the stash entry is kept.
              </p>
            </>
          )}
          confirmLabel="Pop stash"
          busy={stashBusy === 'pop'}
          overlayClassName="modal-overlay--stack-2"
          onCancel={() => setPopConfirmOpen(false)}
          onConfirm={() => void handlePopStash()}
        />
      )}

      {stashConfirmOpen && (
        <ConfirmDialog
          title="Stash changes on production branch"
          body={(
            <p>
              You are about to stash changes on <strong>{status?.branch}</strong>. This checkout may be serving production.
            </p>
          )}
          confirmLabel="Stash changes"
          danger
          busy={stashBusy === 'push'}
          overlayClassName="modal-overlay--stack-2"
          onCancel={() => setStashConfirmOpen(false)}
          onConfirm={() => {
            setStashConfirmOpen(false);
            void handleStash();
          }}
        />
      )}

      {pullConfirmOpen && (
        <ConfirmDialog
          title="Pull changes on production branch"
          body={(
            <p>
              You are about to pull changes into <strong>{status?.branch}</strong>. Fast-forward pull will update the working directory and prod may be serving this checkout.
            </p>
          )}
          confirmLabel="Pull changes"
          danger
          busy={syncBusy === 'pull'}
          overlayClassName="modal-overlay--stack-2"
          onCancel={() => setPullConfirmOpen(false)}
          onConfirm={() => {
            setPullConfirmOpen(false);
            void handlePull();
          }}
        />
      )}

      {cancelConfirmOpen && (
        <ConfirmDialog
          title="Cancel commit message generation?"
          body={(
            <p>
              Are you sure you want to cancel generating the commit message?
            </p>
          )}
          confirmLabel="Cancel generation"
          danger={true}
          overlayClassName="modal-overlay--stack-2"
          onCancel={() => setCancelConfirmOpen(false)}
          onConfirm={() => {
            setCancelConfirmOpen(false);
            void handleCancelGenerateCommitMessage();
          }}
        />
      )}

      {nameModal === 'branch' && (
        <GitNameModal
          title="Create branch"
          fields={[
            {
              key: 'branch',
              label: 'Branch name',
              placeholder: 'feature/my-branch',
            },
          ]}
          submitLabel="Create branch"
          busy={branchBusy}
          error={nameModalError}
          onSubmit={async (vals) => {
            const b = (vals.branch as string)?.trim();
            if (!b) return;
            setBranchBusy(true);
            setNameModalError(null);
            try {
              const res = await createWorkingTreeBranch({
                ...mutationCtx,
                name: b,
              });
              setNameModal(null);
              setSuccessNotice(`Created and checked out ${res.branch}`);
              await refresh();
              await loadBranches();
            } catch (err) {
              if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
              setNameModalError(err instanceof Error ? err.message : String(err));
            } finally {
              setBranchBusy(false);
            }
          }}
          onClose={() => {
            setNameModal(null);
            setNameModalError(null);
          }}
        />
      )}

      {nameModal === 'worktree' && (
        <GitNameModal
          title="New worktree"
          fields={[
            {
              key: 'branch',
              label: 'Branch name',
              placeholder: 'feature/my-worktree',
            },
            {
              key: 'folder',
              label: 'Folder name (optional sibling directory)',
              placeholder: status ? defaultWorktreeFolder(status.cwd, 'feature') : undefined,
            },
          ]}
          checkbox={{
            key: 'newBranch',
            label: 'Create new branch',
            initial: true,
          }}
          submitLabel="Create worktree"
          busy={branchBusy}
          error={nameModalError}
          onSubmit={async (vals) => {
            const b = (vals.branch as string)?.trim();
            if (!b) return;
            const folder = (vals.folder as string)?.trim() || undefined;
            const newBranch = Boolean(vals.newBranch);
            setBranchBusy(true);
            setNameModalError(null);
            try {
              const res = await createOperatorWorktree({
                conversationId: context.conversationId,
                projectId: context.projectId,
                branch: b,
                newBranch,
                folder,
              });
              setNameModal(null);
              setSuccessNotice(`Created worktree at ${res.cwd}`);
              setSelectedCwd(res.cwd);
            } catch (err) {
              if (err instanceof UnauthorizedError) { onUnauthorized?.(); return; }
              setNameModalError(err instanceof Error ? err.message : String(err));
            } finally {
              setBranchBusy(false);
            }
          }}
          onClose={() => {
            setNameModal(null);
            setNameModalError(null);
          }}
        />
      )}

      {compareOpen && branches?.branches && (
        <GitBranchCompareModal
          cwd={status?.cwd ?? ''}
          conversationId={context.conversationId}
          projectId={context.projectId}
          branches={branches.branches}
          initialTarget={status?.detached ? 'HEAD' : (status?.branch || undefined)}
          onClose={() => setCompareOpen(false)}
          onUnauthorized={onUnauthorized}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
        />
      )}
    </>
  );
}


