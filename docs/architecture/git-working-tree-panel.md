# Git working tree panel

Operator guide for reviewing a git working tree, staging paths, inspecting diffs, and committing; without a terminal or agent shell.

| | |
|---|---|
| **UI** | Command palette **Git working tree** or conversation ⋯ **Git working tree…** |
| **Code** | `apps/server/src/routes/gitWorkingTree.ts`, `apps/server/src/git/workingTree.ts`, `apps/web/src/components/GitWorkingTreeModal.tsx` |
| **Types** | `@tierwyn/shared` → `gitWorkingTree.ts` |
| **Server ops** | [Git Server Operations](./git-server-ops.md): `/files/working-tree*`, `/files/git-*` route architecture and live-agent 409s |

This panel focuses on staging, unstaging, and committing. Pull, branch management, stash, and worktree operations are available via separate routes; see [git-server-ops.md](./git-server-ops.md) for server-side behaviour.
Pushing committed changes to configured remotes (`origin`) is supported.

---

## What it does

- Lists **Staged** and **Unstaged** paths for one selected git tree (project root or conversation worktree).
- **Stage** / **Unstage** per path (`git add -- <path>` / `git restore --staged -- <path>`).
- **Stage all** / **Unstage all** on the group header when that list has two or more eligible files (conflicted paths are skipped). Still one literal pathspec per git call; never `git add .`.
- Click a path → **FileModal** git-diff vs `HEAD` (existing `GET /files/git-diff`).
  Closing the diff (Esc, ✕, overlay, **Close**) returns straight to the working tree panel; the pen icon in the diff header opens the file view/editor instead.
- **Generate / Regenerate** fills the commit message box from the `commit` sidecar (Settings → Direct LLM). Overwrites the box; the operator still presses **Commit**.
- **Commit** records **only the index** with a message + confirm step (supports Ctrl+Enter shortcut).
- **Push to origin** pushes committed changes to the configured remote when remotes are available, with confirmation on protected branches.

Vocabulary is **Stage / Unstage**, never Track.

---

## Entry points and default tree

| Opened from | Default tree |
|---|---|
| Conversation ⋯ on **C** | C's `workdirPath` if set, else project `rootPath` (uses **C**, not the transcript selection) |
| Command palette + conversation selected | That conversation's tree |
| Command palette + project only | Project `rootPath` |

The switcher lists project root, every conversation `workdir_path` in the project (including archived / schedule rows), plus extra paths from `git worktree list` for the same repository. Opening or refreshing the panel (`GET /files/working-tree`) nulls conversation `workdir_path` values whose directories are gone (conversations stay) and runs `git worktree prune` on that project root; missing paths are omitted and a stale selected cwd falls back to the project root.

Non-git roots show an empty state; mutations are disabled.

---

## Staged list vs FileModal diff

The panel's Staged/Unstaged groups come from `git status --porcelain` (accurate index view).

FileModal's diff is `git diff HEAD -- <file>`: **combined staged + unstaged vs HEAD**. That mismatch is intentional in v1; do not expect a staged-only diff in FileModal.

---

## Warnings (non-blocking)

- **Live agent** on this tree: names the conversation; commit is allowed locally. On remote hosts, mutations return 409 (see [git-server-ops.md](./git-server-ops.md)).
- **`main` / `master`**: reminds that prod may serve this checkout.

---

## Security

- **Cookie session only**: routes mount after `requireAuth`; spawn/schedule bearers cannot call them.
- **Cwd allow-list**: project `rootPath` or a worktree of that repo (stored conversation workdir or `git worktree list` entry).
- **Pathspec validation**: no `..`, no `.git` segments, no symlink escape; `index.lock` surfaces as git stderr (409 when locked).
- Pre-commit hooks run; no `--no-verify`.
- **Commit-message LLM input** is `git diff --cached` + `git log --format=%s` only; no transcripts, env, or vault. The generated message (subject + short body) is model output over untrusted repo content; always read the diff you are committing.

---

## Additional features

Pull, branches, stash, and worktree management are available via separate server routes documented in [git-server-ops.md](./git-server-ops.md).
