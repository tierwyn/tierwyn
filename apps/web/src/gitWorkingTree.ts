import type { Conversation, Project, GitLiveAgent } from '@tierwyn/shared';
import { isDefaultBranchName } from '@tierwyn/shared';

export type GitPanelOpen =
  | { via: 'palette' }
  | { via: 'topbar' }
  | { via: 'conversation'; conversation: Conversation }
  | { via: 'folder'; project: Project };

export function chooseDefaultTree(args: {
  via: GitPanelOpen['via'];
  menuConversation?: Conversation;
  menuProject?: Project;
  selectedConversation: Conversation | null;
  selectedProject: Project | null;
}): { conversationId?: string; projectId: string } | null {
  switch (args.via) {
    case 'conversation':
      if (args.menuConversation) {
        return { conversationId: args.menuConversation.id, projectId: args.menuConversation.projectId };
      }
      return null;
    case 'folder':
      if (args.menuProject) {
        return { projectId: args.menuProject.id };
      }
      return null;
    case 'palette':
    case 'topbar':
      if (args.selectedConversation) {
        return {
          conversationId: args.selectedConversation.id,
          projectId: args.selectedConversation.projectId,
        };
      }
      if (args.selectedProject) {
        return { projectId: args.selectedProject.id };
      }
      return null;
  }
}

export function isCommitEnabled(s: {
  isRepo: boolean;
  stagedCount: number;
  hasConflicts: boolean;
  message: string;
}): boolean {
  return s.isRepo
    && s.stagedCount > 0
    && !s.hasConflicts
    && s.message.trim().length > 0;
}

export function commitConfirmWarnings(args: {
  liveAgents: GitLiveAgent[];
  branch: string;
  detached: boolean;
}): string[] {
  const warnings: string[] = [];
  for (const agent of args.liveAgents) {
    warnings.push(`Agent running in "${agent.title}" — this tree may still be changing.`);
  }
  if (isDefaultBranchName(args.branch, args.detached)) {
    warnings.push(`HEAD is ${args.branch}. Prod may be serving this checkout.`);
  }
  return warnings;
}

export function commitDisabledHint(s: {
  isRepo: boolean;
  stagedCount: number;
  hasConflicts: boolean;
  message: string;
}): string {
  if (!s.isRepo) return 'Not a git repository';
  if (s.hasConflicts) return 'Resolve conflicts before committing';
  if (s.stagedCount === 0) return '';
  if (s.message.trim().length === 0) return 'Enter a commit message';
  return '';
}

export function canGenerateCommitMessage(s: {
  isRepo: boolean;
  stagedCount: number;
  hasConflicts: boolean;
  ready: boolean;
}): boolean {
  return s.isRepo
    && s.stagedCount > 0
    && !s.hasConflicts
    && s.ready;
}

export function generateDisabledHint(s: {
  isRepo: boolean;
  stagedCount: number;
  hasConflicts: boolean;
  ready: boolean;
}): string {
  if (!s.isRepo) return 'Not a git repository';
  if (s.hasConflicts) return 'Resolve conflicts before committing';
  if (s.stagedCount === 0) return '';
  if (!s.ready) return 'Commit message LLM not configured — Settings → Sidecar LLMs';
  return '';
}

type BulkFile = { path: string; status: string };

function eligibleBulkPaths(files: BulkFile[]): string[] {
  return files.filter((f) => f.status !== 'conflicted').map((f) => f.path);
}

export function stageAllPaths(files: BulkFile[]): string[] {
  return eligibleBulkPaths(files);
}

export function unstageAllPaths(files: BulkFile[]): string[] {
  return eligibleBulkPaths(files);
}

export function showBulkStage(files: BulkFile[]): boolean {
  return stageAllPaths(files).length > 1;
}

export function showBulkUnstage(files: BulkFile[]): boolean {
  return unstageAllPaths(files).length > 1;
}

export function hasOriginRemote(remotes?: { name: string }[]): boolean {
  if (!remotes || remotes.length === 0) return false;
  return remotes.some((r) => r.name === 'origin');
}

export function isPushEnabled(s: {
  isRepo: boolean;
  detached: boolean;
  remotes?: { name: string }[];
  upstream?: string | null;
  ahead?: number;
  behind?: number;
}): boolean {
  if (!s.isRepo || s.detached) return false;
  if (!s.remotes || s.remotes.length === 0) return false;
  if (typeof s.behind === 'number' && s.behind > 0) return false;
  if (s.upstream && (!s.ahead || s.ahead <= 0)) return false;
  return true;
}

export function pushDisabledHint(s: {
  isRepo: boolean;
  detached: boolean;
  remotes?: { name: string }[];
  upstream?: string | null;
  ahead?: number;
  behind?: number;
}): string {
  if (!s.isRepo) return 'Not a git repository';
  if (s.detached) return 'Cannot push detached HEAD';
  if (!s.remotes || s.remotes.length === 0) return 'No remote configured';
  if (typeof s.behind === 'number' && s.behind > 0) return `Branch is ${s.behind} commit(s) behind remote`;
  if (s.upstream && (!s.ahead || s.ahead <= 0)) return `Up to date with ${s.upstream}`;
  return '';
}

export function pushConfirmWarnings(args: {
  branch: string;
  detached: boolean;
  liveAgents: GitLiveAgent[];
  remote: string;
}): string[] {
  const warnings: string[] = [];
  if (isDefaultBranchName(args.branch, args.detached)) {
    warnings.push(`You are pushing to "${args.branch}". Production may be running from this branch.`);
  }
  for (const agent of args.liveAgents) {
    warnings.push(`Agent is currently running in "${agent.title}".`);
  }
  return warnings;
}

export function formatAheadBehind(ahead?: number, behind?: number): string | null {
  const parts: string[] = [];
  if (typeof ahead === 'number' && ahead > 0) {
    parts.push(`↑${ahead} ahead`);
  }
  if (typeof behind === 'number' && behind > 0) {
    parts.push(`↓${behind} behind`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

export function shortenCwd(cwd: string): string {
  if (!cwd) return '';
  return cwd.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~');
}

/** Discard is offered only for tracked working-tree changes. Untracked rows keep
 *  Delete; conflicted rows keep neither. */
export function canDiscardUnstaged(status: string): boolean {
  return status === 'modified' || status === 'deleted';
}

/** Determines if the host Git working tree modal should close on Escape / onClose,
 *  preventing closing when any child dialog or modal is currently active. */
export function shouldCloseWorkingTreeModal(state: {
  historyOpen: boolean;
  hasStatus: boolean;
  openFile: boolean;
  deleteTarget: boolean;
  discardTarget: boolean;
  confirmOpen: boolean;
  pushConfirmOpen: boolean;
  llmOpsOpen: boolean;
}): boolean {
  const childOpen = (state.historyOpen && state.hasStatus)
    || state.openFile
    || state.deleteTarget
    || state.discardTarget
    || state.confirmOpen
    || state.pushConfirmOpen
    || (state.llmOpsOpen && state.hasStatus);
  return !childOpen;
}

export function switchDisabledHint(s: {
  isRepo: boolean;
  staged?: unknown[];
  unstaged?: unknown[];
  liveAgents?: GitLiveAgent[];
  hasConflicts?: boolean;
}): string {
  if (!s.isRepo) return 'Not a git repository';
  if (s.liveAgents && s.liveAgents.length > 0) return 'Cannot switch branch while an agent is active';
  if (s.hasConflicts) return 'Resolve conflicts before switching branches';
  if ((s.staged && s.staged.length > 0) || (s.unstaged && s.unstaged.length > 0)) {
    return 'Cannot switch branch: working tree has uncommitted changes. Stash or commit first.';
  }
  return '';
}

export function isPullEnabled(s: {
  isRepo: boolean;
  detached: boolean;
  upstream?: string | null;
  behind?: number;
  liveAgents?: GitLiveAgent[];
}): boolean {
  return Boolean(
    s.isRepo &&
    !s.detached &&
    s.upstream &&
    typeof s.behind === 'number' &&
    s.behind > 0 &&
    (!s.liveAgents || s.liveAgents.length === 0),
  );
}

export function pullDisabledHint(s: {
  isRepo: boolean;
  detached: boolean;
  upstream?: string | null;
  behind?: number;
  liveAgents?: GitLiveAgent[];
}): string {
  if (!s.isRepo) return 'Not a git repository';
  if (s.detached) return 'Cannot pull on detached HEAD';
  if (!s.upstream) return 'No upstream branch configured';
  if (s.liveAgents && s.liveAgents.length > 0) return 'Cannot pull while an agent is active';
  if (!s.behind || s.behind <= 0) return 'Already up to date';
  return '';
}

export function canStash(s: {
  isRepo: boolean;
  staged?: unknown[];
  unstaged?: unknown[];
  liveAgents?: GitLiveAgent[];
  hasConflicts?: boolean;
}): boolean {
  const hasChanges = Boolean((s.staged && s.staged.length > 0) || (s.unstaged && s.unstaged.length > 0));
  return Boolean(
    s.isRepo &&
    hasChanges &&
    (!s.liveAgents || s.liveAgents.length === 0) &&
    !s.hasConflicts,
  );
}

export function canPopStash(s: {
  isRepo: boolean;
  stashCount?: number;
  liveAgents?: GitLiveAgent[];
}): boolean {
  return Boolean(
    s.isRepo &&
    typeof s.stashCount === 'number' &&
    s.stashCount > 0 &&
    (!s.liveAgents || s.liveAgents.length === 0),
  );
}

export function switchConfirmWarning(from: string, to: string, detached: boolean): string | null {
  if (isDefaultBranchName(from, detached)) {
    return `Switching away from "${from}". Production may be running from this branch.`;
  }
  if (isDefaultBranchName(to, false)) {
    return `Switching to "${to}". Production may be running from this branch.`;
  }
  return null;
}

export function defaultWorktreeFolder(rootCwd: string, branch: string): string {
  const base = rootCwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'repo';
  const cleanBranch = branch.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '');
  return `${base}-${cleanBranch || 'worktree'}`;
}


/** Where leaving FileModal's git-diff view goes. 'close' = diff opened from the
 *  working tree modal: closing returns straight to it, skipping the file view. */
export type GitDiffReturnTo = 'view' | 'edit' | 'close';

export function gitDiffReturnTo(opts: {
  closeOnExit: boolean;
  mode: string;
  prevReturnTo?: GitDiffReturnTo;
}): GitDiffReturnTo {
  if (opts.closeOnExit) return 'close';
  if (opts.mode === 'edit' || opts.prevReturnTo === 'edit') return 'edit';
  return 'view';
}
