export type GitPathStatus = 'modified' | 'new' | 'deleted' | 'renamed' | 'conflicted';

export interface GitWorkingTreeFile {
  path: string;
  origPath?: string;
  status: GitPathStatus;
  absPath: string;
  /** Absent for binary files (git prints '-' in numstat). */
  addedLines?: number;
  deletedLines?: number;
  binary?: boolean;
}

export interface GitWorkingTreeRef {
  cwd: string;
  label: string;
  branch: string;
  detached: boolean;
  headSha: string;
  source: 'project' | 'conversation' | 'worktree' | 'nested';
  conversationId?: string;
}

export interface GitLiveAgent {
  conversationId: string;
  title: string;
}

export interface GitRemoteRef {
  name: string;
  url?: string;
}

export interface GitWorkingTreeStatus {
  isRepo: boolean;
  cwd: string;
  branch: string;
  detached: boolean;
  headSha: string;
  staged: GitWorkingTreeFile[];
  unstaged: GitWorkingTreeFile[];
  trees: GitWorkingTreeRef[];
  liveAgents: GitLiveAgent[];
  hasConflicts: boolean;
  remotes?: GitRemoteRef[];
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  stashCount?: number;
  stashTop?: string;
  /** sidecarSiteReady(db, 'commit') — drives the Generate button. Absent ⇒ treat as false. */
  commitMessageReady?: boolean;
  /** Persisted commit message draft for this cwd. Absent ⇒ treat as ''. */
  commitMessage?: string;
  /** True while a background generation holds the lock. Absent ⇒ treat as false. */
  commitMessageGenerating?: boolean;
}

export interface GitWorkingTreePathRequest {
  cwd: string;
  path: string;
  conversationId?: string;
  projectId?: string;
}

export interface GitWorkingTreeCommitRequest {
  cwd: string;
  message: string;
  conversationId?: string;
  projectId?: string;
}

export interface GitWorkingTreePushRequest {
  cwd: string;
  remote?: string;
  conversationId?: string;
  projectId?: string;
}

export interface GitWorkingTreePushResponse {
  ok: true;
  remote: string;
  branch: string;
  output?: string;
}

export interface GitWorkingTreeCommitMessageRequest {
  cwd: string;
  conversationId?: string;
  projectId?: string;
}

export interface GitWorkingTreeCommitMessageResponse {
  message: string;
  /** True when the diff exceeded budget and only a --stat summary was sent to the model. */
  summarised: boolean;
  fileCount: number;
}

export function isDefaultBranchName(branch: string, detached: boolean): boolean {
  if (detached) return false;
  return branch === 'main' || branch === 'master';
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  /** Unix epoch milliseconds (server multiplies git's %at seconds by 1000). */
  timestamp: number;
  subject: string;
  /** Decorations from %D, already split and trimmed. Empty when undecorated. */
  refs: string[];
}

export type GitCommitFileStatus = 'modified' | 'new' | 'deleted' | 'renamed';

export interface GitCommitFileChange {
  path: string;
  origPath?: string;
  status: GitCommitFileStatus;
  /** Absent for binary files (git prints '-' in numstat). */
  addedLines?: number;
  deletedLines?: number;
  binary: boolean;
}

export interface GitCommitDetail extends GitCommitSummary {
  body: string;
  parentShas: string[];
  files: GitCommitFileChange[];
  stats: { added: number; deleted: number; filesCount: number };
  /** parentShas.length > 1 — the files list is empty by design. */
  isMerge: boolean;
}

export interface GitHistoryResponse {
  cwd: string;
  branch: string;
  detached: boolean;
  commits: GitCommitSummary[];
  hasMore: boolean;
  ref?: string;
}

export interface GitCommitDiffResponse {
  sha: string;
  path: string;
  diff: string;
  /** True when the diff was clipped at the size cap. */
  truncated: boolean;
}

export interface GitCommitFileResponse {
  sha: string;
  path: string;
  content: string;
  binary: boolean;
  truncated: boolean;
}

export interface GitBranchRef {
  name: string;          // short name: "feature/x" or "origin/feature/x"
  isRemote: boolean;
  isCurrent: boolean;
  shortSha: string;
  upstream?: string;     // local branches only, "" → omitted
}

export interface GitBranchesResponse {
  current: string;       // '' when detached
  detached: boolean;
  branches: GitBranchRef[];   // locals first (current first), then remotes; origin/HEAD excluded
}

export interface GitSwitchBranchRequest  { cwd: string; branch: string; conversationId?: string; projectId?: string }
export interface GitCreateBranchRequest  { cwd: string; name: string; baseRef?: string; conversationId?: string; projectId?: string }
export interface GitStashRequest         { cwd: string; message?: string; conversationId?: string; projectId?: string }
export interface GitWorkingTreeCtxRequest { cwd: string; conversationId?: string; projectId?: string }  // fetch, pull, stash-pop

export interface GitBranchOpResponse { ok: true; branch: string }
export interface GitSyncResponse {
  ok: true;
  output: string;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitCreateWorktreeRequest {
  conversationId?: string;
  projectId?: string;
  branch: string;
  newBranch?: boolean;
  /** Single path segment. Default `${basename(projectRoot)}-${branch with / → -}`. */
  folder?: string;
}
export interface GitCreateWorktreeResponse { ok: true; cwd: string; branch: string }

export interface GitBranchDiffResponse {
  base: string;
  target: string;
  /** Full shas — the per-file diff endpoint takes these so list + diffs are one snapshot. */
  mergeBaseSha: string;
  targetSha: string;
  files: GitCommitFileChange[];
  stats: { added: number; deleted: number; filesCount: number };
}

