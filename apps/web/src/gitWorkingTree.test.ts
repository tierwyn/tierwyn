import { describe, it, expect } from 'vitest';
import type { Conversation, Project } from '@tierwyn/shared';
import {
  gitDiffReturnTo,
  chooseDefaultTree, isCommitEnabled, commitConfirmWarnings, commitDisabledHint,
  canGenerateCommitMessage, generateDisabledHint,
  showBulkStage, showBulkUnstage, stageAllPaths, unstageAllPaths,
  hasOriginRemote, isPushEnabled, pushDisabledHint, pushConfirmWarnings, formatAheadBehind,
  shortenCwd, canDiscardUnstaged, shouldCloseWorkingTreeModal,
  switchDisabledHint, isPullEnabled, pullDisabledHint, canStash, canPopStash,
  switchConfirmWarning, defaultWorktreeFolder,
} from './gitWorkingTree.js';

const convA = { id: 'a', projectId: 'p1', title: 'A', workdirPath: '/wt/a' } as Conversation;
const convB = { id: 'b', projectId: 'p1', title: 'B' } as Conversation;
const project = { id: 'p1', name: 'Proj', rootPath: '/root' } as Project;

describe('chooseDefaultTree', () => {
  it('uses menu conversation when opened from overflow', () => {
    expect(chooseDefaultTree({
      via: 'conversation',
      menuConversation: convA,
      selectedConversation: convB,
      selectedProject: project,
    })).toEqual({ conversationId: 'a', projectId: 'p1' });
  });

  it('uses menu project when opened from folder overflow', () => {
    expect(chooseDefaultTree({
      via: 'folder',
      menuProject: project,
      selectedConversation: convB,
      selectedProject: null,
    })).toEqual({ projectId: 'p1' });
  });

  it('folder with no menu project returns null', () => {
    expect(chooseDefaultTree({
      via: 'folder',
      selectedConversation: convA,
      selectedProject: project,
    })).toBeNull();
  });

  it('palette with selected conversation sends conversation id', () => {
    expect(chooseDefaultTree({
      via: 'palette',
      selectedConversation: convA,
      selectedProject: project,
    })).toEqual({ conversationId: 'a', projectId: 'p1' });
  });

  it('palette with conversation without workdir still sends conversation id', () => {
    expect(chooseDefaultTree({
      via: 'palette',
      selectedConversation: convB,
      selectedProject: project,
    })).toEqual({ conversationId: 'b', projectId: 'p1' });
  });

  it('palette with project only sends projectId', () => {
    expect(chooseDefaultTree({
      via: 'palette',
      selectedConversation: null,
      selectedProject: project,
    })).toEqual({ projectId: 'p1' });
  });

  it('palette with nothing selected returns null', () => {
    expect(chooseDefaultTree({
      via: 'palette',
      selectedConversation: null,
      selectedProject: null,
    })).toBeNull();
  });

  it('topbar with selected conversation sends conversation id', () => {
    expect(chooseDefaultTree({
      via: 'topbar',
      selectedConversation: convA,
      selectedProject: project,
    })).toEqual({ conversationId: 'a', projectId: 'p1' });
  });

  it('topbar with conversation without workdir still sends conversation id', () => {
    expect(chooseDefaultTree({
      via: 'topbar',
      selectedConversation: convB,
      selectedProject: project,
    })).toEqual({ conversationId: 'b', projectId: 'p1' });
  });

  it('topbar with project only sends projectId', () => {
    expect(chooseDefaultTree({
      via: 'topbar',
      selectedConversation: null,
      selectedProject: project,
    })).toEqual({ projectId: 'p1' });
  });

  it('topbar with nothing selected returns null', () => {
    expect(chooseDefaultTree({
      via: 'topbar',
      selectedConversation: null,
      selectedProject: null,
    })).toBeNull();
  });
});

describe('isCommitEnabled', () => {
  const base = { isRepo: true, stagedCount: 1, hasConflicts: false, message: 'msg' };

  it('enabled on happy path', () => {
    expect(isCommitEnabled(base)).toBe(true);
  });

  it('disabled when not a repo', () => {
    expect(isCommitEnabled({ ...base, isRepo: false })).toBe(false);
  });

  it('disabled when nothing staged', () => {
    expect(isCommitEnabled({ ...base, stagedCount: 0 })).toBe(false);
  });

  it('disabled when conflicts', () => {
    expect(isCommitEnabled({ ...base, hasConflicts: true })).toBe(false);
  });

  it('disabled when message empty', () => {
    expect(isCommitEnabled({ ...base, message: '  ' })).toBe(false);
  });
});

describe('commitDisabledHint', () => {
  it('returns first matching disable reason', () => {
    expect(commitDisabledHint({ isRepo: false, stagedCount: 0, hasConflicts: true, message: '' }))
      .toBe('Not a git repository');
    expect(commitDisabledHint({ isRepo: true, stagedCount: 0, hasConflicts: true, message: 'x' }))
      .toBe('Resolve conflicts before committing');
    expect(commitDisabledHint({ isRepo: true, stagedCount: 0, hasConflicts: false, message: 'x' }))
      .toBe('');
    expect(commitDisabledHint({ isRepo: true, stagedCount: 1, hasConflicts: false, message: ' ' }))
      .toBe('Enter a commit message');
  });
});

describe('canGenerateCommitMessage', () => {
  const base = { isRepo: true, stagedCount: 1, hasConflicts: false, ready: true };

  it('true only when repo + staged + no conflicts + ready', () => {
    expect(canGenerateCommitMessage(base)).toBe(true);
  });

  it('false when ready is false (covers commitMessageReady absent)', () => {
    expect(canGenerateCommitMessage({ ...base, ready: false })).toBe(false);
  });

  it('false when not a repo, nothing staged, or conflicts', () => {
    expect(canGenerateCommitMessage({ ...base, isRepo: false })).toBe(false);
    expect(canGenerateCommitMessage({ ...base, stagedCount: 0 })).toBe(false);
    expect(canGenerateCommitMessage({ ...base, hasConflicts: true })).toBe(false);
  });
});

describe('generateDisabledHint', () => {
  it('returns the expected string per condition and empty when enabled', () => {
    expect(generateDisabledHint({ isRepo: false, stagedCount: 0, hasConflicts: true, ready: false }))
      .toBe('Not a git repository');
    expect(generateDisabledHint({ isRepo: true, stagedCount: 0, hasConflicts: true, ready: false }))
      .toBe('Resolve conflicts before committing');
    expect(generateDisabledHint({ isRepo: true, stagedCount: 0, hasConflicts: false, ready: false }))
      .toBe('');
    expect(generateDisabledHint({ isRepo: true, stagedCount: 1, hasConflicts: false, ready: false }))
      .toBe('Commit message LLM not configured — Settings → Sidecar LLMs');
    expect(generateDisabledHint({ isRepo: true, stagedCount: 1, hasConflicts: false, ready: true }))
      .toBe('');
  });
});

describe('stage/unstage all', () => {
  const a = { path: 'a.ts', status: 'modified' as const };
  const b = { path: 'b.ts', status: 'new' as const };
  const conflict = { path: 'c.ts', status: 'conflicted' as const };

  it('hides bulk actions for 0 or 1 eligible file', () => {
    expect(showBulkStage([])).toBe(false);
    expect(showBulkStage([a])).toBe(false);
    expect(showBulkUnstage([a])).toBe(false);
    expect(showBulkStage([a, conflict])).toBe(false);
  });

  it('shows bulk actions when two or more eligible files exist', () => {
    expect(showBulkStage([a, b])).toBe(true);
    expect(showBulkUnstage([a, b, conflict])).toBe(true);
  });

  it('stage-all paths skip conflicted files', () => {
    expect(stageAllPaths([a, conflict, b])).toEqual(['a.ts', 'b.ts']);
  });

  it('unstage-all paths skip conflicted files', () => {
    expect(unstageAllPaths([a, conflict, b])).toEqual(['a.ts', 'b.ts']);
  });
});

describe('commitConfirmWarnings', () => {
  it('includes live agent titles', () => {
    const w = commitConfirmWarnings({
      liveAgents: [{ conversationId: 'c1', title: 'Planner' }],
      branch: 'feature/x',
      detached: false,
    });
    expect(w[0]).toContain('Planner');
  });

  it('includes main/master warning', () => {
    const w = commitConfirmWarnings({ liveAgents: [], branch: 'main', detached: false });
    expect(w.some((line) => line.includes('main'))).toBe(true);
  });

  it('returns empty on feature branch with no agents', () => {
    expect(commitConfirmWarnings({ liveAgents: [], branch: 'feat/x', detached: false })).toEqual([]);
  });
});

describe('push helpers', () => {
  it('hasOriginRemote detects origin', () => {
    expect(hasOriginRemote(undefined)).toBe(false);
    expect(hasOriginRemote([])).toBe(false);
    expect(hasOriginRemote([{ name: 'upstream' }])).toBe(false);
    expect(hasOriginRemote([{ name: 'origin' }])).toBe(true);
    expect(hasOriginRemote([{ name: 'other' }, { name: 'origin' }])).toBe(true);
  });

  it('isPushEnabled checks repo, detached, remotes, behind, and ahead when upstream exists', () => {
    expect(isPushEnabled({ isRepo: true, detached: false, remotes: [{ name: 'origin' }] })).toBe(true);
    expect(isPushEnabled({ isRepo: false, detached: false, remotes: [{ name: 'origin' }] })).toBe(false);
    expect(isPushEnabled({ isRepo: true, detached: true, remotes: [{ name: 'origin' }] })).toBe(false);
    expect(isPushEnabled({ isRepo: true, detached: false, remotes: [] })).toBe(false);
    expect(isPushEnabled({ isRepo: true, detached: false, remotes: [{ name: 'origin' }], behind: 2 })).toBe(false);
    expect(isPushEnabled({ isRepo: true, detached: false, remotes: [{ name: 'origin' }], behind: 0 })).toBe(true);
    expect(isPushEnabled({ isRepo: true, detached: false, remotes: [{ name: 'origin' }], upstream: 'origin/main', ahead: 0 })).toBe(false);
    expect(isPushEnabled({ isRepo: true, detached: false, remotes: [{ name: 'origin' }], upstream: 'origin/main', ahead: 2 })).toBe(true);
    expect(isPushEnabled({ isRepo: true, detached: false, remotes: [{ name: 'origin' }], upstream: null, ahead: 0 })).toBe(true);
  });

  it('pushDisabledHint reports correct reason', () => {
    expect(pushDisabledHint({ isRepo: false, detached: false })).toBe('Not a git repository');
    expect(pushDisabledHint({ isRepo: true, detached: true })).toBe('Cannot push detached HEAD');
    expect(pushDisabledHint({ isRepo: true, detached: false, remotes: [] })).toBe('No remote configured');
    expect(pushDisabledHint({ isRepo: true, detached: false, remotes: [{ name: 'origin' }], behind: 3 }))
      .toBe('Branch is 3 commit(s) behind remote');
    expect(pushDisabledHint({ isRepo: true, detached: false, remotes: [{ name: 'origin' }], behind: 0 })).toBe('');
    expect(pushDisabledHint({ isRepo: true, detached: false, remotes: [{ name: 'origin' }], upstream: 'origin/main', ahead: 0 }))
      .toBe('Up to date with origin/main');
    expect(pushDisabledHint({ isRepo: true, detached: false, remotes: [{ name: 'origin' }], upstream: 'origin/main', ahead: 2 })).toBe('');
  });

  it('pushConfirmWarnings warns on default branch and live agents', () => {
    const warnings = pushConfirmWarnings({
      branch: 'main',
      detached: false,
      liveAgents: [{ conversationId: 'c1', title: 'Agent A' }],
      remote: 'origin',
    });
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain('main');
    expect(warnings[1]).toContain('Agent A');
  });

  it('formatAheadBehind formats counts cleanly', () => {
    expect(formatAheadBehind(undefined, undefined)).toBeNull();
    expect(formatAheadBehind(0, 0)).toBeNull();
    expect(formatAheadBehind(5, 0)).toBe('↑5 ahead');
    expect(formatAheadBehind(0, 2)).toBe('↓2 behind');
    expect(formatAheadBehind(3, 1)).toBe('↑3 ahead, ↓1 behind');
  });
});

describe('shortenCwd', () => {
  it('replaces Linux /home/<user> with ~', () => {
    expect(shortenCwd('/home/user/Projects/Tierwyn')).toBe('~/Projects/Tierwyn');
  });

  it('replaces macOS /Users/<user> with ~', () => {
    expect(shortenCwd('/Users/alice/Projects/Tierwyn')).toBe('~/Projects/Tierwyn');
  });

  it('replaces Windows user path with ~', () => {
    expect(shortenCwd('C:\\Users\\bob\\Projects\\Tierwyn')).toBe('~\\Projects\\Tierwyn');
  });

  it('leaves non-home paths untouched', () => {
    expect(shortenCwd('/var/www/project')).toBe('/var/www/project');
    expect(shortenCwd('/tmp/repo')).toBe('/tmp/repo');
  });

  it('handles empty string', () => {
    expect(shortenCwd('')).toBe('');
  });
});

describe('canDiscardUnstaged', () => {
  it('is true for modified and deleted', () => {
    expect(canDiscardUnstaged('modified')).toBe(true);
    expect(canDiscardUnstaged('deleted')).toBe(true);
  });

  it('is false for new, renamed, and conflicted', () => {
    expect(canDiscardUnstaged('new')).toBe(false);
    expect(canDiscardUnstaged('renamed')).toBe(false);
    expect(canDiscardUnstaged('conflicted')).toBe(false);
  });
});

describe('shouldCloseWorkingTreeModal', () => {
  const base = {
    historyOpen: false,
    hasStatus: true,
    openFile: false,
    deleteTarget: false,
    discardTarget: false,
    confirmOpen: false,
    pushConfirmOpen: false,
    llmOpsOpen: false,
  };

  it('allows closing when no child overlays or modals are open', () => {
    expect(shouldCloseWorkingTreeModal(base)).toBe(true);
  });

  it('blocks closing when history is open with valid status', () => {
    expect(shouldCloseWorkingTreeModal({ ...base, historyOpen: true })).toBe(false);
  });

  it('allows closing if historyOpen is true but hasStatus is false (unmounted history)', () => {
    expect(shouldCloseWorkingTreeModal({ ...base, historyOpen: true, hasStatus: false })).toBe(true);
  });

  it('blocks closing when any confirmation dialog is open', () => {
    expect(shouldCloseWorkingTreeModal({ ...base, confirmOpen: true })).toBe(false);
    expect(shouldCloseWorkingTreeModal({ ...base, pushConfirmOpen: true })).toBe(false);
    expect(shouldCloseWorkingTreeModal({ ...base, deleteTarget: true })).toBe(false);
    expect(shouldCloseWorkingTreeModal({ ...base, discardTarget: true })).toBe(false);
    expect(shouldCloseWorkingTreeModal({ ...base, openFile: true })).toBe(false);
  });

  it('blocks closing when the LLM git operations modal is open', () => {
    expect(shouldCloseWorkingTreeModal({ ...base, llmOpsOpen: true })).toBe(false);
  });

  it('allows closing if llmOpsOpen is true but hasStatus is false (unmounted llm ops)', () => {
    expect(shouldCloseWorkingTreeModal({ ...base, llmOpsOpen: true, hasStatus: false })).toBe(true);
  });
});

describe('W1: switchDisabledHint', () => {
  it('returns empty string when clean and enabled', () => {
    expect(switchDisabledHint({
      isRepo: true, staged: [], unstaged: [], liveAgents: [], hasConflicts: false,
    })).toBe('');
  });

  it('detects dirty tree (staged)', () => {
    expect(switchDisabledHint({
      isRepo: true, staged: [{ path: 'a' }], unstaged: [], liveAgents: [], hasConflicts: false,
    })).toBe('Cannot switch branch: working tree has uncommitted changes. Stash or commit first.');
  });

  it('detects dirty tree (unstaged)', () => {
    expect(switchDisabledHint({
      isRepo: true, staged: [], unstaged: [{ path: 'a' }], liveAgents: [], hasConflicts: false,
    })).toBe('Cannot switch branch: working tree has uncommitted changes. Stash or commit first.');
  });

  it('detects live agents', () => {
    expect(switchDisabledHint({
      isRepo: true, staged: [], unstaged: [], liveAgents: [{ conversationId: 'c1', title: 'Agent' }], hasConflicts: false,
    })).toBe('Cannot switch branch while an agent is active');
  });

  it('detects conflicts', () => {
    expect(switchDisabledHint({
      isRepo: true, staged: [], unstaged: [], liveAgents: [], hasConflicts: true,
    })).toBe('Resolve conflicts before switching branches');
  });

  it('detects non-repo', () => {
    expect(switchDisabledHint({
      isRepo: false, staged: [], unstaged: [], liveAgents: [], hasConflicts: false,
    })).toBe('Not a git repository');
  });
});

describe('W2: isPullEnabled & pullDisabledHint', () => {
  const base = {
    isRepo: true,
    detached: false,
    upstream: 'origin/main',
    behind: 2,
    liveAgents: [],
  };

  it('is enabled on happy path', () => {
    expect(isPullEnabled(base)).toBe(true);
    expect(pullDisabledHint(base)).toBe('');
  });

  it('is disabled when not a repo', () => {
    expect(isPullEnabled({ ...base, isRepo: false })).toBe(false);
    expect(pullDisabledHint({ ...base, isRepo: false })).toBe('Not a git repository');
  });

  it('is disabled on detached HEAD', () => {
    expect(isPullEnabled({ ...base, detached: true })).toBe(false);
    expect(pullDisabledHint({ ...base, detached: true })).toBe('Cannot pull on detached HEAD');
  });

  it('is disabled with no upstream', () => {
    expect(isPullEnabled({ ...base, upstream: null })).toBe(false);
    expect(pullDisabledHint({ ...base, upstream: null })).toBe('No upstream branch configured');
  });

  it('is disabled when behind is 0', () => {
    expect(isPullEnabled({ ...base, behind: 0 })).toBe(false);
    expect(pullDisabledHint({ ...base, behind: 0 })).toBe('Already up to date');
  });

  it('is disabled when live agents active', () => {
    const withAgents = { ...base, liveAgents: [{ conversationId: 'c1', title: 'A' }] };
    expect(isPullEnabled(withAgents)).toBe(false);
    expect(pullDisabledHint(withAgents)).toBe('Cannot pull while an agent is active');
  });
});

describe('W3: canStash & canPopStash', () => {
  it('canStash true when repo has changes and no conflicts/agents', () => {
    expect(canStash({ isRepo: true, staged: [], unstaged: [{ path: 'u' }], liveAgents: [], hasConflicts: false })).toBe(true);
    expect(canStash({ isRepo: true, staged: [{ path: 's' }], unstaged: [], liveAgents: [], hasConflicts: false })).toBe(true);
  });

  it('canStash false when clean', () => {
    expect(canStash({ isRepo: true, staged: [], unstaged: [], liveAgents: [], hasConflicts: false })).toBe(false);
  });

  it('canStash false when live agents', () => {
    expect(canStash({ isRepo: true, staged: [{ path: 's' }], unstaged: [], liveAgents: [{ conversationId: '1', title: 't' }], hasConflicts: false })).toBe(false);
  });

  it('canStash false when conflicted', () => {
    expect(canStash({ isRepo: true, staged: [{ path: 's' }], unstaged: [], liveAgents: [], hasConflicts: true })).toBe(false);
  });

  it('canPopStash true when stashCount > 0 and no agents', () => {
    expect(canPopStash({ isRepo: true, stashCount: 1, liveAgents: [] })).toBe(true);
    expect(canPopStash({ isRepo: true, stashCount: 0, liveAgents: [] })).toBe(false);
    expect(canPopStash({ isRepo: true, stashCount: 2, liveAgents: [{ conversationId: '1', title: 't' }] })).toBe(false);
    expect(canPopStash({ isRepo: false, stashCount: 2, liveAgents: [] })).toBe(false);
  });
});

describe('W4: switchConfirmWarning', () => {
  it('warns when switching to main', () => {
    expect(switchConfirmWarning('feature', 'main', false)).toContain('Switching to "main"');
  });

  it('warns when switching away from master', () => {
    expect(switchConfirmWarning('master', 'feature', false)).toContain('Switching away from "master"');
  });

  it('returns null when switching feature to feature', () => {
    expect(switchConfirmWarning('feat-a', 'feat-b', false)).toBeNull();
  });

  it('returns null when from is detached even if called main', () => {
    expect(switchConfirmWarning('main', 'feat-b', true)).toBeNull();
  });
});

describe('W5: defaultWorktreeFolder', () => {
  it('generates expected folder name mirroring server default', () => {
    expect(defaultWorktreeFolder('/home/user/project', 'feature/new')).toBe('project-feature-new');
    expect(defaultWorktreeFolder('/var/repo/', 'v1.0')).toBe('repo-v1.0');
    expect(defaultWorktreeFolder('C:\\Users\\user\\project', 'bugfix/issue-12')).toBe('project-bugfix-issue-12');
    expect(defaultWorktreeFolder('/home/user/project', 'feat+plus@foo')).toBe('project-feat-plus-foo');
  });
});


describe('gitDiffReturnTo', () => {
  it('closes straight back to the working tree when opened from it', () => {
    expect(gitDiffReturnTo({ closeOnExit: true, mode: 'view' })).toBe('close');
  });
  it('returns to editing when the diff was opened from the editor', () => {
    expect(gitDiffReturnTo({ closeOnExit: false, mode: 'edit' })).toBe('edit');
    expect(gitDiffReturnTo({ closeOnExit: false, mode: 'git-diff', prevReturnTo: 'edit' })).toBe('edit');
  });
  it('returns to the file view otherwise', () => {
    expect(gitDiffReturnTo({ closeOnExit: false, mode: 'view' })).toBe('view');
    expect(gitDiffReturnTo({ closeOnExit: false, mode: 'git-diff', prevReturnTo: 'close' })).toBe('view');
  });
});
