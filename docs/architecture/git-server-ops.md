# Git Server Operations

The server-side git layer that backs the operator's working-tree panel, history,
branch, and worktree views. It covers the `/files/working-tree*`,
`/files/git-history*`, `/files/git-branches`, and `/files/git-branch-diff*`
routes, and the shared `GitOps` abstraction that lets the same routes run on the
hub or on a [remote host](./remote-hosts.md). For the UI, see
[git-working-tree-panel.md](./git-working-tree-panel.md).

| | |
|---|---|
| **Routes** | `apps/server/src/routes/gitWorkingTree.ts` (`registerGitWorkingTreeRoutes`) |
| **Git primitives** | `apps/server/src/git/workingTree.ts` |
| **Request resolution / live-agent check** | `apps/server/src/git/workingTreeContext.ts` |
| **Local vs remote dispatch** | `apps/server/src/git/remoteOps.ts` (`GitOps`, `localGitOps`, `RemoteGitOps`) |
| **Node-side handler** | `apps/server/src/node/gitCall.ts` (`gitCall`) |
| **Commit-message drafts** | `repositories/gitCommitDrafts.ts`, `commitMessage.ts` |
| **Types** | `@tierwyn/shared` → `gitWorkingTree.ts`; method lists in `node.ts` |

Not covered here: checkpoint shadow refs (`git/shadowOps.ts`,
`git/shadowCheckpoint.ts`, `git/checkpointOps.ts`, see
[checkpoints.md](./checkpoints.md)) and the plain file diff
`GET /files/git-diff` (`routes/files.ts`).

## Auth and execution

- **Cookie only.** The routes are registered after `requireAuth` in
  `index.ts`, so agent bearer tokens can't reach them.
- **No shell.** Every call is `execFile('git', argv)`; user input is never
  interpolated into a command string. Path arguments are passed as
  `:(literal)<path>` pathspecs after `--`.
- **Sync vs async.** Most operations use `gitExec` (synchronous `execFileSync`,
  10 MiB output buffer). Fetch and pull use `gitExecAsync` with a 120 s timeout
  and `GIT_TERMINAL_PROMPT=0`, so a credential prompt fails instead of hanging.
  On remote hosts, fetch/pull/push RPCs get a 180 s timeout
  (`GIT_NETWORK_TIMEOUT_MS`).

## Resolving which tree a request targets

Every request carries `conversationId` or `projectId`, and usually `cwd`.
`resolveGitRequest()` turns that into `{ project, cwd, ops, remoteHostId }`:

1. Load the conversation (if given) and its project. A `projectId` that doesn't
   match the conversation's project is a `400`.
2. Pick the cwd: the requested `cwd` if it exists, else the project root. With
   no `cwd`, use the conversation's `workdirPath` if it exists, else the root. A
   requested directory that no longer exists falls back to the root rather than
   failing, so a stale UI selection self-heals. **Exception:** mutation routes
   that take a `cwd` return `404` for a missing directory instead, so a write
   never lands silently on the project root.
3. Normalise to the repo top level (`git rev-parse --show-toplevel`).
4. **Allow-list check** (`isCwdAllowedForProject`, compared by realpath). The
   cwd must be one of:
   - the project root;
   - a nested git repo under the root (`listNestedGitRepos`);
   - a conversation `workdir_path` in this project that shares the root's git
     common dir;
   - an entry in `git worktree list` for the root.

   If the project root isn't a git repo, the only other allowed paths are
   conversation workdirs that are git repos (and the root itself, which then
   answers `400 not a git repository`). Anything else → `403 cwd is not a worktree of this
   project`.

On remote hosts, step 4 instead checks membership in the tree list the node
reports (`buildRemoteTreeList`). The node re-checks every path against its own
policy roots anyway (see [Remote hosts](#remote-hosts)).

`GET /files/working-tree` also **heals** local projects first
(`healWorkingTreesForRequest`): it nulls conversation `workdir_path` values whose
directories are gone and runs `git worktree prune` on the root.

## Validation rules

| Input | Rule (`git/workingTree.ts`) |
|---|---|
| Path | `validatePathspec`: non-empty, no NUL, relative, no `..` or `.git` segment, resolves inside the tree, realpath (symlinks included) stays inside the tree, not a directory. A symlink is staged as the link itself. Errors map to `403`. |
| Branch name | `assertBranchName`: letters/digits/`._/+-`, ≤ 200 chars, no leading `-`/`.`/`/`, no `..`, `//`, `@{`, trailing `/`, `.`, or `.lock`. New branches also pass `git check-ref-format --branch`. |
| Ref | `assertRef`: `HEAD`, a hex sha (4–64), or a valid branch name. |
| Sha | `assertSha`: hex only, so `HEAD@{1}` or `--upload-pack=…` can't pass. |
| Worktree folder | `assertFolderName`: `[A-Za-z0-9._-]{1,100}`, no leading `.`/`-`. |
| Commit message | Non-empty, ≤ 64 KiB, piped on stdin (`commit -F -`). |
| Stash message | Newlines collapsed, ≤ 200 chars. |

## Safety rules for mutations

**Live agents.** `liveAgentsFor()` lists non-parked sessions whose cwd resolves
to the selected tree. Locally that's a realpath compare; on remote hosts it's
the session cwd's top level on the same host.

| Operation | Live agent on the tree | Other guards |
|---|---|---|
| switch-branch | **409** | Working tree must be clean (staged + unstaged empty) → else 409. Unmerged paths → 409. |
| create-branch, pull, stash, stash-pop | **409** | Unmerged paths → 409 |
| stage, unstage, commit, discard, delete | **409 on remote hosts only.** Locally the panel just shows a warning. | Commit: unmerged → 400, nothing staged → 400 |
| fetch, push, create-worktree | Not checked | Push: detached HEAD → 400 |

The 409 for branch/stash/pull operations exists because those change files
under a running agent. Staging and committing only touch the index and history,
so they are allowed next to a live local agent.

Git failures are mapped to HTTP codes in `mutationCatch()` / `historyCatch()`:

- `409`: `index.lock` busy, "local changes would be overwritten", branch/worktree
  already exists or already checked out, stash-pop conflict (the stash entry is
  kept), non-fast-forward pull.
- `404`: unknown ref, sha, or branch.
- `502`: other fetch/pull failures, and push failures on remote hosts.
- `400`: anything else.

`//user:pass@` userinfo is removed from git stderr before it's returned, for
every route (`stripUrlCredentials` in `routes/gitWorkingTree.ts`).

## Operations

All read routes take `conversationId` | `projectId` and optional `cwd` as query
parameters. Mutations take the same keys in a JSON body.

### Working tree

| Route | Does |
|---|---|
| `GET /files/working-tree` | Status of the selected tree: branch, detached, HEAD, staged/unstaged files (porcelain), conflicts, remotes (URLs stripped of credentials), upstream ahead/behind, stash count + top entry, the tree switcher list, live agents, and the commit draft state. |
| `POST /files/working-tree/stage` · `/unstage` | `git add -- :(literal)p` · `git restore --staged -- :(literal)p`. One path per call; never `git add .`. |
| `POST /files/working-tree/discard` | `git restore --worktree` for a **tracked** path (falls back to `checkout --` on git < 2.23). Untracked → 400. |
| `POST /files/working-tree/delete` | Unlink an **untracked file**. Tracked or directory → 400. |
| `POST /files/working-tree/commit` | Commit the index with the trimmed message. Hooks run (no `--no-verify`). Returns the short sha, clears the stored draft, and broadcasts an empty `git_commit_draft_updated`. |
| `POST /files/working-tree/push` | Push the current branch to `remote` (default `origin`, else the first remote) or to `all`. Adds `-u` when there's no upstream on that remote. No force push. |

### Commit-message drafts

The draft is stored per tree (`git_commit_drafts`; keyed by cwd, prefixed with
`remote:<hostId>:` for remote hosts) so every tab sees the same text.

| Route | Does |
|---|---|
| `PUT /files/working-tree/commit-message` | Save the draft text (≤ 64 KiB). |
| `POST /files/working-tree/commit-message` | Start generation through the `commit` sidecar LLM route. Needs staged changes and no conflicts. Returns `{ generating: true }` immediately, and the same if generation is already running for the tree. The result arrives as a `git_commit_draft_updated` WS frame. The model sees only `git diff --cached` (or `--stat` when over budget) and recent commit subjects. |
| `POST /files/working-tree/commit-message/cancel` | Cancel a pending generation. A result that arrives later is discarded. |

### Branches and remotes

| Route | Does |
|---|---|
| `GET /files/git-branches` | Local branches (current first) and remote-tracking branches, excluding `*/HEAD`. |
| `POST /files/working-tree/switch-branch` | Local branch → `git switch`. A remote ref like `origin/x`: switch to local `x` if it exists, otherwise `git switch --track`. |
| `POST /files/working-tree/create-branch` | `git switch -c name [baseRef]`. A name whose first segment matches a remote name (e.g. `origin/foo`) is rejected (409), because it would shadow that remote's refs. |
| `POST /files/working-tree/fetch` | `git fetch --all --prune`. No remotes → 400. Returns fresh upstream/ahead/behind. |
| `POST /files/working-tree/pull` | `git pull --ff-only --no-rebase`. Detached HEAD or no upstream → 400. Diverged → 409; rebase or merge in a terminal or through an agent. |
| `POST /files/working-tree/stash` · `/stash-pop` | `git stash push -u [-m msg]` (includes untracked files) · `git stash pop`. Nothing to stash / no entries → 400. |

### Worktrees

`POST /files/working-tree/create-worktree` `{ branch, newBranch?, folder? }` →
`201 { cwd, branch }`.

- The worktree is a **sibling** of the repo's top level. The default folder is
  `<repo>-<sanitised-branch>`. A folder that already exists → 409.
- `newBranch: true` runs `worktree add -b <branch>`; otherwise it checks out
  an existing branch. An `origin/…` name without `newBranch` → 400, and a
  branch already checked out elsewhere → 409.
- Not blocked by live agents, since it doesn't touch the existing checkout.
  New worktrees show up in the tree switcher because they appear in
  `git worktree list`.

### History and diffs (read-only)

| Route | Does |
|---|---|
| `GET /files/git-history` | Paged commit log (`limit`, `skip`, optional `ref`; unknown ref → 404). |
| `GET /files/git-history/commit?sha=` | Commit header, changed files (with renames), numstat totals. |
| `GET /files/git-history/diff?sha=&path=` | One file's diff in that commit (size-capped, `truncated` flag). |
| `GET /files/git-history/file?sha=&path=` | File content at that commit (binary/truncation flags). |
| `GET /files/git-branch-diff?base=&target=` | Files changed on `target` since its merge base with `base` (three-dot semantics). List capped at 2,000 files; stats cover all of them. No common ancestor → 409. |
| `GET /files/git-branch-diff/file?from=&to=&path=` | One file's diff between two shas. |

## Remote hosts

For a project bound to a `tierwyn node` host, `resolveGitRequest()` returns a
`RemoteGitOps`. Each method is one `git.call` RPC
(`{ method, cwd, args }`) over the node link. On the node, `gitCall()`:

- accepts only methods in `GIT_READ_METHODS`, `GIT_MUTATION_METHODS`, and
  `GIT_SHADOW_METHODS` (`packages/shared/src/node.ts`), and enforces a
  per-method arity;
- requires an absolute cwd under the node's policy **roots** that isn't inside
  `.git`;
- re-runs the same validators (`validatePathspec`, `assertBranchName`,
  `assertRef`, `assertSha`, message checks) on the node side, so the hub's
  lexical path check isn't the real boundary;
- jails `fileHeadDiff` / `restoreFileToHead` paths to the roots, and refuses
  secret paths and `.git`;
- for `addOperatorWorktree` / `createSpawnWorktree`, requires the repo's
  **parent** directory to be under the roots (the worktree is a sibling). If it
  isn't → `400`, with a hint to add the parent directory to `roots` in
  `node.json`;
- sets `GIT_TERMINAL_PROMPT=0` (`hardenGitEnv`). Git runs synchronously on the
  node's event loop, so a stalled network push blocks that node until git
  returns.

RPC errors map to HTTP: outside roots / not allowed → 403, host disconnected or
timed out → 503, unknown method → 501 `remote host needs update`.
`create-worktree` also requires the node to advertise the `git.worktree`
feature (`501 node_update_required` otherwise). The working-tree heal step and
`git worktree prune` run only for local projects.

## Gotchas

- **Commit while an agent runs is allowed locally.** The agent may be writing
  files you then stage. Check the live-agent warning in the panel.
- **Switch branch needs a fully clean tree.** Untracked files count, because
  they are listed as unstaged. Stash first; the stash includes untracked files.
- **The live-agent check matches the exact tree.** An agent in a sibling
  worktree doesn't block a branch switch on the root, and the reverse is also
  true.
- **Fetch and push don't check for live agents.** Push only sends committed
  history; fetch only updates remote-tracking refs.
- **The commit-draft WS frame carries only `cwd`.** A local panel open on the
  same path as a remote one will also apply that remote draft
  (`commitDraftKey()` comment).
