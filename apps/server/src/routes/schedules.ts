import type { Express, Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import type {
  CreateScheduleJobRequest, PatchScheduleJobRequest, ScheduleJob, ScheduleJobDetail,
  ScheduleRun, Conversation, UpcomingFiresResponse, StepStatus, Workdir, Project,
  SchedulePack, SchedulePackFile, GeneralSettings, RemoteHostView,
} from '@tierwyn/shared';
import {
  jobNameToSlug, agentSupportsPermissionMode, interactionModeRequiresPermissionCapable,
  parseScheduleVariables, checkPipelineRoles, fillStageRoles, monotonicChildSandbox,
} from '@tierwyn/shared';
import {
  computeNextFireAt, computeUpcoming, parseIntervalExpr, parseOnceExpr,
  ONCE_EXHAUSTED_MS,
  type ScheduleKind,
} from '../schedules/nextFire.js';
import {
  getActiveOperatorSkipSet,
  isOnceExhaustedJob,
  listRestorableOperatorSkips,
  markOperatorSkipUndone,
  recomputeNextFireAfterSkipChange,
  recordOperatorSkipThis,
  recordOperatorSkipsThrough,
  type OperatorSkipMode,
} from '../schedules/operatorSkip.js';
import {
  createJob, getJob, listJobsForProject, updateJob, setJobEnabled, setNextFireAt,
  archiveJob, unarchiveJob, hardDeleteJob,
  listSteps, listRunsForJob, linkHomeConversation, replaceSteps, getActiveRunForJob,
  updateStepStatus, updateRun, createRun, setPendingContext, PENDING_CONTEXT_MAX_BYTES,
  patchStep, retryStep, completeAllSteps, deleteRun, clearJobErrors,
  countAgentJobsForConversation, countAgentJobsForProject,
  type StepWrite, type PendingContextSource, type StepPatch,
} from '../repositories/schedules.js';
import { getProject, listProjects } from '../repositories/projects.js';
import { getPack } from '../repositories/schedulePacks.js';
import {
  substitutePackTokens, PackFileConflict, PackFilePathError,
} from '../schedules/packFiles.js';
import {
  materialisePackFilesFor, PackHostError, type PackFilesNodeHub,
} from '../schedules/remotePackFiles.js';
import {
  validateScheduleTarget,
  validateScheduleTargetPatch,
  validateBoundConversationForResume,
} from '../schedules/target.js';
import {
  createScheduleHomeConversation, getConversation, listDescendants, isDescendedFrom,
} from '../repositories/conversations.js';
import { lastSessionForConversation } from '../repositories/sessions.js';
import { unlinkTtsWavPaths } from '../repositories/ttsRecordings.js';
import { createAdapterFor } from '../node/proxyAdapter.js';
import { catalogue } from '../catalogue.js';
import { validateRunToken } from '../schedules/runTokens.js';
import { peekSpawnToken } from '../spawn/tokens.js';
import { getTemplate, listTemplates, getCompactionSettings, getGeneralSettings } from '../repositories/settings.js';
import { resolveSandboxFor } from '../repositories/sandboxSettings.js';
import { getRemoteHost } from '../repositories/remoteHosts.js';
import { sandboxCapability } from '../sandbox/capability.js';
import { liveAgentStatusForSession } from '../liveStatus.js';
import { effectiveInteractionMode } from '../sessionManager.js';

export function decideAgentEnabled(input: {
  scheduleKind: 'once' | 'interval';
  general: Pick<GeneralSettings, 'allowAgentRecurringSchedules'> & Partial<Pick<GeneralSettings, 'allowAgentAutoScheduling'>>;
  spawnApprovalRequired: boolean; // global CompactionSettings OR template.spawnApprovalRequired
  /** Creating conversation runs under a stricter permission mode than the global one
   *  that tick conversations inherit — self-starting would escape it. */
  creatorModeStricter?: boolean;
}): boolean {
  // Master gate: off → every agent-created job lands disabled, whatever its kind.
  if (input.general.allowAgentAutoScheduling === false) return false;
  if (input.spawnApprovalRequired) return false;
  if (input.creatorModeStricter) return false;
  if (input.scheduleKind === 'once') return true;
  return input.general.allowAgentRecurringSchedules === true;
}

/** Agent create caps (non-archived). */
const AGENT_JOB_CAP_CONVERSATION = 50;
const AGENT_JOB_CAP_PROJECT = 50;

/** Test seam: awaited after pack materialise, immediately before the cap re-check + createJob. */
export const agentCreateBeforeInsert = { wait: async (): Promise<void> => {} };
const AGENT_FIRE_IN_MS_MIN = 60_000;
const AGENT_FIRE_IN_MS_MAX = 7 * 86_400_000;
const AGENT_MAX_HORIZON_MS = AGENT_FIRE_IN_MS_MAX; // 7 days on resolved atMs
const AGENT_MIN_INTERVAL_MS = 5 * 60_000; // 5 minutes — intervals always created disabled
const AGENT_NAME_MAX = 120;
const AGENT_PROMPT_MAX_BYTES = 8192; // keep in sync with PACK_PROMPT_MAX_BYTES in @tierwyn/shared packs.ts
const AGENT_ROLE_MAX = 120;
const AGENT_STEPS_MAX = 5; // keep in sync with PACK_STEPS_MAX in @tierwyn/shared packs.ts

/** Subset of JobScheduler's public surface this route module depends on —
 *  kept narrow so tests can pass a stub without constructing a real scheduler. */
export interface JobSchedulerLike {
  runNow(jobId: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
}

/** Optional run detail on schedule_updated (lifecycle / mid-run). Call sites may use 2-arg form. */
type ScheduleBroadcast = (
  projectId: string,
  jobId: string,
  detail?: {
    runId?: string;
    runStatus?: import('@tierwyn/shared').RunStatus;
    conversationId?: string;
    agentStatus?: import('@tierwyn/shared').AgentStatus;
  },
) => void;

export interface ScheduleRouteDeps {
  getDb: () => Database;
  jobScheduler?: JobSchedulerLike;
  broadcast: ScheduleBroadcast;
  /** Optional — used to reap parked sessions before hard-deleting run conversations. */
  sessionManager?: {
    activeSessionForConversation(id: string): { lastStatus?: import('@tierwyn/shared').AgentStatus } | undefined;
    inFlightSessionForConversation(id: string): unknown;
    reapParkedSessions(id: string, opts?: { all?: boolean }): Promise<void>;
  };
  /** Live remote-host view for create/PATCH availability (H2). */
  remoteHostView?: (id: string) => RemoteHostView | undefined;
  /** Hub→node link for remote pack-file materialisation (H1/D4). */
  nodeHub?: PackFilesNodeHub;
}

type Deps = ScheduleRouteDeps & { jobScheduler: JobSchedulerLike };

export type ScheduleOpFailure = { ok: false; status: 400 | 404 | 409 | 500; error: string };
export type ScheduleDeleteOutcome = { ok: true; deletedConversationIds: string[] } | ScheduleOpFailure;
export type ScheduleJobOutcome = { ok: true; job: ScheduleJobDetail } | ScheduleOpFailure;

/** Dual-auth deps for agent-facing step routes (mounted pre-requireAuth). */
interface AgentDeps {
  getDb: () => Database;
  isAuthed: (req: Request) => boolean;
  broadcast: ScheduleBroadcast;
  /** Live remote-host view for agent create availability (H2). */
  remoteHostView?: (id: string) => RemoteHostView | undefined;
  /** Hub→node link for remote pack-file materialisation (H1/D4). */
  nodeHub?: PackFilesNodeHub;
}

const FORBIDDEN_STEP_KEYS = [
  'scheduleExpr', 'timezone', 'profileId', 'overlapPolicy',
  'enabled', 'executionMode', 'cron', 'workdir', 'variables',
] as const;

const VALID_STEP_STATUSES = new Set<StepStatus>([
  'pending', 'ready', 'running', 'done', 'blocked', 'skipped',
]);

type AuthOk = { ok: true; via: 'cookie' | 'run' | 'spawn' };
type AuthFail = { ok: false; status: number; error: string };

/** Cookie, run-scoped token for this jobId, or spawn token under the job home tree. */
export function authorizeScheduleSteps(
  req: Request,
  jobId: string,
  deps: AgentDeps,
): AuthOk | AuthFail {
  if (deps.isAuthed(req)) return { ok: true, via: 'cookie' };

  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  const run = validateRunToken(bearer, jobId);
  if (run.ok) return { ok: true, via: 'run' };

  const db = deps.getDb();
  const job = getJob(db, jobId);
  if (!job) return { ok: false, status: 404, error: 'no such schedule job' };

  const entry = peekSpawnToken(bearer);
  if (entry && entry.scope.has('schedule') && isConversationUnderJobHome(db, entry.conversationId, job)) {
    return { ok: true, via: 'spawn' };
  }

  return { ok: false, status: 401, error: 'schedule step API requires run token, spawn token, or operator session' };
}

type AgentCreateAuthOk = {
  ok: true;
  via: 'cookie' | 'spawn';
  /** Present only for spawn-token path (D5 — derived from token, never client header). */
  conversationId?: string;
};
type AgentCreateAuthFail = { ok: false; status: number; error: string };

/**
 * Dual-auth for POST /projects/:projectId/schedules/agent.
 * Conversation is always derived from the spawn/schedule token (D5) — X-Agent-Conversation-Id is ignored.
 * Cookie path is operator-trusted. Token path is depth-agnostic: project match + caps are the boundary.
 * Both 'spawn' and 'schedule' scopes may create (asymmetric 2B — schedule ↛ spawn is enforced at validateSpawnToken).
 */
export function authorizeAgentScheduleCreate(
  req: Request,
  projectId: string,
  deps: AgentDeps,
): AgentCreateAuthOk | AgentCreateAuthFail {
  if (deps.isAuthed(req)) {
    return { ok: true, via: 'cookie', conversationId: undefined };
  }

  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const entry = peekSpawnToken(bearer);
  if (!entry || !entry.scope.has('schedule')) {
    return { ok: false, status: 401, error: 'schedule agent create requires schedule/spawn token or operator session' };
  }

  const db = deps.getDb();
  const conv = getConversation(db, entry.conversationId);
  if (!conv) {
    return { ok: false, status: 401, error: 'schedule agent create requires schedule/spawn token or operator session' };
  }
  if (conv.projectId !== projectId) {
    return { ok: false, status: 403, error: 'wrong_project' };
  }
  return { ok: true, via: 'spawn', conversationId: conv.id };
}

// R6 removed the only caller of the old scheduleApprovalRequired() helper (template → global
// mirror of spawn.ts approvalRequired): agent-created jobs are now unconditionally
// enabled:false, so the approval flag no longer changes the create outcome. Deleted rather
// than left dead — git history has it if the branch is ever needed back.

function isLoopback(req: Request): boolean {
  // D3 — raw peer only; never trust req.ip / X-Forwarded-For.
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Self-contained help docs for agents (D7). No secrets. */
export const SCHEDULE_HELP_MD = `# Agent schedule creation

## Purpose

Mint a job **only if the operator asked to schedule** (delay, recur, or verify later).
Default is do not create. A test, a question, or "do this now" is not a schedule request.
Prefer **spawn** for immediate work when the preamble includes spawn; do not schedule as a
substitute for spawn. Do not GET this document unless you are about to create.

If creating: **one-shot** (\`once\`, 1 minute–7 days) or **interval** (\`everyMs\` ≥ 5 minutes)
in **this project**. **One-shot jobs are created enabled** and fire automatically, unless safe
mode (spawn approval) is required. **Interval jobs start disabled by default** unless the operator
has explicitly enabled recurring schedules in settings (\`allowAgentRecurringSchedules\`).
If the operator has turned off agent auto-scheduling (\`allowAgentAutoScheduling: false\`),
**every** job you create starts disabled until the operator enables it.

## ⚠ Set \`templateName\` (and use a spawn-capable profile) if the tick must spawn its own children

A scheduled tick can only delegate (POST \`/spawn\`, \`/spawn/raw\`) when **both** of these hold at
tick fire time:

1. **The job has a \`templateName\`.** The dispatcher propagates \`job.templateName\` to the tick
   conversation (\`dispatch.ts\`), and the delegation preamble (roster + spawn token) is only
   injected when a template is present (\`sessionManager.ts\` preamble-gate).
2. **The job's \`profileId\` has a positive spawn cap** (\`max_concurrent_spawns > 0\`).
   \`preamble-gate.ts\` checks the profile cap and withholds the preamble even if a template is
   set. Most profiles are seeded with \`max_concurrent_spawns = NULL\` (treated as 0), so assume a
   profile **cannot** spawn until you have confirmed otherwise — \`?resolve=\` reports the cap for
   any profile it matches.

A tick missing either condition:

- gets no spawn roster in its prompt, and **no spawn token** bound to its conversation
- every \`/spawn/raw\` returns \`401 spawn requires a valid token or operator session\`
- the schedule **run token** (footer) is no help — it is scoped to \`/schedules/.../steps\` +
  \`/complete-job\` only and is not honoured by \`/spawn/raw\`

So: **if the tick needs to spawn, always set \`templateName\` AND pick a profile with
\`max_concurrent_spawns > 0\`.** If the operator did not specify a template, pick an existing one
from settings before creating the job. The dispatcher does not fall back to a default template.

### Discovering valid \`templateName\` values

Both \`templateName\` and \`profileId\` must match a stored string **exactly**, and the operator's
phrasing usually is not that string. Resolve it — do not guess, and do not read the database:

\`\`\`bash
curl -s 'http://127.0.0.1:<port>/agent/schedule-help?resolve=<name-fragment>'
\`\`\`

Pass a distinctive fragment of the name you were given (a vendor or model word works better than
the operator's full phrasing). The reply appends a **Resolve** section listing any matching
template names and profile ids, with each profile's spawn capability. It is a lookup, not a
listing: there is no way to enumerate the whole catalogue, and matches are capped.

If nothing resolves, **ask the operator for the exact name.** Never substitute a name you
invented — a plausible-looking wrong one produces a job that runs as the wrong model.

## Auth

\`POST /projects/:projectId/schedules/agent\`
\`Authorization: Bearer <token>\`

\`projectId\` and the bearer come from the conversation's **preamble**. There are two token kinds:

- **Spawn-scoped** — issued to spawn-capable conversations (those with a \`templateName\` and a profile whose \`max_concurrent_spawns > 0\`). This token is the **same one used by \`POST /spawn\`** and is the only token such conversations carry.
- **Schedule-scoped** — issued to **every other** conversation (no template, or spawn cap 0), including top-level chats and depth>0 children. This token **can only create schedules** — it is rejected by \`POST /spawn\`/\`POST /spawn/raw\` (\`401\`). If your preamble says "this token schedules only — it cannot spawn agents," you hold this kind.

Either token works at \`POST /projects/:id/schedules/agent\` for **its own project**. Do **not** send \`X-Agent-Conversation-Id\` — the server derives the conversation from the token.

## Create URL

\`POST http://127.0.0.1:<port>/projects/<projectId>/schedules/agent\`

## Field allowlist

| Field | Rule |
|---|---|
| \`name\` | required, trimmed, ≤ 120 chars |
| \`promptTemplate\` | required (or provided by pack), ≤ 8192 bytes |
| \`packSlug\` | optional string; applies a shipped/imported pack recipe (cadence, template, files, variables) |
| \`packVars\` | optional flat string map; values for pack apply tokens \`[[<key>]]\` and pipeline configuration |
| \`goal\` | optional string; high-level run objective, set as pending context and substituted as \`[[goal]]\` |
| \`fireInMs\` | optional int, 60000 … 604800000 (1 min–7 days); → one-shot at now+fireInMs |
| \`fireAtMs\` | optional int, absolute UTC ms; one-shot within 7 days (\`now < atMs ≤ now+7d\`) |
| \`scheduleKind\` | optional; if set must match the resolved kind from fireIn/fireAt/expr/pack (cron → rejected) |
| \`scheduleExpr\` | interval JSON (\`everyMs\` ≥ 300000 = 5 min) **or** once JSON (\`{"atMs":N}\` in-horizon); shape decides kind when fireIn/fireAt omitted. Interval jobs start enabled only if operator allows recurring agent schedules. |
| \`profileId\` | optional; defaults to **this conversation's last session profile**. ⚠ A tick created from a **parent** conversation inherits the **parent's** profile — which may not be the model you want driving the tick's job. **Set \`profileId\` explicitly** if the tick needs a specific model. |
| \`role\` | optional string, ≤ 120 chars |
| \`steer\` | optional, ≤ 8 KiB |
| \`steps\` | optional, ≤ 5 items \`{title, body}\` |
| \`agentMayComplete\` | default true; **forced true** for all \`once\` paths |
| \`templateName\` | optional; must exist in settings. For pack apply with bearer, pinned to creating conversation's template. |
| \`workdir\` | \`'shared'\` or \`'worktree'\`, default \`shared\` |
| \`pendingContext\` | optional note for first tick (enables carry-forward) |
| \`variables\` | optional flat string map, ≤ 32 keys, ≤ 2 KiB per value, ≤ 8 KiB total; read as \`{{vars.<key>}}\` in \`promptTemplate\`/\`steer\` on every fire and editable by the operator afterwards |

Exactly one of \`fireInMs\` / \`fireAtMs\` / \`scheduleExpr\` (or \`packSlug\`) is required. Client \`enabled\` is ignored.

**Prefer variables over hardcoded knobs** in \`promptTemplate\` / \`steer\` (model ids, caps, branch names). The operator can retune them later without rewriting the template. **Never put secrets in variables** — they are stored in plaintext SQLite and rendered into tick transcripts. Use the plugin vault for credentials.

**Prefer \`fireInMs\` for relative delays (the common case) — no wall-clock / timezone / epoch-ms pitfalls. Use \`fireAtMs\` only for an absolute deadline.**

## Caps

An **agent job** is a **schedule** (a \`schedule_jobs\` row) minted via this create path
(\`created_by = agent\`). It is **not** a tick conversation, spawn child, or run.

| Cap | Limit | Counts |
|---|---|---|
| Per **creating conversation** | **50** | Non-archived agent schedules whose \`created_by_conversation_id\` is the chat that held the bearer token |
| Per **project** | **50** | Non-archived agent schedules in that project (\`created_by = agent\`) |

- **Creating conversation** = the chat that POSTed create — **not** the schedule home folder and **not** a ⏱ tick under that home.
- **Active** here means \`archived = 0\` (disabled / exhausted jobs still count until archived).
- Operator **Archive** (Schedules sidebar icon, or the Schedule browser **Archive** button, or auto-archive via \`complete-job\`) hides the job from lists, disables it, and **frees the slot**. History stays. Permanent **Delete** (sidebar trash, or Schedule browser) removes the job and its run conversations.
- Operator-created schedules do **not** share the project 50.
- No cron on this path.
- Interval \`everyMs\` floor is **5 minutes** (\`300000\`).

On overflow the API returns \`429\` with \`error: "conversation_cap"\` or \`"project_cap"\`.

## Approval gate / operator enable

- **One-shot jobs (\`once\`)** are created with \`enabled: true\` and response \`status: "active"\`, firing automatically at their scheduled time.
- **Recurring interval jobs** are created with \`enabled: false\` and \`status: "pending_operator_enable"\` by default, unless the operator has enabled \`allowAgentRecurringSchedules\` in Settings → Schedules.
- **Auto-scheduling gate:** If the operator has turned off \`allowAgentAutoScheduling\` in Settings → Schedules, ALL agent-created jobs land disabled (\`status: "pending_operator_enable"\`) regardless of kind.
- **Safe mode override:** If global compaction settings or the template requires spawn approval (\`spawnApprovalRequired: true\`), ALL agent-created jobs land disabled (\`status: "pending_operator_enable"\`) regardless of kind.

## One-shot example (\`fireInMs\`)

\`\`\`bash
curl -s -X POST http://127.0.0.1:8787/projects/PROJECT_ID/schedules/agent \\
  -H 'Authorization: Bearer SPAWN_TOKEN' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "name": "Verify after deploy",
    "fireInMs": 2400000,
    "promptTemplate": "Re-run the verification tests and report pass/fail. If green, complete-job."
  }'
\`\`\`

## Agent pack apply example (\`packSlug\`)

\`\`\`bash
curl -s -X POST http://127.0.0.1:8787/projects/PROJECT_ID/schedules/agent \\
  -H 'Authorization: Bearer SPAWN_TOKEN' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "name": "Feature wave",
    "packSlug": "feature-wave",
    "packVars": { "mode": "closed", "commitOnTick": "true" },
    "goal": "Implement Phase 3 routes"
  }'
\`\`\`

When applying a pack:
- \`templateName\` is pinned to the creating conversation's template.
- Pack files are materialised under \`.tierwyn/schedule/\` at apply time.
- Pipeline stage roles are validated against the template roster; optional missing roles are skipped and listed in \`warnings\`.
- \`goal\` is stored as pending context and substituted as \`[[goal]]\`.

## Completing a one-shot

Your **tick prompt footer already contains** the ready-to-POST complete-job URL (with your job id baked in) **and** your run token — you do **not** need to remember the job id. Just POST the URL from your footer with the run token from your footer.

When auto-archive is active (default \`autoArchiveCompletedOneShots: true\`), calling \`complete-job\` on a one-shot job immediately archives it (\`archived: true\`), freeing the agent quota slot automatically.

**Fallback:** if your footer has **no** complete-job line (job not agent-created, \`agentMayComplete\` false, or the preamble was truncated), you cannot auto-retire — **tell the operator to disable the job manually in the Schedule browser.**

## Help endpoint

\`GET /agent/schedule-help\` — loopback only (this document). No auth on loopback.
`;

interface ParsedAgentCreate {
  name: string;
  promptTemplate: string;
  scheduleKind: 'interval' | 'once';
  scheduleExpr: string;
  profileId?: string;
  role?: string;
  steer?: string;
  steps?: StepWrite[];
  agentMayComplete: boolean;
  templateName?: string;
  workdir: Workdir;
  pendingContext?: string;
  carryContextEnabled: boolean;
  variables?: Record<string, string>;
}

function parseAgentCreate(
  body: unknown,
): { ok: true; req: ParsedAgentCreate } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;

  // name
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    return { ok: false, status: 400, error: 'name required' };
  }
  const name = obj.name.trim();
  if (name.length > AGENT_NAME_MAX) {
    return { ok: false, status: 400, error: `name must be ≤ ${AGENT_NAME_MAX} chars` };
  }

  // promptTemplate
  if (typeof obj.promptTemplate !== 'string' || !obj.promptTemplate.trim()) {
    return { ok: false, status: 400, error: 'promptTemplate required' };
  }
  const promptTemplate = obj.promptTemplate;
  if (Buffer.byteLength(promptTemplate, 'utf8') > AGENT_PROMPT_MAX_BYTES) {
    return { ok: false, status: 400, error: `promptTemplate must be ≤ ${AGENT_PROMPT_MAX_BYTES} bytes` };
  }

  // scheduleKind hard reject for cron; allow interval | once
  if (obj.scheduleKind !== undefined && obj.scheduleKind !== null) {
    if (obj.scheduleKind === 'cron') {
      return { ok: false, status: 400, error: 'cron_not_allowed' };
    }
    if (obj.scheduleKind !== 'interval' && obj.scheduleKind !== 'once') {
      return { ok: false, status: 400, error: 'scheduleKind must be interval or once' };
    }
  }

  const hasFireIn = obj.fireInMs !== undefined && obj.fireInMs !== null;
  const hasFireAt = obj.fireAtMs !== undefined && obj.fireAtMs !== null;
  const hasExpr = typeof obj.scheduleExpr === 'string' && obj.scheduleExpr.trim().length > 0;
  const sourceCount = (hasFireIn ? 1 : 0) + (hasFireAt ? 1 : 0) + (hasExpr ? 1 : 0);

  if (sourceCount === 0) {
    return { ok: false, status: 400, error: 'fireInMs, fireAtMs, or scheduleExpr required' };
  }
  if (sourceCount > 1) {
    return { ok: false, status: 400, error: 'fireInMs, fireAtMs, and scheduleExpr are mutually exclusive' };
  }

  let scheduleKind: 'interval' | 'once';
  let scheduleExpr: string;
  let agentMayComplete = obj.agentMayComplete === false ? false : true;
  const now = Date.now();

  if (hasFireIn) {
    if (typeof obj.fireInMs !== 'number' || !Number.isFinite(obj.fireInMs) || !Number.isInteger(obj.fireInMs)) {
      return { ok: false, status: 400, error: 'fireInMs must be an integer' };
    }
    if (obj.fireInMs < AGENT_FIRE_IN_MS_MIN || obj.fireInMs > AGENT_FIRE_IN_MS_MAX) {
      return {
        ok: false,
        status: 400,
        error: `fireInMs must be between ${AGENT_FIRE_IN_MS_MIN} and ${AGENT_FIRE_IN_MS_MAX}`,
      };
    }
    const atMs = now + obj.fireInMs;
    scheduleKind = 'once';
    scheduleExpr = JSON.stringify({ atMs });
    agentMayComplete = true; // forced for once
  } else if (hasFireAt) {
    if (typeof obj.fireAtMs !== 'number' || !Number.isFinite(obj.fireAtMs) || !Number.isInteger(obj.fireAtMs)) {
      return { ok: false, status: 400, error: 'fireAtMs must be an integer' };
    }
    const atMs = obj.fireAtMs;
    if (!(now < atMs && atMs <= now + AGENT_MAX_HORIZON_MS)) {
      return { ok: false, status: 400, error: 'fireAtMs must be in the future within 7 days' };
    }
    scheduleKind = 'once';
    scheduleExpr = JSON.stringify({ atMs });
    agentMayComplete = true; // forced for once
  } else {
    const raw = String(obj.scheduleExpr).trim();
    try {
      const parsed = parseIntervalExpr(raw);
      if (parsed.everyMs < AGENT_MIN_INTERVAL_MS) {
        return { ok: false, status: 400, error: `scheduleExpr everyMs must be ≥ ${AGENT_MIN_INTERVAL_MS}` };
      }
      scheduleKind = 'interval';
      scheduleExpr = raw;
    } catch {
      try {
        const { atMs } = parseOnceExpr(raw);
        if (!(now < atMs && atMs <= now + AGENT_MAX_HORIZON_MS)) {
          return { ok: false, status: 400, error: 'fireAtMs must be in the future within 7 days' };
        }
        scheduleKind = 'once';
        scheduleExpr = raw;
        agentMayComplete = true; // forced for once
      } catch {
        return {
          ok: false,
          status: 400,
          error: 'scheduleExpr must be interval {everyMs} or once {atMs}',
        };
      }
    }
  }

  // F3 — if client declares scheduleKind, it must match the resolved kind (shape wins otherwise).
  if (
    obj.scheduleKind !== undefined &&
    obj.scheduleKind !== null &&
    obj.scheduleKind !== scheduleKind
  ) {
    return {
      ok: false,
      status: 400,
      error: `scheduleKind '${String(obj.scheduleKind)}' does not match scheduleExpr (resolved as '${scheduleKind}')`,
    };
  }

  let profileId: string | undefined;
  if (obj.profileId !== undefined && obj.profileId !== null && obj.profileId !== '') {
    if (typeof obj.profileId !== 'string') {
      return { ok: false, status: 400, error: 'profileId must be a string' };
    }
    profileId = obj.profileId.trim();
  }

  let role: string | undefined;
  if (obj.role !== undefined && obj.role !== null && obj.role !== '') {
    if (typeof obj.role !== 'string') {
      return { ok: false, status: 400, error: 'role must be a string' };
    }
    role = obj.role.trim();
    if (role.length > AGENT_ROLE_MAX) {
      return { ok: false, status: 400, error: `role must be ≤ ${AGENT_ROLE_MAX} chars` };
    }
  }

  let steer: string | undefined;
  if (obj.steer !== undefined && obj.steer !== null && obj.steer !== '') {
    if (typeof obj.steer !== 'string') {
      return { ok: false, status: 400, error: 'steer must be a string' };
    }
    if (Buffer.byteLength(obj.steer, 'utf8') > PENDING_CONTEXT_MAX_BYTES) {
      return { ok: false, status: 400, error: 'steer_too_large' };
    }
    steer = obj.steer;
  }

  let steps: StepWrite[] | undefined;
  if (obj.steps !== undefined && obj.steps !== null) {
    if (!Array.isArray(obj.steps)) {
      return { ok: false, status: 400, error: 'steps must be an array' };
    }
    if (obj.steps.length > AGENT_STEPS_MAX) {
      return { ok: false, status: 400, error: `steps must have ≤ ${AGENT_STEPS_MAX} items` };
    }
    steps = [];
    for (let i = 0; i < obj.steps.length; i++) {
      const s = obj.steps[i] as Record<string, unknown>;
      if (!s || typeof s !== 'object') {
        return { ok: false, status: 400, error: `steps[${i}] must be an object` };
      }
      if (typeof s.title !== 'string' || !s.title.trim()) {
        return { ok: false, status: 400, error: `steps[${i}].title required` };
      }
      if (typeof s.body !== 'string') {
        return { ok: false, status: 400, error: `steps[${i}].body must be a string` };
      }
      const step: StepWrite = { title: s.title.trim(), body: s.body };
      if (typeof s.dependsOnOrdinal === 'number' && Number.isInteger(s.dependsOnOrdinal)) {
        step.dependsOnOrdinal = s.dependsOnOrdinal;
      }
      steps.push(step);
    }
  }

  let templateName: string | undefined;
  if (obj.templateName !== undefined && obj.templateName !== null && obj.templateName !== '') {
    if (typeof obj.templateName !== 'string') {
      return { ok: false, status: 400, error: 'templateName must be a string' };
    }
    templateName = obj.templateName.trim();
  }

  let workdir: Workdir = 'shared';
  if (obj.workdir !== undefined && obj.workdir !== null) {
    if (obj.workdir !== 'shared' && obj.workdir !== 'worktree') {
      return { ok: false, status: 400, error: 'workdir must be shared or worktree' };
    }
    workdir = obj.workdir;
  }

  let pendingContext: string | undefined;
  let carryContextEnabled = false;
  if (obj.pendingContext !== undefined && obj.pendingContext !== null && obj.pendingContext !== '') {
    if (typeof obj.pendingContext !== 'string') {
      return { ok: false, status: 400, error: 'pendingContext must be a string' };
    }
    if (Buffer.byteLength(obj.pendingContext, 'utf8') > PENDING_CONTEXT_MAX_BYTES) {
      return { ok: false, status: 400, error: 'pending_context_too_large' };
    }
    pendingContext = obj.pendingContext;
    carryContextEnabled = true;
  }

  let variables: Record<string, string> | undefined;
  if (Object.prototype.hasOwnProperty.call(obj, 'variables')) {
    const parsedVars = parseScheduleVariables(obj.variables);
    if (!parsedVars.ok) {
      return { ok: false, status: 400, error: parsedVars.error };
    }
    variables = parsedVars.value;
  }

  return {
    ok: true,
    req: {
      name,
      promptTemplate,
      scheduleKind,
      scheduleExpr,
      profileId,
      role,
      steer,
      steps,
      agentMayComplete,
      templateName,
      workdir,
      pendingContext,
      carryContextEnabled,
      variables,
    },
  };
}

function isConversationUnderJobHome(db: Database, conversationId: string, job: ScheduleJob): boolean {
  if (conversationId === job.homeConversationId) return true;
  return isDescendedFrom(db, conversationId, job.homeConversationId);
}

function parseStepWrites(body: unknown): { ok: true; steps: StepWrite[] } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;
  for (const key of FORBIDDEN_STEP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return { ok: false, status: 403, error: `forbidden field: ${key}` };
    }
  }
  if (!Array.isArray(obj.steps)) {
    return { ok: false, status: 400, error: 'steps array required' };
  }

  const raw = obj.steps as Array<Record<string, unknown>>;
  const idToOrdinal = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const id = raw[i]?.id;
    if (typeof id === 'string' && id) idToOrdinal.set(id, i);
  }

  const steps: StepWrite[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== 'object') {
      return { ok: false, status: 400, error: `steps[${i}] must be an object` };
    }
    const title = s.title;
    const bodyText = s.body;
    if (typeof title !== 'string' || !title.trim()) {
      return { ok: false, status: 400, error: `steps[${i}].title required` };
    }
    if (typeof bodyText !== 'string') {
      return { ok: false, status: 400, error: `steps[${i}].body must be a string` };
    }

    let dependsOnOrdinal: number | undefined;
    if (typeof s.dependsOnOrdinal === 'number' && Number.isInteger(s.dependsOnOrdinal)) {
      dependsOnOrdinal = s.dependsOnOrdinal;
    } else if (typeof s.dependsOnStepId === 'string' && s.dependsOnStepId) {
      const ord = idToOrdinal.get(s.dependsOnStepId);
      if (ord !== undefined) dependsOnOrdinal = ord;
    }

    let status: StepStatus | undefined;
    if (s.status !== undefined) {
      if (typeof s.status !== 'string' || !VALID_STEP_STATUSES.has(s.status as StepStatus)) {
        return { ok: false, status: 400, error: `steps[${i}].status invalid` };
      }
      status = s.status as StepStatus;
    }

    steps.push({
      title: title.trim(),
      body: bodyText,
      ...(dependsOnOrdinal !== undefined ? { dependsOnOrdinal } : {}),
      ...(status !== undefined ? { status } : {}),
    });
  }
  return { ok: true, steps };
}

function parseStepPatch(body: unknown): { ok: true; patch: StepPatch } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;
  for (const key of FORBIDDEN_STEP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return { ok: false, status: 403, error: `forbidden field: ${key}` };
    }
  }

  const patch: StepPatch = {};
  if (obj.status !== undefined) {
    if (typeof obj.status !== 'string' || !VALID_STEP_STATUSES.has(obj.status as StepStatus)) {
      return { ok: false, status: 400, error: 'status invalid' };
    }
    patch.status = obj.status as StepStatus;
  }
  if (obj.title !== undefined) {
    if (typeof obj.title !== 'string' || !obj.title.trim()) {
      return { ok: false, status: 400, error: 'title must be a non-empty string' };
    }
    patch.title = obj.title.trim();
  }
  if (obj.body !== undefined) {
    if (typeof obj.body !== 'string') {
      return { ok: false, status: 400, error: 'body must be a string' };
    }
    patch.body = obj.body;
  }

  if (patch.status === undefined && patch.title === undefined && patch.body === undefined) {
    return { ok: false, status: 400, error: 'at least one of status, title, body required' };
  }
  return { ok: true, patch };
}

/**
 * Agent-facing step API — dual auth (cookie | run token | spawn under home).
 * Mount BEFORE requireAuth (same pattern as /spawn).
 * Also mounts agent schedule create + loopback help (pre-requireAuth).
 */
export function registerScheduleAgentRoutes(app: Express, deps: AgentDeps): void {
  const { getDb, broadcast } = deps;

  // ── Loopback-only help. Static markdown stays unauthenticated so the
  //    preamble's "GET /agent/schedule-help" flow works. `?resolve=` discloses
  //    catalogue names and requires a live spawn/schedule token.
  app.get('/agent/schedule-help', (req, res) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: 'loopback only' });
      return;
    }
    const resolveQ = req.query.resolve;
    if (resolveQ !== undefined && resolveQ !== '') {
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      const entry = peekSpawnToken(bearer);
      if (!entry || !entry.scope.has('schedule')) {
        res.status(401).json({ error: 'schedule-help resolve requires a schedule/spawn token' });
        return;
      }
    }
    res.type('text/markdown').send(SCHEDULE_HELP_MD + resolveNamesMd(getDb(), req.query.resolve));
  });

  // ── Agent create (dual-auth spawn token | cookie) ─────────────────────────
  app.post('/projects/:projectId/schedules/agent', async (req, res) => {
  try {
    const db = getDb();
    const projectId = String(req.params.projectId);
    const project = getProject(db, projectId);
    if (!project) {
      res.status(404).json({ error: 'no such project' });
      return;
    }

    const auth = authorizeAgentScheduleCreate(req, projectId, deps);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    let pendingFiles: SchedulePackFile[] | undefined;
    let pendingVars: Record<string, string> | undefined;
    let pendingJobSlug: string | undefined;
    let appliedGoal: string | undefined;
    let appliedWarnings: string[] | undefined;
    let appliedPack: SchedulePack | undefined;

    let createInput: unknown = req.body;

    if (typeof req.body?.packSlug === 'string' && req.body.packSlug.trim()) {
      if (!auth.conversationId) {
        res.status(400).json({ error: 'conversationId required for agent pack apply' });
        return;
      }
      const conv = getConversation(db, auth.conversationId);
      if (!conv) {
        res.status(400).json({ error: 'creating conversation not found' });
        return;
      }
      if (req.body.templateName && req.body.templateName !== conv.templateName) {
        res.status(400).json({ error: 'templateName is not the conversation template' });
        return;
      }
      req.body.templateName = conv.templateName;
      if (!req.body.profileId && auth.conversationId) {
        const last = lastSessionForConversation(db, auth.conversationId);
        if (last?.agentModelId) req.body.profileId = last.agentModelId;
      }

      const pack = getPack(db, req.body.packSlug);
      if (!pack) {
        res.status(404).json({ error: 'no such pack' });
        return;
      }
      appliedPack = pack;
      if (pack.job.cadence.kind === 'cron') {
        res.status(400).json({ error: 'cron_not_allowed' });
        return;
      }

      const general = getGeneralSettings(db);
      const applied = applyPackDefaults(db, project, req.body, general.roleMatchKeywords);
      if (!applied.ok) {
        res.status(applied.status).json({
          error: applied.error,
          ...(applied.conflicts ? { conflicts: applied.conflicts } : {}),
        });
        return;
      }

      pendingFiles = applied.files;
      pendingVars = applied.vars;
      pendingJobSlug = applied.jobSlug;
      appliedGoal = applied.goal;
      appliedWarnings = applied.pipelineNotes;

      // Convert merged request to the agent body shape
      const merged = applied.merged as unknown as Record<string, unknown>;
      if (pack.job.cadence.kind === 'once') {
        merged.fireInMs = typeof req.body.fireInMs === 'number'
          ? req.body.fireInMs
          : pack.job.cadence.fireInMs;
        delete merged.scheduleExpr;
        delete merged.scheduleKind;
      } else if (pack.job.cadence.kind === 'interval') {
        const everyMs = typeof req.body.everyMs === 'number'
          ? req.body.everyMs
          : pack.job.cadence.everyMs;
        merged.scheduleExpr = JSON.stringify({ everyMs });
        merged.scheduleKind = 'interval';
        delete merged.fireInMs;
        delete merged.fireAtMs;
      }
      createInput = merged;
    }

    const parsed = parseAgentCreate(createInput);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const body = parsed.req;

    // Bearer (via === 'spawn'): roster-lock profileId/templateName to the
    // creating conversation's template. Cookie/operator stays unrestricted —
    // same bearer-vs-manual asymmetry as routes/spawn.ts.
    if (auth.via === 'spawn' && auth.conversationId) {
      const conv = getConversation(db, auth.conversationId);
      if (conv?.templateName && body.templateName && body.templateName !== conv.templateName) {
        res.status(400).json({ error: 'templateName is not the conversation template' });
        return;
      }
      const template = conv?.templateName ? getTemplate(db, conv.templateName) : undefined;
      if (!template || template.roles.length === 0) {
        body.profileId = undefined;
        body.templateName = undefined;
        body.role = undefined;
      } else {
        if (body.role) {
          const templateRole = template.roles.find((r) => r.role === body.role);
          if (!templateRole) {
            res.status(400).json({ error: `role "${body.role}" not found in the conversation template` });
            return;
          }
          if (body.profileId && body.profileId !== templateRole.profileId) {
            res.status(400).json({
              error: `role "${body.role}" maps to profile ${templateRole.profileId}, not ${body.profileId}`,
            });
            return;
          }
          body.profileId = templateRole.profileId;
        } else if (body.profileId) {
          if (!template.roles.some((r) => r.profileId === body.profileId)) {
            res.status(400).json({ error: 'profile not in parent template roster' });
            return;
          }
        }
      }
    }

    const templateErr = validateTemplateName(db, body.templateName);
    if (templateErr) {
      res.status(400).json({ error: templateErr });
      return;
    }

    // D4 — default profile from token conversation's last session.
    let profileId = body.profileId;
    if (!profileId) {
      if (!auth.conversationId) {
        res.status(400).json({ error: 'profileId required (could not resolve default)' });
        return;
      }
      const last = lastSessionForConversation(db, auth.conversationId);
      profileId = last?.agentModelId;
      if (!profileId) {
        res.status(400).json({ error: 'profileId required (could not resolve default)' });
        return;
      }
    }
    const profile = catalogue.getProfile(profileId);
    if (!profile || !profile.enabled) {
      res.status(400).json({ error: 'profileId must reference an enabled catalogue profile' });
      return;
    }

    // R2b — reject a bypass-only profile at CREATE time, mirroring routes/spawn.ts:159-165.
    // D1 already dropped the hardcoded bypass in dispatch.ts so the same rejection fires at
    // fire time; catching it here too means the operator learns immediately instead of
    // discovering a dead job at first tick.
    const globalMode = getCompactionSettings(db).interactionMode;
    if (interactionModeRequiresPermissionCapable(globalMode) && !agentSupportsPermissionMode(profile.agentType)) {
      res.status(400).json({
        error: `Agent ${profile.label} (${profile.agentType}) does not support permission mode '${globalMode}' — use claude-code, codex, or hermes`,
      });
      return;
    }

    // Caps (count before insert) — sole rate/capability boundary on the token path
    // after the depth-0 gate was lifted (schedule-token v2.6).
    // Early check is a cheap fast-fail before pack materialise. Re-checked
    // synchronously immediately before createJob (no await between that check
    // and the insert) so two handlers cannot both pass after the remote await.
    if (auth.conversationId) {
      if (countAgentJobsForConversation(db, auth.conversationId) >= AGENT_JOB_CAP_CONVERSATION) {
        res.status(429).json({ error: 'conversation_cap' });
        return;
      }
    }
    if (countAgentJobsForProject(db, projectId) >= AGENT_JOB_CAP_PROJECT) {
      res.status(429).json({ error: 'project_cap' });
      return;
    }

    // D3: Scoped agent enable rule.
    // One-shot ('once') jobs are created enabled and self-start unless safe mode
    // (spawn approval required) is active. Recurring ('interval') jobs self-start
    // only if the operator has explicitly consented via allowAgentRecurringSchedules in settings.
    // Safe mode (global CompactionSettings.spawnApprovalRequired or template.spawnApprovalRequired)
    // always forces enabled = false.
    // H1/L1: Read settings/template and compute enabled BEFORE materialisePackFiles to avoid file leaks on throw.
    // Safe mode checks creating conversation's template (not just body.templateName, which can be omitted).
    const general = getGeneralSettings(db);
    const compaction = getCompactionSettings(db);
    const conv = auth.conversationId ? getConversation(db, auth.conversationId) : undefined;
    const convTemplate = conv?.templateName ? getTemplate(db, conv.templateName) : undefined;
    const bodyTemplate = body.templateName ? getTemplate(db, body.templateName) : undefined;
    const spawnApprovalRequired = compaction.spawnApprovalRequired
      || (convTemplate?.spawnApprovalRequired ?? false)
      || (bodyTemplate?.spawnApprovalRequired ?? false);
    const MODE_RANK = { bypass: 0, questions: 1, prompt: 2 } as const;
    const creatorMode = auth.conversationId ? effectiveInteractionMode(db, auth.conversationId) : undefined;
    const enabled = decideAgentEnabled({
      scheduleKind: body.scheduleKind,
      general,
      spawnApprovalRequired,
      creatorModeStricter: creatorMode !== undefined
        && MODE_RANK[creatorMode] > MODE_RANK[compaction.interactionMode ?? 'bypass'],
    });

    const originalPackSlug = typeof req.body?.packSlug === 'string' ? req.body.packSlug : undefined;
    const targetCheck = validateScheduleTarget(db, {
      project,
      executionMode: 'spawn_child',
      profileId,
      packSlug: originalPackSlug,
      templateName: body.templateName,
      steps: body.steps,
      workdir: body.workdir,
      agentMayComplete: body.agentMayComplete,
      hostView: project.remoteHostId ? deps.remoteHostView?.(project.remoteHostId) : undefined,
    });
    if (!targetCheck.ok) {
      res.status(targetCheck.status).json({
        error: targetCheck.error,
        ...(targetCheck.code ? { code: targetCheck.code } : {}),
        ...(targetCheck.reason ? { reason: targetCheck.reason } : {}),
      });
      return;
    }
    profileId = targetCheck.profileId;

    let packFiles: string[] | undefined;
    let packRollback: (() => Promise<void>) | undefined;
    if (pendingFiles?.length) {
      try {
        const mat = await materialisePackFilesFor(
          db, deps.nodeHub, project, pendingJobSlug!, pendingFiles, pendingVars ?? {},
        );
        packFiles = mat.written;
        packRollback = mat.rollback;
      } catch (e) {
        if (e instanceof PackHostError) {
          res.status(e.status).json({ error: e.message, code: e.code });
          return;
        }
        if (e instanceof PackFileConflict) {
          res.status(409).json({ error: e.message, conflicts: e.conflicts });
          return;
        }
        if (e instanceof PackFilePathError) {
          res.status(400).json({ error: e.message });
          return;
        }
        throw e;
      }
    }

    try {
      await agentCreateBeforeInsert.wait();
      const overCap = (auth.conversationId && countAgentJobsForConversation(db, auth.conversationId) >= AGENT_JOB_CAP_CONVERSATION)
        ? 'conversation_cap'
        : countAgentJobsForProject(db, projectId) >= AGENT_JOB_CAP_PROJECT ? 'project_cap' : null;
      if (overCap) {
        await packRollback?.();
        res.status(429).json({ error: overCap });
        return;
      }
      const parentAgent = conv
        ? (lastSessionForConversation(db, conv.id)?.agentId ?? '')
        : '';
      const hostHello = project.remoteHostId ? getRemoteHost(db, project.remoteHostId)?.hello : undefined;
      const parentEff = resolveSandboxFor(
        db,
        conv ?? {},
        project,
        parentAgent,
        parentAgent ? sandboxCapability(project.remoteHostId ?? 'hub', parentAgent, hostHello) : null,
      );
      const home = createScheduleHomeConversation(db, {
        projectId,
        jobName: body.name,
        sandbox: monotonicChildSandbox(parentEff),
      });
      const now = Date.now();
      const nextFireAt = computeNextFireAt({
        scheduleKind: body.scheduleKind,
        scheduleExpr: body.scheduleExpr,
        timezone: 'UTC', // D6
        afterMs: now,
        createdAtMs: now,
      });
      let job = alignNextFireAtToCreatedAt(db, createJob(db, {
        projectId,
        name: body.name,
        timezone: 'UTC',
        scheduleKind: body.scheduleKind,
        scheduleExpr: body.scheduleExpr,
        overlapPolicy: appliedPack?.job.overlapPolicy,
        runTimeoutMs: appliedPack?.job.runTimeoutMs,
        // D8: agent create is spawn_child-only — never copy a pack's resume mode.
        executionMode: 'spawn_child',
        profileId,
        role: body.role,
        homeConversationId: home.id,
        promptTemplate: body.promptTemplate,
        steer: body.steer,
        nextFireAt,
        agentMayComplete: body.agentMayComplete,
        carryContextEnabled: body.carryContextEnabled,
        workdir: body.workdir,
        templateName: body.templateName,
        steps: body.steps,
        enabled,
        createdBy: 'agent',
        createdByConversationId: auth.conversationId,
        // Stamp the creating conversation (not schedule_home, which is NULL
        // and would resolve to `all`). Empty/absent = `all`.
        capabilityProfile: conv?.capabilityProfile ?? null,
        variables: body.variables,
      }));
      linkHomeConversation(db, home.id, job.id);

      if (appliedGoal) {
        job = applyPendingContext(db, job, { text: appliedGoal, source: 'run', carryContextEnabled: true });
      } else if (body.pendingContext) {
        job = applyPendingContext(db, job, { text: body.pendingContext, source: 'run' });
      }

      const detail = toDetail(db, getJob(db, job.id) ?? job);
      broadcast(projectId, job.id);
      res.status(201).json({
        job: detail,
        homeConversationId: home.id,
        nextFireAtIso: new Date(nextFireAt).toISOString(),
        status: enabled ? 'active' : 'pending_operator_enable',
        ...(packFiles ? { packFiles } : {}),
        ...(appliedWarnings?.length ? { warnings: appliedWarnings } : {}),
      });
    } catch (err) {
      if (packRollback) await packRollback();
      throw err;
    }
  } catch (e) {
    if (!res.headersSent) {
      console.error('[schedules] agent create failed', e);
      res.status(500).json({ error: 'internal error' });
    } else {
      console.error('[schedules] agent create failed after response', e);
    }
  }
  });

  const withAuth = (
    req: Request,
    res: Response,
    jobId: string,
  ): ScheduleJob | undefined => {
    const auth = authorizeScheduleSteps(req, jobId, deps);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return undefined;
    }
    const job = getJob(getDb(), jobId);
    if (!job) {
      res.status(404).json({ error: 'no such schedule job' });
      return undefined;
    }
    return job;
  };

  app.get('/schedules/:jobId/steps', (req, res) => {
    const job = withAuth(req, res, String(req.params.jobId));
    if (!job) return;
    res.json({ steps: listSteps(getDb(), job.id) });
  });

  const putSteps = (req: Request, res: Response) => {
    // Express Request.params is string | string[]; path param is always a string.
    const job = withAuth(req, res, String(req.params.jobId));
    if (!job) return;

    // Forbidden clock/authorship keys even when auth is cookie (hybrid authorship).
    // Agents must not mutate scheduleExpr/profile/enabled via the step endpoint.
    const parsed = parseStepWrites(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    const db = getDb();
    const project = getProject(db, job.projectId);
    if (!project) {
      res.status(404).json({ error: 'no such project' });
      return;
    }
    // Step replace does not change the profile — skip hostView (fire-time +
    // create/PATCH-with-profile-change enforce availability). Offline hosts
    // must still allow plan edits.
    const targetCheck = validateScheduleTarget(db, {
      project,
      executionMode: job.executionMode,
      profileId: job.profileId,
      boundConversationId: job.boundConversationId,
      templateName: job.templateName,
      steps: parsed.steps,
      workdir: job.workdir,
      agentMayComplete: job.agentMayComplete,
    });
    if (!targetCheck.ok) {
      res.status(targetCheck.status).json({
        error: targetCheck.error,
        ...(targetCheck.code ? { code: targetCheck.code } : {}),
        ...(targetCheck.reason ? { reason: targetCheck.reason } : {}),
      });
      return;
    }

    const steps = replaceSteps(db, job.id, parsed.steps);
    broadcast(job.projectId, job.id);
    res.json({ steps });
  };

  app.put('/schedules/:jobId/steps', putSteps);
  // Full-graph rewrite (legacy alias). Prefer PATCH /:stepId for status advances.
  app.patch('/schedules/:jobId/steps', putSteps);

  // Register before /:stepId so "complete-all" is not captured as a step id.
  app.post('/schedules/:jobId/steps/complete-all', (req, res) => {
    const job = withAuth(req, res, String(req.params.jobId));
    if (!job) return;
    const steps = completeAllSteps(getDb(), job.id);
    broadcast(job.projectId, job.id);
    res.json({ steps });
  });

  app.patch('/schedules/:jobId/steps/:stepId', (req, res) => {
    const job = withAuth(req, res, String(req.params.jobId));
    if (!job) return;
    const parsed = parseStepPatch(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const result = patchStep(getDb(), job.id, String(req.params.stepId), parsed.patch);
    if (!result.ok) {
      res.status(404).json({ error: 'no such step on this job' });
      return;
    }
    broadcast(job.projectId, job.id);
    res.json({
      step: result.step,
      ...(result.promoted.length > 0 ? { promoted: result.promoted } : {}),
    });
  });

  app.post('/schedules/:jobId/steps/:stepId/retry', (req, res) => {
    const job = withAuth(req, res, String(req.params.jobId));
    if (!job) return;
    const result = retryStep(getDb(), job.id, String(req.params.stepId));
    if (!result.ok) {
      if (result.reason === 'not_found') {
        res.status(404).json({ error: 'no such step on this job' });
        return;
      }
      res.status(409).json({ error: 'step is not blocked or running' });
      return;
    }
    broadcast(job.projectId, job.id);
    res.json({ step: result.step });
  });

  app.post('/schedules/:jobId/pause-request', (req, res) => {
    const job = withAuth(req, res, String(req.params.jobId));
    if (!job) return;

    const db = getDb();
    // Soft signal only: block the current running step and stamp the active run.
    // Never set enabled=0 (agents cannot disable the job via pause-request).
    const running = listSteps(db, job.id).find((s) => s.status === 'running');
    if (running) updateStepStatus(db, running.id, 'blocked');

    const active = getActiveRunForJob(db, job.id);
    if (active) updateRun(db, active.id, { error: 'agent_pause_request' });

    broadcast(job.projectId, job.id);
    res.status(202).json({
      ok: true,
      stepId: running?.id,
      runId: active?.id,
      error: 'agent_pause_request',
    });
  });

  app.post('/schedules/:jobId/complete-job', (req, res) => {
    const job = withAuth(req, res, String(req.params.jobId));
    if (!job) return;

    if (!job.agentMayComplete) {
      res.status(403).json({ error: 'agent_may_complete is false for this job' });
      return;
    }

    let updated = setJobEnabled(getDb(), job.id, false) ?? job;
    let archived = false;
    if (job.scheduleKind === 'once' && getGeneralSettings(getDb()).autoArchiveCompletedOneShots) {
      archiveJob(getDb(), job.id);
      archived = true;
      updated = { ...updated, archived: true };
    }
    broadcast(job.projectId, job.id);
    res.json({ job: updated, archived });
  });

  // Bearer/run-token path: set/clear pending context only. Cannot toggle carry flag.
  // 403 if carry_context_enabled is off.
  app.put('/schedules/:jobId/pending-context', (req, res) => {
    const jobId = String(req.params.jobId);
    const auth = authorizeScheduleSteps(req, jobId, deps);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const db = getDb();
    const job = getJob(db, jobId);
    if (!job) {
      res.status(404).json({ error: 'no such schedule job' });
      return;
    }

    if (!job.carryContextEnabled) {
      res.status(403).json({ error: 'carry_context_enabled is false for this job' });
      return;
    }

    const parsed = parsePendingContextBody(req.body, { allowFlag: false });
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    // Cookie auth on this agent route is still operator — source 'operator'.
    // Run/spawn tokens source as 'run'.
    const source: PendingContextSource = auth.via === 'cookie' ? 'operator' : 'run';
    const updated = applyPendingContext(db, job, { text: parsed.text, source });
    broadcast(job.projectId, job.id);
    res.json({ job: toDetail(db, updated) });
  });
}

interface ScheduleTreeRunEntry {
  run: ScheduleRun;
  conversation?: Conversation;
  /** Flat spawn subtree rooted at the run's conversation. */
  descendants: Conversation[];
}

interface ScheduleTreeJobEntry {
  job: ScheduleJob;
  runs: ScheduleTreeRunEntry[];
}

function validateWorkdir(workdir: unknown): string | null {
  if (workdir === undefined) return null;
  if (workdir !== 'shared' && workdir !== 'worktree') return 'workdir must be shared or worktree';
  return null;
}

/** Max matches returned per resolve query — a lookup, not a listing. */
const RESOLVE_MAX_MATCHES = 5;
/** Shortest accepted query. Blocks 1-char probes that would match most of the catalogue. */
const RESOLVE_MIN_QUERY = 2;

/**
 * Name resolver for `?resolve=`. Deliberately NOT a listing: the agent must
 * already hold a name (the operator's instruction names the model/template) and
 * this only confirms the exact stored string. Prevents an agent — or anything
 * that has induced one — from lifting the whole catalogue of configured agents,
 * models and rosters out of the help endpoint in one call.
 *
 * Substring, case-insensitive, capped. Names/labels/caps only, no secrets, and
 * the route is loopback-only.
 */
export function resolveNamesMd(db: Database, rawQuery: unknown): string {
  const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (q.length < RESOLVE_MIN_QUERY) {
    return [
      '',
      '## Resolve (no query)',
      '',
      `Append \`?resolve=<name>\` (min ${RESOLVE_MIN_QUERY} chars) to look up the exact`,
      '`templateName` / `profileId` string for a template or model **you were already told to use**.',
      'There is no endpoint that lists them all — if you have no name to resolve, ask the operator',
      'which template and model the job should run as. Do not guess, and do not read the database.',
      '',
    ].join('\n');
  }

  const needle = q.toLowerCase();
  const templates = listTemplates(db)
    .filter((t) => t.name.toLowerCase().includes(needle))
    .slice(0, RESOLVE_MAX_MATCHES)
    .map((t) => `- \`${t.name}\``);
  const profiles = catalogue.listProfiles()
    .filter((p) => p.enabled
      && (p.id.toLowerCase().includes(needle) || p.label.toLowerCase().includes(needle)))
    .slice(0, RESOLVE_MAX_MATCHES)
    .map((p) => {
      const cap = p.maxConcurrentSpawns ?? 0;
      const spawns = cap > 0 ? `can spawn (maxConcurrentSpawns ${cap})` : 'cannot spawn — tick works alone';
      return `- \`${p.id}\` — ${p.label} — ${spawns}`;
    });

  if (templates.length === 0 && profiles.length === 0) {
    return [
      '',
      `## Resolve: "${q}" — no match`,
      '',
      'No enabled profile and no template matches that. Try a shorter distinctive fragment of the',
      'name (a vendor or model word rather than the operator\'s full phrasing). If it still does not',
      'resolve, ask the operator for the exact name — do not substitute one you invented.',
      '',
    ].join('\n');
  }

  return [
    '',
    `## Resolve: "${q}"`,
    '',
    ...(templates.length ? ['**Matching `templateName`:**', '', ...templates, ''] : []),
    ...(profiles.length ? ['**Matching `profileId`:**', '', ...profiles, ''] : []),
    `_Capped at ${RESOLVE_MAX_MATCHES} matches per kind. Copy the string verbatim. If your intended`,
    'template or model is not here, resolve it by name — this endpoint never lists the full catalogue._',
    '',
  ].join('\n');
}

/** null/undefined/'' are fine (no template). Non-empty must exist in settings. */
function validateTemplateName(db: Database, templateName: unknown): string | null {
  if (templateName === undefined || templateName === null || templateName === '') return null;
  if (typeof templateName !== 'string') return 'templateName must be a string or null';
  // Deliberately does not enumerate valid names — resolve narrows by query instead.
  if (!getTemplate(db, templateName)) {
    return `unknown template: ${templateName} — resolve the exact name via GET /agent/schedule-help?resolve=<fragment>`;
  }
  return null;
}

function validateSteer(steer: unknown): string | null {
  if (steer === undefined || steer === null || steer === '') return null;
  if (typeof steer !== 'string') return 'steer must be a string or null';
  if (Buffer.byteLength(steer, 'utf8') > PENDING_CONTEXT_MAX_BYTES) return 'steer_too_large';
  return null;
}

/** True when a once job has already consumed its single fire (sentinel next_fire_at). */
function isOnceExhausted(job: ScheduleJob): boolean {
  return isOnceExhaustedJob(job);
}

// ── FW-20 calendar projection ────────────────────────────────────────────────
/** Hard ceiling per job, even in a one-job project. */
export const CALENDAR_PER_JOB_CAP = 200;
/** Total markers one response may carry, so a 40-job project cannot return 8000. */
export const CALENDAR_GLOBAL_CAP = 2000;
/** Floor, so a very busy project still shows each job's next few fires. */
export const CALENDAR_MIN_PER_JOB = 20;
/** ~2 months: a 6-week grid plus slack. Rejects accidental year-wide requests. */
export const CALENDAR_MAX_WINDOW_MS = 62 * 86_400_000;

export interface ScheduleCalendarJob {
  jobId: string;
  /** Owning project — the full-window All view routes marker clicks on this. */
  projectId: string;
  projectName: string;
  name: string;
  timezone: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  /** Ascending UTC ms, inside [max(from, now), to], excluding operator holes. */
  fires: number[];
  /** Ascending UTC ms operator-skip holes in the same window. Disjoint from fires. */
  skipped: number[];
  /** True when a further real fire exists in the window past the cap. */
  truncated: boolean;
}

export interface ScheduleCalendarResponse {
  from: number;
  to: number;
  jobs: ScheduleCalendarJob[];
}

/** Fair share of the global budget: dense projects shrink evenly, never first-come-first-served. */
export function calendarPerJobCap(jobCount: number): number {
  return Math.max(
    CALENDAR_MIN_PER_JOB,
    Math.min(CALENDAR_PER_JOB_CAP, Math.floor(CALENDAR_GLOBAL_CAP / Math.max(1, jobCount))),
  );
}

/**
 * Project one job's fires + operator holes into `[start, to]`.
 * Extracted so `GET /projects/:id/schedules/calendar` and `GET /schedules/calendar`
 * share ONE `computeNextFireAt` loop — two copies would drift (D3).
 * Upcoming-only: callers pass `start = max(from, now)`, so past cells stay empty
 * rather than inventing fires for days the job may not have been running.
 */
function projectJobCalendar(
  db: Database,
  job: ScheduleJob,
  projectName: string,
  start: number,
  to: number,
  now: number,
  perJobCap: number,
): ScheduleCalendarJob {
  const fires: number[] = [];
  const skipped: number[] = [];
  let truncated = false;

  if (start <= to && !isOnceExhausted(job) && job.enabled) {
    const skipSet = getActiveOperatorSkipSet(db, job, now);
    const step = (afterMs: number) => computeNextFireAt({
      scheduleKind: job.scheduleKind,
      scheduleExpr: job.scheduleExpr,
      timezone: job.timezone,
      afterMs,
      createdAtMs: job.createdAt,
    });
    try {
      let after = start - 1;
      // Each iteration classifies exactly one slot, so the cap is reached first
      // unless the job is >50% holes; the guard only stops pathological input.
      const maxIter = perJobCap * 2 + 64;
      for (let i = 0; i < maxIter; i++) {
        const next = step(after);
        if (next >= ONCE_EXHAUSTED_MS || next > to) break;
        if (skipSet.has(next)) skipped.push(next);
        else fires.push(next);
        after = next;
        if (fires.length >= perJobCap) {
          const more = step(after);
          truncated = more < ONCE_EXHAUSTED_MS && more <= to;
          break;
        }
      }
    } catch {
      // Corrupt schedule_expr: this job contributes nothing, the month still renders.
      fires.length = 0;
      skipped.length = 0;
    }
  }

  return {
    jobId: job.id,
    projectId: job.projectId,
    projectName,
    name: job.name,
    timezone: job.timezone,
    enabled: job.enabled,
    scheduleKind: job.scheduleKind,
    fires,
    skipped,
    truncated,
  };
}

/**
 * Recompute next_fire_at from the persisted created_at.
 * createJob stamps created_at with its own Date.now(), which can tick 1ms after
 * the pre-insert computeNextFireAt(createdAtMs: Date.now()). Interval math then
 * anchors on a different base than the stored clock, so /upcoming's first fire
 * is nextFireAt+1 and skip-this of that slot leaves the clock unmoved.
 */
function alignNextFireAtToCreatedAt(db: Database, job: ScheduleJob): ScheduleJob {
  const aligned = computeNextFireAt({
    scheduleKind: job.scheduleKind,
    scheduleExpr: job.scheduleExpr,
    timezone: job.timezone,
    afterMs: job.createdAt,
    createdAtMs: job.createdAt,
  });
  if (aligned === job.nextFireAt) return job;
  setNextFireAt(db, job.id, aligned);
  return getJob(db, job.id) ?? { ...job, nextFireAt: aligned };
}

/**
 * Validate schedule clock (kind + expr + timezone). Shared by create + PATCH.
 * Operators: once atMs must be in the future (unrestricted horizon).
 */
function validateClock(
  scheduleKind: ScheduleKind,
  scheduleExpr: string,
  timezone: string,
): string | null {
  if (scheduleKind !== 'interval' && scheduleKind !== 'cron' && scheduleKind !== 'once') {
    return 'scheduleKind invalid';
  }
  if (!scheduleExpr?.trim()) return 'scheduleExpr required';
  if (!timezone?.trim()) return 'timezone required';
  try {
    computeNextFireAt({
      scheduleKind,
      scheduleExpr,
      timezone,
      afterMs: Date.now(),
      createdAtMs: Date.now(),
    });
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid schedule';
  }
  if (scheduleKind === 'once') {
    try {
      const { atMs } = parseOnceExpr(scheduleExpr);
      if (!(atMs > Date.now())) return 'once atMs must be in the future';
    } catch (e) {
      return e instanceof Error ? e.message : 'invalid once schedule';
    }
  }
  return null;
}

function validateCreate(db: Database, body: CreateScheduleJobRequest): string | null {
  if (!body.name?.trim()) return 'name required';
  if (!body.timezone?.trim()) return 'timezone required';
  if (body.scheduleKind !== 'interval' && body.scheduleKind !== 'cron' && body.scheduleKind !== 'once') {
    return 'scheduleKind invalid';
  }
  if (!body.scheduleExpr?.trim()) return 'scheduleExpr required';
  if (!body.profileId?.trim()) return 'profileId required';
  if (!body.promptTemplate?.trim()) return 'promptTemplate required';
  if (body.executionMode === 'resume_conversation' && !body.boundConversationId) {
    return 'boundConversationId required for resume_conversation';
  }
  const workdirErr = validateWorkdir(body.workdir);
  if (workdirErr) return workdirErr;
  const templateErr = validateTemplateName(db, body.templateName);
  if (templateErr) return templateErr;
  const steerErr = validateSteer(body.steer);
  if (steerErr) return steerErr;
  const clockErr = validateClock(body.scheduleKind, body.scheduleExpr, body.timezone);
  if (clockErr) return clockErr;
  if (Object.prototype.hasOwnProperty.call(body, 'variables')) {
    const v = parseScheduleVariables(body.variables);
    if (!v.ok) return v.error;
    body.variables = v.value;
  }
  return null;
}

function toDetail(db: Database, job: ScheduleJob): ScheduleJobDetail {
  const steps = listSteps(db, job.id);
  const done = steps.filter((s) => s.status === 'done').length;
  return { ...job, steps, stepProgress: { done, total: steps.length } };
}

/** Loads a job scoped to a project; 404s and returns undefined on any mismatch. */
function loadJobForProject(db: Database, projectId: string, jobId: string, res: Response): ScheduleJob | undefined {
  const job = getJob(db, jobId);
  if (!job || job.projectId !== projectId) {
    res.status(404).json({ error: 'no such schedule job' });
    return undefined;
  }
  return job;
}

function runNowErrorStatus(error: string): number {
  if (error === 'job_not_found') return 404;
  if (error === 'active_run_exists') return 409;
  return 400;
}

/** Operator-facing copy for run-now failures (machine codes stay in jobScheduler). */
function runNowErrorMessage(error: string): string {
  if (error === 'active_run_exists') {
    return 'A run is already in progress for this schedule — wait for it to finish, then try again.';
  }
  if (error === 'job_not_found') return 'schedule not found';
  return error;
}

/** UTF-8 byte length of pending_context text; empty/null is always ok. */
function pendingContextByteLength(text: string | null | undefined): number {
  if (text == null || text === '') return 0;
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Parse pending-context body.
 * `allowFlag` — operator cookie may set carryContextEnabled; agents may not.
 */
function parsePendingContextBody(
  body: unknown,
  opts: { allowFlag: boolean },
): { ok: true; text: string | null; carryContextEnabled?: boolean }
  | { ok: false; status: number; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;

  if (!opts.allowFlag && Object.prototype.hasOwnProperty.call(obj, 'carryContextEnabled')) {
    return { ok: false, status: 403, error: 'agents cannot set carryContextEnabled' };
  }

  if (!Object.prototype.hasOwnProperty.call(obj, 'text')) {
    return { ok: false, status: 400, error: 'text field required (string or null)' };
  }
  const textRaw = obj.text;
  if (textRaw !== null && typeof textRaw !== 'string') {
    return { ok: false, status: 400, error: 'text must be a string or null' };
  }
  const text = textRaw as string | null;

  if (pendingContextByteLength(text) > PENDING_CONTEXT_MAX_BYTES) {
    return { ok: false, status: 400, error: 'pending_context_too_large' };
  }

  let carryContextEnabled: boolean | undefined;
  if (opts.allowFlag && Object.prototype.hasOwnProperty.call(obj, 'carryContextEnabled')) {
    if (typeof obj.carryContextEnabled !== 'boolean') {
      return { ok: false, status: 400, error: 'carryContextEnabled must be a boolean' };
    }
    carryContextEnabled = obj.carryContextEnabled;
  }

  return { ok: true, text, ...(carryContextEnabled !== undefined ? { carryContextEnabled } : {}) };
}

function applyPendingContext(
  db: Database,
  job: ScheduleJob,
  opts: { text: string | null; source: PendingContextSource; carryContextEnabled?: boolean },
): ScheduleJob {
  if (opts.carryContextEnabled !== undefined) {
    updateJob(db, job.id, { carryContextEnabled: opts.carryContextEnabled });
  }
  setPendingContext(db, job.id, { text: opts.text, source: opts.source });
  return getJob(db, job.id) ?? job;
}

type ApplyPackOk = {
  ok: true;
  merged: CreateScheduleJobRequest;
  files?: SchedulePackFile[];
  vars: Record<string, string>;
  jobSlug: string;
  goal?: string;
  pipelineNotes?: string[];
};
type ApplyPackErr = { ok: false; status: number; error: string; conflicts?: string[] };

function packDefaults(pack: SchedulePack): Partial<CreateScheduleJobRequest> {
  const job = pack.job;
  const d: Partial<CreateScheduleJobRequest> = {
    promptTemplate: job.promptTemplate,
    workdir: job.workdir ?? 'shared',
    agentMayComplete: job.agentMayComplete ?? true,
  };
  if (job.steer !== undefined) d.steer = job.steer;
  if (job.overlapPolicy !== undefined) d.overlapPolicy = job.overlapPolicy;
  if (job.executionMode !== undefined) d.executionMode = job.executionMode;
  if (job.runTimeoutMs !== undefined) d.runTimeoutMs = job.runTimeoutMs;
  if (job.steps) d.steps = job.steps.map((s) => ({ title: s.title, body: s.body }));
  if (job.cadence.kind === 'interval') {
    d.scheduleKind = 'interval';
    d.scheduleExpr = JSON.stringify({ everyMs: job.cadence.everyMs });
    d.enabled = false;
  } else if (job.cadence.kind === 'cron') {
    d.scheduleKind = 'cron';
    d.scheduleExpr = job.cadence.expr;
  } else {
    d.scheduleKind = 'once';
    d.scheduleExpr = JSON.stringify({ atMs: Date.now() + job.cadence.fireInMs });
  }
  return d;
}

function definedFieldsOf(body: CreateScheduleJobRequest): Partial<CreateScheduleJobRequest> {
  const out: Partial<CreateScheduleJobRequest> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function prefixedName(slug: string, name: string): string {
  const p = `[${slug}]`;
  return name.startsWith(p) ? name : `${p} ${name.trim()}`;
}

function applyPackDefaults(
  db: Database,
  project: Project,
  body: CreateScheduleJobRequest,
  roleMatchKeywords?: Record<string, string[]>,
): ApplyPackOk | ApplyPackErr {
  const pack = getPack(db, body.packSlug ?? '');
  if (!pack) return { ok: false, status: 404, error: 'no such pack' };

  const merged = { ...packDefaults(pack), ...definedFieldsOf(body) } as CreateScheduleJobRequest;
  if (merged.name?.trim()) merged.name = prefixedName(pack.slug, merged.name);

  const packVars: Record<string, string> = {
    ...(pack.job.variables ?? {}),
    ...(body.packVars ?? {}),
  };

  if (pack.requiresTemplate) {
    if (!merged.templateName?.trim()) {
      return { ok: false, status: 400, error: 'requiresTemplate: a spawn template is required' };
    }
    if (!getTemplate(db, merged.templateName.trim())) {
      return { ok: false, status: 400, error: `requiresTemplate: unknown template: ${merged.templateName}` };
    }
    const profileId = merged.profileId?.trim() ?? '';
    const profile = profileId ? catalogue.getProfile(profileId) : undefined;
    if ((profile?.maxConcurrentSpawns ?? 0) <= 0) {
      return {
        ok: false,
        status: 400,
        error: `profile '${profileId}' has no spawn capacity — set maxConcurrentSpawns for it in Settings → Agents`,
      };
    }
  }

  if (pack.applyFields?.length) {
    for (const f of pack.applyFields) {
      const v = packVars[f.key];
      if (typeof v !== 'string' || v === '') {
        return { ok: false, status: 400, error: `packVars.${f.key} required` };
      }
      if (f.type === 'select' && f.options && f.options.length > 0) {
        if (!f.options.some((o) => o.value === v)) {
          return { ok: false, status: 400, error: `packVars.${f.key} is not a valid option` };
        }
      }
    }
  }

  let goal: string | undefined;
  if (typeof body.goal === 'string' && body.goal.trim()) {
    goal = body.goal.trim();
    if (Buffer.byteLength(goal, 'utf8') > PENDING_CONTEXT_MAX_BYTES) {
      return { ok: false, status: 400, error: 'pending_context_too_large' };
    }
    merged.carryContextEnabled = true;
  }

  let pipelineNotes: string[] = [];
  let pv: Record<string, string> = {};
  let roleCheckVars: Record<string, string> | undefined;

  if (merged.promptTemplate?.includes('{{pipeline}}')) {
    // packVars already is job.variables < body.packVars. Only pipeline keys
    // enter pv so apply-time tokens (e.g. mode) stay in seededVars and
    // operator packVars still win over pack defaults.
    for (const [k, v] of Object.entries(packVars)) {
      if (k === 'stages' || k === 'commitOnTick' || /^[a-z][a-z0-9]{0,23}(Role|Function)$/.test(k)) {
        pv[k] = v;
      }
    }
    if (body.variables) {
      for (const [k, v] of Object.entries(body.variables)) {
        if (typeof v === 'string') {
          pv[k] = v;
        }
      }
    }

    const template = merged.templateName?.trim() ? getTemplate(db, merged.templateName.trim()) : undefined;
    const templateRoles = template?.roles ?? [];
    const filled = fillStageRoles(pv, templateRoles, roleMatchKeywords);
    pv = filled.vars;
    const check = checkPipelineRoles(pv, templateRoles.map((r) => r.role), pack.requiredStages ?? []);
    if (!check.ok) {
      const templateName = merged.templateName?.trim() ?? '';
      return {
        ok: false,
        status: 400,
        error: `${check.error}. Add a delegate to template '${templateName}' whose "use when" mentions this stage, adjust stage keywords in Settings → Schedules, or pass <stage>Role in pack variables.`,
      };
    }
    roleCheckVars = check.vars;
    pv = check.vars;
    pipelineNotes = [...filled.notes, ...check.notes];
  }

  const jobSlug = jobNameToSlug(merged.name ?? '', pack.slug);
  const vars: Record<string, string> = {
    ...packVars,
    goal: goal ?? '',
    jobName: merged.name ?? '',
    slug: pack.slug,
    jobSlug,
    projectRoot: project.rootPath,
    timezone: merged.timezone ?? '',
    pipelineNotes: pipelineNotes.length > 0 ? `; ${pipelineNotes.join(', ')}` : '',
  };
  if (merged.promptTemplate !== undefined) {
    merged.promptTemplate = substitutePackTokens(merged.promptTemplate, vars);
  }
  if (merged.steer !== undefined) merged.steer = substitutePackTokens(merged.steer, vars);
  if (merged.steps) {
    merged.steps = merged.steps.map((s) => ({
      ...s,
      title: substitutePackTokens(s.title, vars),
      body: substitutePackTokens(s.body, vars),
    }));
  }
  // Seed only packVars referenced as {{vars.<key>}} in promptTemplate or steer,
  // merged with any operator-supplied variables (operator wins).
  // Unreferenced packVars (e.g. apply-time [[tokens]]) are not schedule variables
  // and must not pollute the job's runtime variable map.
  const referencedKeys = new Set<string>();
  const VAR_TOKEN_SCAN = /\{\{vars\.([a-zA-Z_][a-zA-Z0-9_]{0,63})\}\}/g;
  for (const text of [merged.promptTemplate, merged.steer]) {
    if (!text) continue;
    let m: RegExpExecArray | null;
    VAR_TOKEN_SCAN.lastIndex = 0;
    while ((m = VAR_TOKEN_SCAN.exec(text)) !== null) {
      referencedKeys.add(m[1]!);
    }
  }

  const seededVars: Record<string, string> = {};
  for (const k of referencedKeys) {
    if (typeof packVars[k] === 'string') {
      seededVars[k] = packVars[k];
    }
  }

  if (merged.promptTemplate?.includes('{{pipeline}}')) {
    const combined = {
      ...seededVars,
      ...pv,
      ...(body.variables ?? {}),
      ...(roleCheckVars ?? {}),
    };
    if (Object.keys(combined).length > 0) {
      merged.variables = combined;
    } else {
      delete merged.variables;
    }
  } else {
    const combined = { ...seededVars, ...(body.variables ?? {}) };
    if (Object.keys(combined).length > 0) {
      merged.variables = combined;
    } else if (body.variables !== undefined) {
      merged.variables = body.variables;
    } else {
      delete merged.variables;
    }
  }

  return {
    ok: true,
    merged,
    files: pack.files,
    vars,
    jobSlug,
    goal,
    pipelineNotes: pipelineNotes.length > 0 ? pipelineNotes : undefined,
  };
}

// An async throw here escapes Express 4 and kills the hub (no
// unhandledRejection handler) — every caller, incl. bulk, goes through this.
export async function performScheduleDelete(deps: ScheduleRouteDeps, jobId: string, projectId?: string): Promise<ScheduleDeleteOutcome> {
  try {
    return await performScheduleDeleteUnsafe(deps, jobId, projectId);
  } catch (err) {
    console.error('[delete-schedule] failed:', err);
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performScheduleDeleteUnsafe(
  deps: ScheduleRouteDeps,
  jobId: string,
  projectId?: string,
): Promise<ScheduleDeleteOutcome> {
  const db = deps.getDb();
  const job = getJob(db, jobId);
  if (!job || (projectId && job.projectId !== projectId)) {
    return { ok: false, status: 404, error: 'no such schedule job' };
  }

  if (getActiveRunForJob(db, job.id)) {
    return { ok: false, status: 409, error: 'schedule has an active run; wait or stop it first' };
  }

  // Collect owned conversation trees we will purge (spawn_child runs under home only).
  // Bound chats for resume_conversation are excluded from the live-session 409 check
  // and from parked-session reaping (D1).
  const runConvIds = (
    db.prepare(
      `SELECT DISTINCT r.conversation_id AS id FROM schedule_runs r
         JOIN conversations c ON c.id = r.conversation_id
        WHERE r.job_id = ? AND c.parent_conversation_id = ?`,
    ).all(job.id, job.homeConversationId) as { id: string }[]
  ).map((r) => r.id);
  const roots = [...runConvIds, job.homeConversationId].filter(Boolean) as string[];
  const allIds = new Set<string>();
  for (const root of roots) {
    allIds.add(root);
    for (const d of listDescendants(db, root)) allIds.add(d.id);
  }

  const sm = deps.sessionManager;
  if (sm) {
    for (const id of allIds) {
      if (sm.inFlightSessionForConversation(id)) {
        return { ok: false, status: 409, error: 'schedule conversation tree has a live session' };
      }
    }
    await Promise.all([...allIds].map((id) => sm.reapParkedSessions(id, { all: true })));
  }

  const result = hardDeleteJob(db, job.id);
  if (!result.ok) {
    return { ok: false, status: 404, error: 'no such schedule job' };
  }

  if (result.nativeSessions.length > 0) {
    const unique = Array.from(
      new Map(result.nativeSessions.map((s) => [`${s.agentId}:${s.nativeSessionId}`, s])).values(),
    );
    await Promise.all(unique.map(async ({ agentId, nativeSessionId, projectId }) => {
      try {
        // ponytail: host offline at delete time = the native file leaks on that
        // host; queue a per-host purge list if that ever matters.
        const adapter = createAdapterFor(db, agentId, { projectId });
        await adapter.deleteNativeSession?.(nativeSessionId);
      } catch (err) {
        console.error(`[delete-schedule] native unlink failed for ${agentId}/${nativeSessionId}:`, err);
      }
    }));
  }
  unlinkTtsWavPaths(result.ttsWavPaths);

  deps.broadcast(job.projectId, job.id);
  return {
    ok: true,
    deletedConversationIds: result.deletedConversationIds,
  };
}

export function performScheduleArchive(
  deps: ScheduleRouteDeps,
  jobId: string,
  projectId?: string,
): ScheduleJobOutcome {
  const db = deps.getDb();
  const job = getJob(db, jobId);
  if (!job || (projectId && job.projectId !== projectId)) {
    return { ok: false, status: 404, error: 'no such schedule job' };
  }
  setJobEnabled(db, job.id, false);
  const archived = archiveJob(db, job.id) ?? job;
  deps.broadcast(job.projectId, job.id);
  return { ok: true, job: toDetail(db, archived) };
}

export function performScheduleUnarchive(
  deps: ScheduleRouteDeps,
  jobId: string,
  projectId?: string,
): ScheduleJobOutcome {
  const db = deps.getDb();
  const job = getJob(db, jobId);
  if (!job || (projectId && job.projectId !== projectId)) {
    return { ok: false, status: 404, error: 'no such schedule job' };
  }
  const unarchived = unarchiveJob(db, job.id) ?? job;
  deps.broadcast(job.projectId, job.id);
  return { ok: true, job: toDetail(db, unarchived) };
}

export function performScheduleEnable(
  deps: ScheduleRouteDeps,
  jobId: string,
  projectId?: string,
): ScheduleJobOutcome {
  const db = deps.getDb();
  const job = getJob(db, jobId);
  if (!job || (projectId && job.projectId !== projectId)) {
    return { ok: false, status: 404, error: 'no such schedule job' };
  }
  if (isOnceExhausted(job)) {
    return {
      ok: false,
      status: 400,
      error: 'once job is exhausted; edit the fire time (PATCH scheduleKind/scheduleExpr) to schedule again',
    };
  }
  setJobEnabled(db, job.id, true);
  if (!job.enabled) rearmStaleNextFire(db, job);
  const updated = getJob(db, job.id) ?? job;
  deps.broadcast(job.projectId, job.id);
  return { ok: true, job: toDetail(db, updated) };
}

/** Enabling must not fire immediately: a disabled job's next_fire_at stays in
 *  the past, so push it to the next real (non-skipped) slot after now. */
function rearmStaleNextFire(db: Database, job: ScheduleJob): void {
  const now = Date.now();
  if (job.scheduleKind === 'once' || job.nextFireAt > now) return;
  setNextFireAt(db, job.id, recomputeNextFireAfterSkipChange(db, job, { advancePastMs: now }));
}

export function performScheduleDisable(
  deps: ScheduleRouteDeps,
  jobId: string,
  projectId?: string,
): ScheduleJobOutcome {
  const db = deps.getDb();
  const job = getJob(db, jobId);
  if (!job || (projectId && job.projectId !== projectId)) {
    return { ok: false, status: 404, error: 'no such schedule job' };
  }
  const updated = setJobEnabled(db, job.id, false) ?? job;
  deps.broadcast(job.projectId, job.id);
  return { ok: true, job: toDetail(db, updated) };
}

export function registerScheduleRoutes(app: Express, deps: Deps): void {
  const { getDb, broadcast, jobScheduler, sessionManager } = deps;

  function enrichConversationLive(c: Conversation | undefined): Conversation | undefined {
    if (!c || !sessionManager) return c;
    const session = sessionManager.activeSessionForConversation(c.id);
    const liveStatus = liveAgentStatusForSession(session);
    if (liveStatus === undefined) return c;
    return { ...c, isActive: true, liveStatus };
  }

  /**
   * Full-window calendar — every non-archived job across every project, or one
   * project when `?projectId=` is supplied (404 on an unknown id).
   *
   * Two path segments, so none of the pre-auth `/schedules/:jobId/<sub>` routes
   * can shadow it and there is no bare `GET /schedules/:jobId` to swallow
   * `calendar` (D2). Cookie-auth, inherited from the global requireAuth.
   *
   * One request, not one-per-project: the fair-share budget is computed over the
   * TOTAL job count, so N projects cannot return N × CALENDAR_GLOBAL_CAP (D1).
   */
  app.get('/schedules/calendar', (req, res) => {
    const db = getDb();

    const scopeId = req.query.projectId === undefined ? undefined : String(req.query.projectId);
    let projects: Project[];
    if (scopeId === undefined) {
      projects = listProjects(db);
    } else {
      const scoped = getProject(db, scopeId);
      if (!scoped) { res.status(404).json({ error: 'no such project' }); return; }
      projects = [scoped];
    }

    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      res.status(400).json({ error: 'from and to must be finite UTC ms with to > from' });
      return;
    }
    if (to - from > CALENDAR_MAX_WINDOW_MS) {
      res.status(400).json({ error: 'calendar window must be 62 days or less' });
      return;
    }

    const now = Date.now();
    const start = Math.max(from, now);
    const pairs: Array<{ job: ScheduleJob; projectName: string }> = [];
    for (const p of projects) {
      for (const job of listJobsForProject(db, p.id)) {
        if (!job.enabled) continue;
        pairs.push({ job, projectName: p.name });
      }
    }
    const perJobCap = calendarPerJobCap(pairs.length);
    const out = pairs.map(
      ({ job, projectName }) => projectJobCalendar(db, job, projectName, start, to, now, perJobCap),
    );

    const body: ScheduleCalendarResponse = { from, to, jobs: out };
    res.json(body);
  });

  app.get('/projects/:projectId/schedules', (req, res) => {
    const db = getDb();
    const { projectId } = req.params;
    if (!getProject(db, projectId)) { res.status(404).json({ error: 'no such project' }); return; }
    const jobs = listJobsForProject(db, projectId);
    const withProgress = req.query.stepProgress === 'true' || req.query.stepProgress === '1';
    res.json({ jobs: withProgress ? jobs.map((j) => toDetail(db, j)) : jobs });
  });

  app.post('/projects/:projectId/schedules', async (req, res) => {
  try {
    const db = getDb();
    const { projectId } = req.params;
    const project = getProject(db, projectId);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }

    const overwritePackFiles = req.body?.overwritePackFiles === true;
    let body = req.body as CreateScheduleJobRequest;
    let pendingFiles: SchedulePackFile[] | undefined;
    let pendingVars: Record<string, string> | undefined;
    let pendingJobSlug: string | undefined;
    let goal: string | undefined;
    let appliedWarnings: string[] | undefined;

    if (body.packSlug) {
      const general = getGeneralSettings(db);
      const applied = applyPackDefaults(db, project, body, general.roleMatchKeywords);
      if (!applied.ok) {
        res.status(applied.status).json({
          error: applied.error,
          ...(applied.conflicts ? { conflicts: applied.conflicts } : {}),
        });
        return;
      }
      body = applied.merged;
      pendingFiles = applied.files;
      pendingVars = applied.vars;
      pendingJobSlug = applied.jobSlug;
      goal = applied.goal;
      appliedWarnings = applied.pipelineNotes;
    }

    const validationError = validateCreate(db, body);
    if (validationError) { res.status(400).json({ error: validationError }); return; }

    const originalPackSlug = typeof req.body?.packSlug === 'string' ? req.body.packSlug : undefined;
    const targetCheck = validateScheduleTarget(db, {
      project,
      executionMode: body.executionMode ?? 'spawn_child',
      profileId: body.profileId.trim(),
      boundConversationId: body.boundConversationId,
      packSlug: originalPackSlug,
      templateName: body.templateName,
      steps: body.steps,
      workdir: body.workdir,
      agentMayComplete: body.agentMayComplete,
      hostView: project.remoteHostId ? deps.remoteHostView?.(project.remoteHostId) : undefined,
    });
    if (!targetCheck.ok) {
      res.status(targetCheck.status).json({
        error: targetCheck.error,
        ...(targetCheck.code ? { code: targetCheck.code } : {}),
        ...(targetCheck.reason ? { reason: targetCheck.reason } : {}),
      });
      return;
    }

    let packFiles: string[] | undefined;
    let packRollback: (() => Promise<void>) | undefined;
    if (pendingFiles?.length) {
      try {
        const mat = await materialisePackFilesFor(
          db, deps.nodeHub, project, pendingJobSlug!, pendingFiles, pendingVars ?? {},
          { overwrite: overwritePackFiles },
        );
        packFiles = mat.written;
        packRollback = mat.rollback;
      } catch (e) {
        if (e instanceof PackHostError) {
          res.status(e.status).json({ error: e.message, code: e.code });
          return;
        }
        if (e instanceof PackFileConflict) {
          res.status(409).json({ error: e.message, conflicts: e.conflicts });
          return;
        }
        if (e instanceof PackFilePathError) {
          res.status(400).json({ error: e.message });
          return;
        }
        throw e;
      }
    }

    try {
      const home = createScheduleHomeConversation(db, { projectId, jobName: body.name.trim() });
      const now = Date.now();
      const nextFireAt = computeNextFireAt({
        scheduleKind: body.scheduleKind,
        scheduleExpr: body.scheduleExpr,
        timezone: body.timezone,
        afterMs: now,
        createdAtMs: now,
      });
      const job = alignNextFireAtToCreatedAt(db, createJob(db, {
        projectId,
        name: body.name.trim(),
        timezone: body.timezone.trim(),
        scheduleKind: body.scheduleKind,
        scheduleExpr: body.scheduleExpr,
        overlapPolicy: body.overlapPolicy,
        executionMode: body.executionMode,
        profileId: targetCheck.profileId,
        role: body.role,
        boundConversationId: body.boundConversationId,
        homeConversationId: home.id,
        // Non-null: validateCreate above rejects a missing/blank promptTemplate,
        // and on a pack apply the merge has already filled it from the pack.
        promptTemplate: body.promptTemplate!,
        steer: body.steer?.trim() || undefined,
        runTimeoutMs: body.runTimeoutMs,
        nextFireAt,
        agentMayComplete: body.agentMayComplete,
        carryContextEnabled: body.carryContextEnabled,
        workdir: body.workdir,
        templateName: body.templateName?.trim() || undefined,
        steps: body.steps,
        enabled: body.enabled,
        variables: body.variables,
      }));
      linkHomeConversation(db, home.id, job.id);
      if (goal) setPendingContext(db, job.id, { text: goal, source: 'operator' });
      broadcast(projectId, job.id);
      res.status(201).json({
        job: toDetail(db, getJob(db, job.id) ?? job),
        ...(packFiles ? { packFiles } : {}),
        ...(appliedWarnings?.length ? { warnings: appliedWarnings } : {}),
      });
    } catch (err) {
      if (packRollback) await packRollback();
      throw err;
    }
  } catch (e) {
    if (!res.headersSent) {
      console.error('[schedules] operator create failed', e);
      res.status(500).json({ error: 'internal error' });
    } else {
      console.error('[schedules] operator create failed after response', e);
    }
  }
  });

  // Registered before `/:jobId` — otherwise that route would swallow `tree` as a jobId.
  app.get('/projects/:projectId/schedules/tree', (req, res) => {
    const db = getDb();
    const { projectId } = req.params;
    if (!getProject(db, projectId)) { res.status(404).json({ error: 'no such project' }); return; }
    const runLimit = req.query.runLimit ? Number(req.query.runLimit) : 20;
    const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
    const jobs = listJobsForProject(db, projectId, { includeArchived });
    const treeJobs: ScheduleTreeJobEntry[] = jobs.map((job) => {
      // excludeHoleRows: operator skip bookkeeping must not fill runLimit and hide past ticks.
      const runs = listRunsForJob(db, job.id, { limit: runLimit, excludeHoleRows: true });
      return {
        job,
        runs: runs.map((run) => ({
          run,
          conversation: run.conversationId
            ? enrichConversationLive(getConversation(db, run.conversationId))
            : undefined,
          // resume_conversation: bound chat's spawn children belong to the chat, not the schedule.
          // Keep `conversation` so the Schedules tab can jump to the bound chat.
          descendants: job.executionMode === 'resume_conversation'
            ? []
            : (run.conversationId
              ? listDescendants(db, run.conversationId, { hideBtw: true }).map((d) => enrichConversationLive(d) ?? d)
              : []),
        })),
      };
    });
    res.json({ jobs: treeJobs });
  });

  /**
   * FW-20 — project-wide upcoming-fire projection for the calendar grid.
   * Registered before `/:jobId` — otherwise that route swallows `calendar` as a jobId.
   * Upcoming-only: the window start is clamped to now, so past cells stay empty
   * rather than inventing fires for days the job may not have been running.
   */
  app.get('/projects/:projectId/schedules/calendar', (req, res) => {
    const db = getDb();
    const { projectId } = req.params;
    const project = getProject(db, projectId);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }

    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      res.status(400).json({ error: 'from and to must be finite UTC ms with to > from' });
      return;
    }
    if (to - from > CALENDAR_MAX_WINDOW_MS) {
      res.status(400).json({ error: 'calendar window must be 62 days or less' });
      return;
    }

    const now = Date.now();
    const start = Math.max(from, now);
    const jobs = listJobsForProject(db, projectId).filter((j) => j.enabled); // archived & disabled excluded
    const perJobCap = calendarPerJobCap(jobs.length);
    const out = jobs.map((job) => projectJobCalendar(db, job, project.name, start, to, now, perJobCap));

    const body: ScheduleCalendarResponse = { from, to, jobs: out };
    res.json(body);
  });

  app.get('/projects/:projectId/schedules/:jobId', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    res.json({ job: toDetail(db, job) });
  });

  app.patch('/projects/:projectId/schedules/:jobId', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const patch = req.body as PatchScheduleJobRequest;
    const workdirErr = validateWorkdir(patch.workdir);
    if (workdirErr) { res.status(400).json({ error: workdirErr }); return; }
    if (Object.prototype.hasOwnProperty.call(patch, 'templateName')) {
      const templateErr = validateTemplateName(db, patch.templateName);
      if (templateErr) { res.status(400).json({ error: templateErr }); return; }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'steer')) {
      const steerErr = validateSteer(patch.steer);
      if (steerErr) { res.status(400).json({ error: steerErr }); return; }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'variables')) {
      const v = parseScheduleVariables(patch.variables);
      if (!v.ok) { res.status(400).json({ error: v.error }); return; }
      patch.variables = v.value ?? null;
    }

    // Empty promptTemplate on resume (create already rejects via validateCreate).
    if (
      Object.prototype.hasOwnProperty.call(patch, 'promptTemplate')
      && job.executionMode === 'resume_conversation'
      && (typeof patch.promptTemplate !== 'string' || !patch.promptTemplate.trim())
    ) {
      res.status(400).json({ error: 'promptTemplate required' });
      return;
    }

    // R1: executionMode is immutable after create (same value is a no-op).
    if (
      patch.executionMode !== undefined
      && patch.executionMode !== job.executionMode
    ) {
      res.status(400).json({ error: 'executionMode is immutable' });
      return;
    }

    // Bound rebind (cookie-only PATCH). Mode itself cannot change.
    if (Object.prototype.hasOwnProperty.call(patch, 'boundConversationId')) {
      const effMode = job.executionMode;
      if (effMode === 'resume_conversation') {
        if (patch.boundConversationId == null || patch.boundConversationId === '') {
          res.status(400).json({ error: 'boundConversationId required for resume_conversation' });
          return;
        }
        const boundErr = validateBoundConversationForResume(
          db,
          job.projectId,
          patch.boundConversationId,
        );
        if (boundErr) {
          res.status(400).json({ error: boundErr });
          return;
        }
      } else if (patch.boundConversationId != null && patch.boundConversationId !== '') {
        res.status(400).json({ error: 'boundConversationId only valid for resume_conversation' });
        return;
      }
    }

    const bodyRec = req.body as Record<string, unknown> | null;
    const stepsKeyPresent = Boolean(bodyRec && Object.prototype.hasOwnProperty.call(bodyRec, 'steps'));
    let patchStepWrites: StepWrite[] | undefined;
    if (stepsKeyPresent) {
      const parsedSteps = parseStepWrites({ steps: bodyRec!.steps });
      if (!parsedSteps.ok) {
        res.status(parsedSteps.status).json({ error: parsedSteps.error });
        return;
      }
      patchStepWrites = parsedSteps.steps;
    }

    const project = getProject(db, job.projectId);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }
    const targetCheck = validateScheduleTargetPatch(db, {
      project,
      job: {
        profileId: job.profileId,
        executionMode: job.executionMode,
        boundConversationId: job.boundConversationId,
        templateName: job.templateName,
        workdir: job.workdir,
        agentMayComplete: job.agentMayComplete,
      },
      storedSteps: listSteps(db, job.id),
      patch: {
        ...(Object.prototype.hasOwnProperty.call(patch, 'profileId') ? { profileId: patch.profileId } : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'workdir') ? { workdir: patch.workdir } : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'templateName') ? { templateName: patch.templateName } : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'agentMayComplete')
          ? { agentMayComplete: patch.agentMayComplete }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'boundConversationId')
          ? { boundConversationId: patch.boundConversationId }
          : {}),
        ...(stepsKeyPresent ? { steps: patchStepWrites, stepsKeyPresent: true } : {}),
      },
      hostView: project.remoteHostId ? deps.remoteHostView?.(project.remoteHostId) : undefined,
    });
    if (!targetCheck.ok) {
      res.status(targetCheck.status).json({
        error: targetCheck.error,
        ...(targetCheck.code ? { code: targetCheck.code } : {}),
        ...(targetCheck.reason ? { reason: targetCheck.reason } : {}),
      });
      return;
    }
    // Bot pinning may rewrite profileId on rebind even when the client omitted it.
    if (
      Object.prototype.hasOwnProperty.call(patch, 'profileId')
      || targetCheck.profileId !== job.profileId
    ) {
      patch.profileId = targetCheck.profileId;
    }

    const clockChanged =
      patch.scheduleKind !== undefined ||
      patch.scheduleExpr !== undefined ||
      patch.timezone !== undefined;
    if (clockChanged) {
      const effKind = (patch.scheduleKind ?? job.scheduleKind) as ScheduleKind;
      const effExpr = patch.scheduleExpr ?? job.scheduleExpr;
      const effTz = patch.timezone ?? job.timezone;
      const clockErr = validateClock(effKind, effExpr, effTz);
      if (clockErr) { res.status(400).json({ error: clockErr }); return; }
    }

    // F2 — do not re-enable an exhausted once without a clock edit in the same PATCH.
    if (patch.enabled === true && isOnceExhausted(job) && !clockChanged) {
      res.status(400).json({
        error: 'once job is exhausted; edit the fire time (PATCH scheduleKind/scheduleExpr) to schedule again',
      });
      return;
    }

    const updated = updateJob(db, job.id, patch);
    if (!updated) { res.status(404).json({ error: 'no such schedule job' }); return; }

    // Optional steps overlay on PATCH (e.g. clear steps while switching to a bare-prompt profile).
    if (patchStepWrites) {
      replaceSteps(db, job.id, patchStepWrites);
    }

    // updateJob does not recompute next_fire_at — do it when the clock changes (D4).
    let result = getJob(db, updated.id) ?? updated;
    if (clockChanged) {
      const now = Date.now();
      const next = computeNextFireAt({
        scheduleKind: updated.scheduleKind,
        scheduleExpr: updated.scheduleExpr,
        timezone: updated.timezone,
        afterMs: now,
        createdAtMs: updated.createdAt,
      });
      setNextFireAt(db, updated.id, next);
      result = getJob(db, updated.id) ?? updated;
    } else if (patch.enabled === true && !job.enabled) {
      rearmStaleNextFire(db, updated);
      result = getJob(db, updated.id) ?? updated;
    }

    broadcast(job.projectId, job.id);
    res.json({ job: toDetail(db, result) });
  });

  // Soft-archive (hide from lists; keep data). Prefer hard DELETE for permanent purge.
  app.post('/projects/:projectId/schedules/:jobId/archive', (req, res) => {
    const out = performScheduleArchive(deps, req.params.jobId, req.params.projectId);
    if (!out.ok) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json({ job: out.job });
  });

  app.post('/projects/:projectId/schedules/:jobId/unarchive', (req, res) => {
    const out = performScheduleUnarchive(deps, req.params.jobId, req.params.projectId);
    if (!out.ok) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json({ job: out.job });
  });

  /**
   * Hard-delete a schedule: run conversations (+ spawn subtrees + TTS), home
   * conversation, steps, and runs. 409 if a tick is still pending/running.
   * Soft-archive: POST .../archive
   */
  app.delete('/projects/:projectId/schedules/:jobId', async (req, res) => {
    const out = await performScheduleDelete(deps, req.params.jobId, req.params.projectId);
    if (!out.ok) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json({
      ok: true,
      deletedConversationIds: out.deletedConversationIds,
    });
  });

  app.post('/projects/:projectId/schedules/:jobId/enable', (req, res) => {
    const out = performScheduleEnable(deps, req.params.jobId, req.params.projectId);
    if (!out.ok) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json({ job: out.job });
  });

  app.post('/projects/:projectId/schedules/:jobId/disable', (req, res) => {
    const out = performScheduleDisable(deps, req.params.jobId, req.params.projectId);
    if (!out.ok) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json({ job: out.job });
  });

  app.post('/projects/:projectId/schedules/:jobId/run-now', async (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const result = await jobScheduler.runNow(job.id);
    if (!result.ok) {
      res.status(runNowErrorStatus(result.error)).json({ error: runNowErrorMessage(result.error) });
      return;
    }
    broadcast(job.projectId, job.id);
    res.status(202).json({ runId: result.runId });
  });

  app.get('/projects/:projectId/schedules/:jobId/runs', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    // Past-runs pane: same hole filter as the schedules tree (Upcoming owns holes).
    res.json({ runs: listRunsForJob(db, job.id, { limit, excludeHoleRows: true }) });
  });

  /**
   * Hard-delete a single schedule run row (e.g. an orphaned run whose conversation
   * was deleted, or a failed tick record).
   */
  app.delete('/projects/:projectId/schedules/:jobId/runs/:runId', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const ok = deleteRun(db, req.params.runId);
    if (!ok) {
      res.status(404).json({ error: 'no such run' });
      return;
    }
    broadcast(job.projectId, job.id);
    res.json({ ok: true, deletedRunId: req.params.runId });
  });

  /**
   * Clear failed / errored runs for a schedule job so the schedule returns to healthy.
   * If `onlyOrphaned` query/body is true, only runs with no conversation attached are removed.
   */
  app.post('/projects/:projectId/schedules/:jobId/clear-errors', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const onlyOrphaned = req.query.onlyOrphaned === '1' || req.query.onlyOrphaned === 'true' || req.body?.onlyOrphaned === true;
    const deletedCount = clearJobErrors(db, job.id, { onlyOrphaned });
    broadcast(job.projectId, job.id);
    res.json({ ok: true, deletedCount });
  });

  app.get('/projects/:projectId/schedules/:jobId/upcoming', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const count = Math.max(0, Math.min(req.query.count ? Number(req.query.count) : 5, 50));
    try {
      // Active fires: hole-free from the job clock (next_fire_at is always non-hole).
      // Skipped: all restorable operator holes (may sit after next — hole-punch).
      const skipSet = getActiveOperatorSkipSet(db, job);
      let fires: number[] = [];
      if (!isOnceExhausted(job)) {
        // The stored clock is the first upcoming fire when it is still in the
        // future. Recomputing from createdAt can miss it by 1ms when Date.now()
        // ticked between nextFireAt computation and INSERT created_at.
        const now = Date.now();
        let after: number;
        if (job.nextFireAt > now) {
          if (!skipSet.has(job.nextFireAt)) fires.push(job.nextFireAt);
          after = job.nextFireAt;
        } else {
          after = now;
        }
        let guard = 0;
        while (fires.length < count && guard++ < 80) {
          const n = computeNextFireAt({
            scheduleKind: job.scheduleKind,
            scheduleExpr: job.scheduleExpr,
            timezone: job.timezone,
            afterMs: after,
            createdAtMs: job.createdAt,
          });
          if (n >= ONCE_EXHAUSTED_MS) break;
          if (!skipSet.has(n)) fires.push(n);
          after = n;
        }
      }
      const skipped = listRestorableOperatorSkips(db, job);
      const body: UpcomingFiresResponse = { fires, skipped };
      res.json(body);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid schedule' });
    }
  });

  /**
   * Operator skip.
   * Body: { fireAtMs: number, mode?: 'this' | 'through' }
   * - this (default): hole-punch — cancel only that occurrence; earlier ticks still run.
   * - through: jump clock past fireAtMs (and earlier); records skips for each slot.
   * Job stays enabled unless once exhausts. Does not consume pending_context.
   */
  app.post('/projects/:projectId/schedules/:jobId/skip', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;

    const body = req.body as { fireAtMs?: unknown; mode?: unknown };
    const fireAtMs = body?.fireAtMs;
    if (typeof fireAtMs !== 'number' || !Number.isFinite(fireAtMs)) {
      res.status(400).json({ error: 'fireAtMs required (finite number)' });
      return;
    }
    let mode: OperatorSkipMode = 'this';
    if (body?.mode !== undefined && body?.mode !== null) {
      if (body.mode !== 'this' && body.mode !== 'through') {
        res.status(400).json({ error: 'mode must be "this" or "through"' });
        return;
      }
      mode = body.mode;
    }

    if (isOnceExhausted(job)) {
      res.status(400).json({ error: 'once job is already exhausted; nothing left to skip' });
      return;
    }
    // Hole-punch may target a future fire after next; through may only target at/after next.
    // Neither may target strictly before the clock.
    if (fireAtMs < job.nextFireAt) {
      res.status(400).json({
        error: 'fireAtMs is before job.nextFireAt; cannot skip a fire already behind the clock',
      });
      return;
    }

    // Soft schedule check: must appear on the schedule from the clock or from now.
    try {
      const fromClock = computeUpcoming({
        scheduleKind: job.scheduleKind,
        scheduleExpr: job.scheduleExpr,
        timezone: job.timezone,
        afterMs: job.nextFireAt - 1,
        createdAtMs: job.createdAt,
        count: 50,
      });
      const fromNow = computeUpcoming({
        scheduleKind: job.scheduleKind,
        scheduleExpr: job.scheduleExpr,
        timezone: job.timezone,
        afterMs: Date.now(),
        createdAtMs: job.createdAt,
        count: 50,
      });
      const allowed = new Set<number>([job.nextFireAt, ...fromClock, ...fromNow]);
      if (!allowed.has(fireAtMs)) {
        res.status(400).json({ error: 'fireAtMs is not an upcoming fire for this job' });
        return;
      }
      // Already an active hole?
      if (getActiveOperatorSkipSet(db, job).has(fireAtMs)) {
        res.status(400).json({ error: 'fireAtMs is already operator-skipped' });
        return;
      }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid schedule' });
      return;
    }

    let created: ReturnType<typeof recordOperatorSkipThis>;
    let next: number;
    try {
      if (mode === 'through') {
        created = recordOperatorSkipsThrough(db, job, fireAtMs);
        next = recomputeNextFireAfterSkipChange(db, job, { advancePastMs: fireAtMs });
      } else {
        // Hole-punch: only this slot.
        created = recordOperatorSkipThis(db, job.id, fireAtMs);
        if (fireAtMs === job.nextFireAt) {
          // Skipping the immediate next advances the clock over this hole (and any consecutive).
          next = recomputeNextFireAfterSkipChange(db, job, { advancePastMs: fireAtMs });
        } else {
          // Future hole — clock stays; claim path / nextNonSkipped will jump over it later.
          next = job.nextFireAt;
        }
      }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid schedule' });
      return;
    }

    setNextFireAt(db, job.id, next);
    // Once: any skip of the single slot exhausts + disables (mirror claim).
    // next is always ONCE_EXHAUSTED_MS after skipping the only fire — no re-ensure needed.
    if (job.scheduleKind === 'once') {
      setJobEnabled(db, job.id, false);
    }

    const updated = getJob(db, job.id) ?? job;
    const last = created[created.length - 1];
    broadcast(job.projectId, job.id, last
      ? { runId: last.id, runStatus: 'skipped' }
      : undefined);
    res.json({ job: toDetail(db, updated) });
  });

  /**
   * Operator unskip: clear one operator_skip hole.
   * Pulls next_fire_at back when the restored slot is earlier than the current clock.
   * Re-enables exhausted once jobs. Does not consume pending_context.
   */
  app.post('/projects/:projectId/schedules/:jobId/unskip', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;

    const body = req.body as { fireAtMs?: unknown };
    const fireAtMs = body?.fireAtMs;
    if (typeof fireAtMs !== 'number' || !Number.isFinite(fireAtMs)) {
      res.status(400).json({ error: 'fireAtMs required (finite number)' });
      return;
    }

    const restorable = listRestorableOperatorSkips(db, job);
    if (!restorable.includes(fireAtMs)) {
      res.status(400).json({
        error: 'fireAtMs is not a restorable operator-skipped fire for this job',
      });
      return;
    }

    // Per-slot undo only.
    markOperatorSkipUndone(db, job.id, fireAtMs);

    const next = recomputeNextFireAfterSkipChange(db, job, { preferFireAtMs: fireAtMs });
    setNextFireAt(db, job.id, next);

    // Once: re-arm when restoring the one-shot slot.
    if (job.scheduleKind === 'once' && next < ONCE_EXHAUSTED_MS) {
      setJobEnabled(db, job.id, true);
    }

    const updated = getJob(db, job.id) ?? job;
    broadcast(job.projectId, job.id);
    res.json({ job: toDetail(db, updated) });
  });

  // Operator cookie alias for step rewrite (same body as agent PUT /schedules/:jobId/steps).
  // Agent dual-auth path stays at /schedules/:jobId/steps; this is for the web UI under requireAuth.
  app.put('/projects/:projectId/schedules/:jobId/steps', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const parsed = parseStepWrites(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const project = getProject(db, job.projectId);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }
    // Step replace does not change the profile — skip hostView (same as agent putSteps).
    const targetCheck = validateScheduleTarget(db, {
      project,
      executionMode: job.executionMode,
      profileId: job.profileId,
      boundConversationId: job.boundConversationId,
      templateName: job.templateName,
      steps: parsed.steps,
      workdir: job.workdir,
      agentMayComplete: job.agentMayComplete,
    });
    if (!targetCheck.ok) {
      res.status(targetCheck.status).json({
        error: targetCheck.error,
        ...(targetCheck.code ? { code: targetCheck.code } : {}),
        ...(targetCheck.reason ? { reason: targetCheck.reason } : {}),
      });
      return;
    }
    const steps = replaceSteps(db, job.id, parsed.steps);
    broadcast(job.projectId, job.id);
    res.json({ steps });
  });

  app.post('/projects/:projectId/schedules/:jobId/steps/complete-all', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const steps = completeAllSteps(db, job.id);
    broadcast(job.projectId, job.id);
    res.json({ steps });
  });

  app.patch('/projects/:projectId/schedules/:jobId/steps/:stepId', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const parsed = parseStepPatch(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const result = patchStep(db, job.id, String(req.params.stepId), parsed.patch);
    if (!result.ok) {
      res.status(404).json({ error: 'no such step on this job' });
      return;
    }
    broadcast(job.projectId, job.id);
    res.json({
      step: result.step,
      ...(result.promoted.length > 0 ? { promoted: result.promoted } : {}),
    });
  });

  app.post('/projects/:projectId/schedules/:jobId/steps/:stepId/retry', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;
    const result = retryStep(db, job.id, String(req.params.stepId));
    if (!result.ok) {
      if (result.reason === 'not_found') {
        res.status(404).json({ error: 'no such step on this job' });
        return;
      }
      res.status(409).json({ error: 'step is not blocked or running' });
      return;
    }
    broadcast(job.projectId, job.id);
    res.json({ step: result.step });
  });

  // Operator cookie: set/clear pending context; may also toggle carryContextEnabled.
  app.put('/projects/:projectId/schedules/:jobId/pending-context', (req, res) => {
    const db = getDb();
    const job = loadJobForProject(db, req.params.projectId, req.params.jobId, res);
    if (!job) return;

    const parsed = parsePendingContextBody(req.body, { allowFlag: true });
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    const updated = applyPendingContext(db, job, {
      text: parsed.text,
      source: 'operator',
      carryContextEnabled: parsed.carryContextEnabled,
    });
    broadcast(job.projectId, job.id);
    res.json({ job: toDetail(db, updated) });
  });
}
