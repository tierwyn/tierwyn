import { describe, it, expect } from 'vitest';
import {
  buildSplitCommitsPrompt,
  buildMergedWorktreesPrompt,
  buildCustomGitPrompt,
  canSubmitGitPrompt,
  gitPromptSubmitHint,
  resolveGitPromptTarget,
  type GitLlmSubmitTarget,
} from './gitLlmPrompts.js';

const CWD = '/home/user/Projects/Tierwyn';
const SPACE_CWD = '/home/me/My Projects/repo';
const DOLLAR_CWD = '/tmp/x$&y';

const idleReady: GitLlmSubmitTarget = {
  conversationId: 'conv-a',
  conversationTitle: 'Refactor pass',
  profileLabel: 'claude-code · claude-sonnet-4-5',
  archived: false,
  isRunning: false,
  differsFromSelection: false,
};

const readyProfile = { id: 'claude-code:sonnet', agentType: 'claude-code', model: 'claude-sonnet-4-5' };
const panelA = { id: 'conv-a', title: 'Refactor pass', archived: false };
const panelB = { id: 'conv-b', title: 'Other chat', archived: false };

describe('buildSplitCommitsPrompt', () => {
  it('embeds the given cwd verbatim and names it as the only target', () => {
    const p = buildSplitCommitsPrompt(CWD);
    expect(p).toContain(CWD);
    expect(p).not.toContain('~/Projects/Tierwyn');
    expect(p).toContain(`Working tree: ${CWD}`);
    expect(p).toContain('Operate ONLY inside that directory');
  });

  it('requires conventional commits and forbids git add -A / git add . as something to run', () => {
    const p = buildSplitCommitsPrompt(CWD);
    expect(p).toContain('`type(scope): subject`');
    expect(p).toContain('Never use `git add -A`');
    const withoutForbid = p.replace('Never use `git add -A` or `git add .`', '');
    expect(withoutForbid).not.toContain('git add .');
  });

  it('shell-quotes cwd in git -C command lines when the path contains a space', () => {
    const p = buildSplitCommitsPrompt(SPACE_CWD);
    expect(p).toContain("git -C '/home/me/My Projects/repo'");
    expect(p).toContain(`Working tree: ${SPACE_CWD}`);
    expect(p).not.toContain('git -C /home/me/My Projects/repo ');
  });

  it('interpolates a $&-bearing cwd without String.replace replacement patterns', () => {
    const p = buildSplitCommitsPrompt(DOLLAR_CWD);
    expect(p).toContain(`Working tree: ${DOLLAR_CWD}`);
    expect(p).toContain(`git -C '${DOLLAR_CWD}'`);
    expect(p).not.toContain('Working tree: /tmp/x<cwd>y');
  });

  it('does not rescan a cwd that itself contains the literal <cwd>', () => {
    const nested = '/tmp/<cwd>/x';
    const p = buildSplitCommitsPrompt(nested);
    expect(p).toContain(`Working tree: ${nested}`);
    expect(p).toContain(`git -C '${nested}'`);
    expect(p).not.toContain("git -C '/tmp//tmp/<cwd>/x/x'");
  });
});

describe('buildMergedWorktreesPrompt', () => {
  it('embeds the given cwd verbatim and names it as the only target', () => {
    const p = buildMergedWorktreesPrompt(CWD);
    expect(p).toContain(CWD);
    expect(p).not.toContain('~/Projects/Tierwyn');
    expect(p).toContain(`Repository: ${CWD}`);
    expect(p).toContain('Operate ONLY on worktrees of that repository');
  });

  it('forbids --force and requires merged-branch checks plus the never-remove list', () => {
    const p = buildMergedWorktreesPrompt(CWD);
    expect(p).toContain('Never pass `--force`');
    expect(p).toContain('branch --merged');
    expect(p).toContain('worktree list --porcelain');
    expect(p).toContain('primary checkout');
    expect(p).toContain('the worktree holding the main branch');
    expect(p).toContain('detached HEAD');
  });

  it('shell-quotes cwd in git -C command lines when the path contains a space', () => {
    const p = buildMergedWorktreesPrompt(SPACE_CWD);
    expect(p).toContain("git -C '/home/me/My Projects/repo'");
    expect(p).toContain(`Repository: ${SPACE_CWD}`);
    expect(p).not.toContain('git -C /home/me/My Projects/repo ');
  });

  it('interpolates a $&-bearing cwd without String.replace replacement patterns', () => {
    const p = buildMergedWorktreesPrompt(DOLLAR_CWD);
    expect(p).toContain(`Repository: ${DOLLAR_CWD}`);
    expect(p).toContain(`git -C '${DOLLAR_CWD}'`);
    expect(p).not.toContain('Repository: /tmp/x<cwd>y');
  });
});

describe('buildCustomGitPrompt', () => {
  it('returns null for blank input', () => {
    expect(buildCustomGitPrompt(CWD, '')).toBeNull();
    expect(buildCustomGitPrompt(CWD, '   ')).toBeNull();
    expect(buildCustomGitPrompt(CWD, '\n\n')).toBeNull();
  });

  it('trims the body and prefixes the scoping line with the verbatim cwd', () => {
    const p = buildCustomGitPrompt(CWD, '  rebase onto main  \n');
    expect(p).not.toBeNull();
    expect(p!.startsWith(`Git task in ${CWD} — operate only inside that directory, and do not push unless I asked you to.`)).toBe(true);
    expect(p).toContain('rebase onto main');
    expect(p).not.toContain('  rebase onto main  ');
    expect(p).not.toContain('~/Projects/Tierwyn');
  });
});

describe('canSubmitGitPrompt', () => {
  it('is false with no conversation, archived conversation, or no profile', () => {
    expect(canSubmitGitPrompt(null)).toBe(false);
    expect(canSubmitGitPrompt(undefined)).toBe(false);
    expect(canSubmitGitPrompt({ ...idleReady, conversationId: null })).toBe(false);
    expect(canSubmitGitPrompt({ ...idleReady, archived: true })).toBe(false);
    expect(canSubmitGitPrompt({ ...idleReady, profileLabel: null })).toBe(false);
  });

  it('does not treat a null title as a missing conversation when an id is present', () => {
    expect(canSubmitGitPrompt({ ...idleReady, conversationTitle: null })).toBe(true);
  });

  it('is true when idle or running with a live conversation and profile', () => {
    expect(canSubmitGitPrompt(idleReady)).toBe(true);
    expect(canSubmitGitPrompt({ ...idleReady, isRunning: true })).toBe(true);
  });

  it('is false when the panel conversation differs from the selection', () => {
    expect(canSubmitGitPrompt({ ...idleReady, differsFromSelection: true })).toBe(false);
    expect(canSubmitGitPrompt({ ...idleReady, differsFromSelection: true, isRunning: true })).toBe(false);
  });
});

describe('gitPromptSubmitHint', () => {
  it('returns the select-a-conversation hint when there is no conversation', () => {
    expect(gitPromptSubmitHint(null)).toBe('Select a conversation in this project to run git operations.');
    expect(gitPromptSubmitHint({ ...idleReady, conversationId: null, conversationTitle: 'still a title' }))
      .toBe('Select a conversation in this project to run git operations.');
  });

  it('returns the no-agent hint when archived or the profile is unresolved', () => {
    expect(gitPromptSubmitHint({ ...idleReady, archived: true }))
      .toBe('No agent available for this conversation.');
    expect(gitPromptSubmitHint({ ...idleReady, profileLabel: null }))
      .toBe('No agent available for this conversation.');
  });

  it('returns the queue hint only when running and submittable', () => {
    expect(gitPromptSubmitHint({ ...idleReady, isRunning: true }))
      .toBe('Agent is running — this will be queued after the current turn.');
    expect(gitPromptSubmitHint({ ...idleReady, isRunning: true, archived: true }))
      .not.toBe('Agent is running — this will be queued after the current turn.');
    expect(gitPromptSubmitHint({ ...idleReady, isRunning: true, differsFromSelection: true }))
      .not.toBe('Agent is running — this will be queued after the current turn.');
  });

  it('returns the select-this-conversation hint when the panel conversation differs from the selection', () => {
    expect(gitPromptSubmitHint({ ...idleReady, differsFromSelection: true }))
      .toBe('Select this conversation to run git operations.');
    expect(gitPromptSubmitHint({ ...idleReady, differsFromSelection: true, isRunning: true }))
      .toBe('Select this conversation to run git operations.');
  });

  it('disabled differs-from-selection hint is distinct from the no-conversation hint', () => {
    const differs = gitPromptSubmitHint({ ...idleReady, differsFromSelection: true });
    const none = gitPromptSubmitHint(null);
    expect(differs).toBe('Select this conversation to run git operations.');
    expect(none).toBe('Select a conversation in this project to run git operations.');
    expect(differs).not.toBe(none);
  });

  it('returns null when idle and submittable', () => {
    expect(gitPromptSubmitHint(idleReady)).toBeNull();
  });
});

describe('resolveGitPromptTarget', () => {
  it('same-conversation idle: submittable, sendPrompt (not steer)', () => {
    const r = resolveGitPromptTarget({
      panelConversation: panelA,
      profile: readyProfile,
      isRunning: false,
      differsFromSelection: false,
    });
    expect(r.kind).toBe('ok');
    expect(r.conversationId).toBe('conv-a');
    expect(r.conversationTitle).toBe('Refactor pass');
    expect(r.useSteerQueue).toBe(false);
    expect(r.differsFromSelection).toBe(false);
    expect(r.hint).toBeNull();
  });

  it('same-conversation running: submittable, steer-queue', () => {
    const r = resolveGitPromptTarget({
      panelConversation: panelA,
      profile: readyProfile,
      isRunning: true,
      differsFromSelection: false,
    });
    expect(r.kind).toBe('ok');
    expect(r.useSteerQueue).toBe(true);
    expect(r.isRunning).toBe(true);
    expect(r.hint).toBe('Agent is running — this will be queued after the current turn.');
  });

  it('different-conversation idle: disabled with select-this hint, no submit shape', () => {
    const r = resolveGitPromptTarget({
      panelConversation: panelB,
      profile: readyProfile,
      isRunning: false,
      differsFromSelection: true,
    });
    expect(r.kind).toBe('disabled');
    expect(r.conversationId).toBe('conv-b');
    expect(r.differsFromSelection).toBe(true);
    expect(r.useSteerQueue).toBe(false);
    expect(r.hint).toBe('Select this conversation to run git operations.');
  });

  it('different-conversation running: disabled; queue hint is same-conversation only', () => {
    const r = resolveGitPromptTarget({
      panelConversation: panelB,
      profile: readyProfile,
      isRunning: true,
      differsFromSelection: true,
    });
    expect(r.kind).toBe('disabled');
    expect(r.useSteerQueue).toBe(false);
    expect(r.hint).toBe('Select this conversation to run git operations.');
    expect(r.hint).not.toBe('Agent is running — this will be queued after the current turn.');
  });

  it('no-conversation: disabled with the select-a-conversation hint', () => {
    const r = resolveGitPromptTarget({
      panelConversation: null,
      profile: readyProfile,
      isRunning: false,
      differsFromSelection: false,
    });
    expect(r.kind).toBe('disabled');
    expect(r.conversationId).toBeNull();
    expect(r.useSteerQueue).toBe(false);
    expect(r.hint).toBe('Select a conversation in this project to run git operations.');
    expect(r.hint).not.toBe('Select this conversation to run git operations.');
  });

  it('archived same-conversation: disabled even if a profile is resolved', () => {
    const r = resolveGitPromptTarget({
      panelConversation: { ...panelA, archived: true },
      profile: readyProfile,
      isRunning: false,
      differsFromSelection: false,
    });
    expect(r.kind).toBe('disabled');
    expect(r.conversationId).toBe('conv-a');
    expect(r.archived).toBe(true);
    expect(r.hint).toBe('No agent available for this conversation.');
  });

  it('no profile: disabled', () => {
    const r = resolveGitPromptTarget({
      panelConversation: panelA,
      profile: null,
      isRunning: false,
      differsFromSelection: false,
    });
    expect(r.kind).toBe('disabled');
    expect(r.hint).toBe('No agent available for this conversation.');
  });
});
