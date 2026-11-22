export type GitLlmSubmitTarget = {
  conversationId: string | null;
  conversationTitle: string | null;
  profileLabel: string | null;
  archived: boolean;
  isRunning: boolean;
  differsFromSelection: boolean;
};

export type GitPromptPanelConversation = {
  id: string;
  title: string;
  archived: boolean;
};

export type GitPromptProfile = {
  id: string;
  agentType: string;
  model: string;
};

export type GitPromptTargetResolved = GitLlmSubmitTarget & {
  kind: 'ok' | 'disabled';
  useSteerQueue: boolean;
  hint: string | null;
};

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", () => `'\\''`)}'`;
}

function withCwd(template: string, cwd: string): string {
  const quoted = shellSingleQuote(cwd);
  // Single pass: a cwd containing the literal `<cwd>` must not be rescanned
  // by a second replaceAll (that produced `git -C '/tmp//tmp/<cwd>/x/x'`).
  return template.replace(/git -C <cwd>|<cwd>/g, (match) => (
    match === 'git -C <cwd>' ? `git -C ${quoted}` : cwd
  ));
}

export function buildSplitCommitsPrompt(cwd: string): string {
  return withCwd(`Split the uncommitted changes in this working tree into logical commits.

Working tree: <cwd>
Operate ONLY inside that directory. Do not touch any other repository, worktree, or checkout on this machine. Do not switch branches, do not rebase, do not push.

1. Review EVERY uncommitted change, staged and unstaged alike: \`git -C <cwd> status --porcelain=v1\`, then \`git -C <cwd> diff\` and \`git -C <cwd> diff --cached\`. Read the diffs — do not decide from filenames.
2. Group the changed files into the smallest set of commits that are each coherent from a code perspective: one concern per commit, and files that only make sense together in the same commit (implementation with its test, a component with its styles, a migration with the code that reads it). Do not group by directory alone, and do not make one commit per file unless the changes really are unrelated.
3. Commit each group by staging its exact paths — \`git -C <cwd> add -- <paths>\` — and committing immediately afterwards, then move to the next group. Never use \`git add -A\` or \`git add .\`.
4. Message format is \`type(scope): subject\`. Types: feat, fix, docs, refactor, perf, test, chore, build, ci, style, revert. Scopes: server, web, shared, adapters, spawn, schedules, tts, ui, deploy, security. Subject imperative, at most 72 characters, no trailing period. Add a body only when the reason for the change is not obvious from the subject.
5. Leave anything you are unsure about uncommitted rather than guessing — generated or build output, anything that looks like a secret or credential, large binaries, and unrelated debug leftovers.
6. Do not amend, reset, or rewrite existing commits. Do not push. Do not create or delete branches.

Finish with a short report to me: one line per commit (\`<short sha> <subject>\`) with the files it contains, then anything you deliberately left uncommitted and why.`, cwd);
}

export function buildMergedWorktreesPrompt(cwd: string): string {
  return withCwd(`Remove only the git worktrees of this project whose branches are fully merged.

Repository: <cwd>
Operate ONLY on worktrees of that repository. Do not touch any other repository or any path outside it. Do not push.

1. List every worktree with its path and branch: \`git -C <cwd> worktree list --porcelain\`.
2. Determine the main branch: whatever \`git -C <cwd> symbolic-ref --quiet refs/remotes/origin/HEAD\` points at; if that fails, \`main\`; if that does not exist, \`master\`.
3. NEVER remove any of these, whatever the merge status says: the primary checkout (the first entry of \`worktree list\`), the worktree holding the main branch, the worktree you are currently inside, and any worktree with a detached HEAD.
4. For each remaining worktree, run ALL of these checks BEFORE removing anything, and treat any failing or ambiguous check as "keep":
   - \`git -C <worktree path> status --porcelain\` prints nothing — no uncommitted and no untracked changes.
   - \`git -C <cwd> branch --merged <main branch>\` lists its branch — the branch is fully merged into the main branch.
   - \`git -C <cwd> log --oneline <main branch>..<branch>\` prints nothing — no commits ahead of main.
5. Print the keep/remove decision for every worktree with the evidence you based it on, and only THEN remove the approved ones, one at a time: \`git -C <cwd> worktree remove <path>\`. Never pass \`--force\`. If a removal fails, stop and report it — do not work around it.
6. Do not delete branches, do not prune worktrees you did not verify, do not touch the main branch, do not push.

Finish with a short report to me: every worktree with its path, branch, merged yes/no, removed or kept, and the reason.`, cwd);
}

export function buildCustomGitPrompt(cwd: string, text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return `Git task in ${cwd} — operate only inside that directory, and do not push unless I asked you to.\n\n${trimmed}`;
}

export function canSubmitGitPrompt(target: GitLlmSubmitTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.conversationId === null) return false;
  if (target.differsFromSelection) return false;
  if (target.archived) return false;
  if (!target.profileLabel) return false;
  return true;
}

export function gitPromptSubmitHint(target: GitLlmSubmitTarget | null | undefined): string | null {
  if (!target || target.conversationId === null) {
    return 'Select a conversation in this project to run git operations.';
  }
  if (target.differsFromSelection) {
    return 'Select this conversation to run git operations.';
  }
  if (target.archived || !target.profileLabel) {
    return 'No agent available for this conversation.';
  }
  if (target.isRunning) {
    return 'Agent is running — this will be queued after the current turn.';
  }
  return null;
}

export function resolveGitPromptTarget(input: {
  panelConversation: GitPromptPanelConversation | null;
  profile: GitPromptProfile | null;
  isRunning: boolean;
  differsFromSelection: boolean;
}): GitPromptTargetResolved {
  const conv = input.panelConversation;
  if (!conv) {
    return {
      kind: 'disabled',
      conversationId: null,
      conversationTitle: null,
      profileLabel: null,
      archived: false,
      isRunning: false,
      differsFromSelection: false,
      useSteerQueue: false,
      hint: 'Select a conversation in this project to run git operations.',
    };
  }

  const profileLabel = input.profile
    ? `${input.profile.agentType} · ${input.profile.model}`
    : null;
  const differsFromSelection = input.differsFromSelection;
  const submittable = !differsFromSelection && !conv.archived && !!input.profile;
  const useSteerQueue = submittable && input.isRunning;
  const hint = differsFromSelection
    ? 'Select this conversation to run git operations.'
    : !submittable
      ? 'No agent available for this conversation.'
      : (input.isRunning
        ? 'Agent is running — this will be queued after the current turn.'
        : null);

  return {
    kind: submittable ? 'ok' : 'disabled',
    conversationId: conv.id,
    conversationTitle: conv.title,
    profileLabel,
    archived: conv.archived,
    isRunning: input.isRunning,
    differsFromSelection,
    useSteerQueue,
    hint,
  };
}
