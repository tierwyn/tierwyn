# Checkpoints and restore

Operator guide for conversation checkpoints and code restore in Tierwyn.

| | |
|---|---|
| **UI** | Checkpoint list → **Restore…** → choice modal; optional **View Diff** |
| **Code** | `apps/server/src/checkpointService.ts`, `git/shadowCheckpoint.ts`, `routes/conversations.ts` (`…/checkpoints`, `…/rewind`) |
| **Types** | `Checkpoint`, `RewindConversationRequest` in `@tierwyn/shared` |
| **Last reviewed** | Against current server + UI |

This is product behaviour, not an API catalog.

---

## What a checkpoint is

A **checkpoint** is an anchor on a conversation transcript at a specific event (usually a completed user turn), optionally paired with a **shadow git snapshot** of the project tree at that moment.

| Field (concept) | Meaning |
|---|---|
| Anchor event | Transcript position the checkpoint points at |
| Kind | `auto` (created by the system) or `manual` |
| Pinned | Kept more deliberately (e.g. “Before restore”) |
| Code badge / `codeRef` | Shadow commit SHA exists → files can be restored |
| Turn / prompt preview | UI labels for scanning the list |

Code snapshots are stored as **private git refs**, not as normal branch commits:

```text
refs/tierwyn/checkpoints/<conversationId>/<checkpointId>
```

They do **not** move `HEAD` when created. Creating a snapshot uses a temporary index and `commit-tree` so the working tree / branch history stay put.

If the working tree is **identical to HEAD**, no code snapshot is stored (`codeRef` stays empty). The **Code** badge only appears when restore would actually change files.

---

## How checkpoints appear

### Automatic

After a completed user turn, the session path records an **auto** checkpoint (fail-soft: never fails the turn). If the project path is a git repo and the tree differs from HEAD, a shadow code snapshot is attached.

### Manual

The API supports creating/updating a checkpoint on an event (`POST /conversations/:id/checkpoints` with `eventId`, optional `label` / `pinned`). The UI primarily surfaces the **list + restore** flow; auto checkpoints are what most operators see day to day.

### Pre-restore safety

Before some **code-only** restores on a dirty tree, Tierwyn may create a pinned checkpoint labelled **Before restore** so you can recover overwritten uncommitted work from the checkpoint list.

---

## Where code is snapshotted from

CWD for snapshots and restore:

1. Conversation **workdir** if set (isolated worktree), else  
2. Project **root path**

Same path is used for `git` operations.

---

## Using the UI

1. Open the conversation’s **Checkpoints** list (enabled when at least one checkpoint exists).
2. Rows show label/kind, optional **Code** / **Turn** pills, relative time, prompt preview, and +/- stats when a captured diff is available.
3. **View Diff**: shows what the checkpoint captured (vs its parent tree), excluding agent-internal dirs (`.claude`, `.cursor`, …). The viewer separates changes by file with sticky headers, per-file `+`/`−` badges, change status pills, collapsible sections, and file quick-jump chips for multi-file diffs.
4. **Restore…**: opens the restore choice modal (blocked while a turn is running or another restore is in flight).

**Stop the agent first.** A live in-flight session returns **409** (“conversation has a live session”). Parked/idle hold-open processes are reaped so restore can proceed after a finished turn.

---

## Restore modes

When you click **Restore…**, you choose how to apply the checkpoint:

| Mode | Transcript | Project files | When offered |
|---|---|---|---|
| **Conversation only** | Truncates events **after** the checkpoint | Untouched | Always |
| **Code + conversation** (recommended when code exists) | Truncates after checkpoint | Restored to snapshot | When checkpoint has meaningful code changes |
| **Code only** (advanced) | Untouched | Restored to snapshot | Same; leaves chat and code **out of sync** |

### What “conversation rewind” does

- Removes transcript events after the anchor.
- May create a checkpoint as part of the rewind flow (server default unless disabled).
- Attempts to keep native agent sessions aligned where adapters support it; the response may include `nativeDrift` if the native side could not fully match.

### What “code restore” does

Depends on whether the conversation uses an **isolated worktree** or the **shared project root**:

| Context | Git behaviour | Risk |
|---|---|---|
| **Worktree** (`workdirPath` set) | `git reset --hard <codeRef>` then `git clean -fd` | **Destructive** to uncommitted worktree changes (UI warns) |
| **Shared root** | `git restore --source <codeRef> --staged --worktree -- .` | Overwrites tracked paths from the snapshot; **does not move HEAD**; UI asks explicit confirmation |

Shared-root restore requires **`confirmSharedCode`** (the UI sends this when the project root is shared). Without confirmation, code restore is skipped with reason `shared_tree`.

---

## Code restore skip reasons

The UI maps server reasons to readable messages:

| Reason | Meaning |
|---|---|
| `shared_tree` | Shared root rewrite needs explicit confirmation |
| `diverged` | A git operation failed; files may be unchanged (or conversation already rewound in both-mode) |
| `no_ref` | Checkpoint has no code snapshot |
| `not_git` | Project path is not a git repository |

On **both** mode (conversation + code), the server **gates code restore before truncating** the transcript when possible, so a failed gate leaves neither side half-applied. If conversation rewind succeeds and code restore fails afterward, you may get conversation rewound with `codeApplied: false` and a skip reason.

---

## Diff views

| Mode | Meaning |
|---|---|
| `captured` (list / View Diff) | Checkpoint tree vs its parent; what was stored at capture time |
| `restore` (default API) | Working tree vs checkpoint; what restore would change (includes untracked that `clean` would remove) |

Agent-internal directories are excluded from displayed diffs so agent bookkeeping does not drown project changes.

---

## Operator caveats

1. **Git required for code restore**: Non-git project roots still get conversation checkpoints; no file restore.
2. **Worktree reset is harsh**: `reset --hard` + `clean -fd` discards uncommitted worktree state (except where a Before restore snapshot was taken for code-only).
3. **Shared root is multi-conversation**: Restoring code rewrites files every conversation on that project sees; confirm carefully.
4. **Code-only desync**: Chat history will describe work that no longer matches the tree (or vice versa).
5. **Prod live tree**: Prefer worktrees for experimental agent work; treat shared-root restore as an operator action, not a casual undo.
6. **Shadow refs**: Checkpoints live under `refs/tierwyn/…`; they are not a substitute for real branches/PRs. Deleting a checkpoint drops its shadow ref when possible.
7. **Single operator**: Design assumes one operator; concurrent humans on the same shared root are not a first-class safety model.

---

## Related features

| Feature | Difference |
|---|---|
| **Compaction / handoff** | Summarise or pass transcript for a *new* session context; not a tree restore |
| **Fork conversation** | Branches the chat; does not restore files by itself |
| **Excise turn** | Surgical remove of one turn (+ native session rewrite on capable adapters); not full rewind to a checkpoint |
| **Drafts** | Unsent prompt text only |

---

## Maintenance

When restore behaviour changes, update this file and the one-line row in [docs/capabilities.md](../capabilities.md). Prefer verifying against `shadowCheckpoint.ts` and `RestoreChoiceModal.tsx`.
