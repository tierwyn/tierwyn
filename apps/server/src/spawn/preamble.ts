import type { ResolvedAgentSearchScope, ResolvedCapabilityProfile, SpawnTemplate, SpawnTemplateRole } from '@tierwyn/shared';
import { PERMISSION_CAPABLE_ADAPTERS, interactionModeRequiresPermissionCapable, profileAllowsCapability } from '@tierwyn/shared';
import { rulesFpExtra, rulesLines, type RulesView } from './rules.js';

/**
 * Prose prepended to a parent agent's prompt when its conversation has a
 * template. Gives the agent (1) its roster and (2) a copy-paste curl block with
 * the token + parent id already filled in — the agent edits only role + file path.
 */
/** Default parent-side instructions appended after the roster/curl block.
 *  Replaced wholesale when SpawnTemplate.delegationInstructions is set.
 *  Child-side RESULT protocol lives in childProtocolLines() so a child
 *  without a spawn template still sees it. */
export const DEFAULT_DELEGATION_INSTRUCTIONS = [
  'When composing the child task, always instruct the child to end its response with a structured summary under a "## Result" heading. That summary must list: (1) every file it touched with its full path, (2) key decisions it made and why, (3) anything you as the parent need to know to continue. Explicitly forbid terse acknowledgements ("Done", "OK", "Completed", "Finished") as the entire response. Why this matters: once a child finishes it cannot be queried again — the prose it returns in that one response is your only channel back to what it did.',
  'If the child\'s task involves producing a plan, specification, or any multi-step artifact, instruct it to write that artifact to a file (e.g. a .md file at a sensible path in the project) rather than inlining the full content in its response. It must include the file path in the ## Result summary so you — and any subsequent child — can read or reference the file directly instead of reconstructing the plan from conversational prose.',
].join('\n');

/** Child-only RESULT protocol. Rendered in both full builders when this
 *  conversation has a parent; kept out of roots. Not affected by
 *  template.delegationInstructions. */
function childProtocolLines(selfId: string, parentId: string): string[] {
  return [
    'IF YOU ARE THE CHILD/DELEGATE executing a task: your result reaches your parent through a ONE-SHOT upstream notify that fires once, when the spawn watcher settles on your first terminal turn. If your run is interrupted, stalls, the server restarts, or your parent received a premature/partial "◀ result:", assume your parent did NOT get your final answer. There is no automatic retry.',
    'Therefore, on your FINISHING turn: (1) always end with a complete "## Result" section, and (2) ALSO write the same result to `.tierwyn/delegates/<role>-<slug>-RESULT.md` so it survives even if the notify was missed. State in "## Result" that you wrote this file and give its path.',
    'Do NOT count on messaging your parent over HTTP. POST /spawn/.../message reaches STRICT DESCENDANTS; aimed at your own parent it 403s unless a specific upward permission has been granted to you, and if it had been, this preamble would say so explicitly below. Do not invent curls targeting your parent id on the assumption it might work. Your guaranteed channels upward are exactly: the one-shot notify, your "## Result", and the RESULT.md file — report through those regardless.',
    `If you suspect the notify was missed, end your turn telling the operator plainly: "Parent notify may have been missed — re-fetch my result via GET /spawn/${selfId}/result?parentConversationId=${parentId}, or read .tierwyn/delegates/<role>-<slug>-RESULT.md." Use the ids injected into your preamble rather than guessing.`,
  ];
}

function helpersGlossary(canSpawn: boolean): string[] {
  if (canSpawn) {
    return [
      '',
      '**Delegates vs helpers.** A *delegate* is a separate Tierwyn conversation you spawn via `/spawn` from the roster above: any roster model, its own transcript, reports back by notify + `## Result`. A *helper* is your own CLI\'s built-in subagent tool (e.g. Claude Code `Agent`/`Task`): same model, runs inside your process, invisible to Tierwyn\'s spawn tree. Use helpers for quick in-process lookups; use delegates when the operator or roster guidance calls for a specific model, a separate transcript, or parallel long work. When the operator says "delegate" or "spawn", they mean a Tierwyn delegate. More: `GET /agent/help/helpers`.',
    ];
  }
  return [
    '',
    '**Delegates vs helpers.** A *helper* is your own CLI\'s built-in subagent tool (e.g. Claude Code `Agent`/`Task`): same model, runs inside your process, invisible to Tierwyn\'s spawn tree. Use helpers for quick in-process lookups. This conversation cannot spawn delegates. More: `GET /agent/help/helpers`.',
  ];
}

function helpIndexLine(port: number, topics: string[]): string[] {
  if (topics.length === 0) return [];
  return [
    '',
    `Syntax on demand (loopback, no auth): \`GET http://127.0.0.1:${port}/agent/help/<topic>\` — ${topics.join(', ')}.`,
  ];
}

/** Roles the full spawn preamble actually teaches, after capability filtering.
 *  Shared with the fingerprint payload so hash and roster cannot drift. */
export function filterRolesForMode(
  template: SpawnTemplate,
  parentInteractionMode?: 'bypass' | 'questions' | 'prompt',
  resolveAgentType?: (profileId: string) => string | undefined,
  isAgentUsable?: (agentType: string) => boolean,
): SpawnTemplateRole[] {
  const permissionGated = interactionModeRequiresPermissionCapable(parentInteractionMode);
  let roles = template.roles;
  if (permissionGated && resolveAgentType) {
    roles = roles.filter((r) => PERMISSION_CAPABLE_ADAPTERS.has(resolveAgentType(r.profileId) ?? ''));
  }
  if (isAgentUsable && resolveAgentType) {
    roles = roles.filter((r) => {
      const t = resolveAgentType(r.profileId);
      if (!t) return true;
      return isAgentUsable(t);
    });
  }
  return roles;
}

/** Canonical payload hashed into the spawn fingerprint. Token, parent id, and
 *  port are deliberately absent — they rotate every session without changing
 *  what the agent was taught. */
/** Mesh fingerprint extras. Keys are ABSENT when the matching setting is off —
 *  present-and-false would invalidate every conversation's hash on deploy. */
/** Search is advertised only when the memory capability would also pass. */
function searchAdvertised(
  s?: ResolvedAgentSearchScope,
  memoryEnabled?: boolean,
): s is ResolvedAgentSearchScope & { effective: 'project' | 'all' } {
  return !!memoryEnabled && !!s && s.effective !== 'off';
}

/** Search fingerprint extra. Absent when off/omitted or memory is not allowed so hashes stay aligned with emitted lines.
 *  `ssc: 1` is present only when sandbox/remote capped `all` → `project`, so uncapped hashes stay byte-identical. */
export function searchFpExtra(
  s?: ResolvedAgentSearchScope,
  memoryEnabled?: boolean,
): { ss?: 'project' | 'all'; ssc?: 1 } {
  if (!searchAdvertised(s, memoryEnabled)) return {};
  return { ss: s.effective, ...(s.cappedBySandbox ? { ssc: 1 } : {}) };
}

export function meshFpExtras(args: {
  meshAwareness?: 'off' | 'subtree';
  meshMessaging?: 'off' | 'tree';
  meshEdgeSetHash?: string;
}): { ma?: 'subtree'; mm?: 'tree'; me?: string } {
  const extra: { ma?: 'subtree'; mm?: 'tree'; me?: string } = {};
  if (args.meshAwareness === 'subtree') extra.ma = 'subtree';
  if (args.meshMessaging === 'tree') {
    extra.mm = 'tree';
    extra.me = args.meshEdgeSetHash ?? '';
  }
  return extra;
}

export function spawnFpPayload(args: {
  template: SpawnTemplate;
  spawnApprovalRequired?: boolean;
  parentInteractionMode?: 'bypass' | 'questions' | 'prompt';
  resolveAgentType?: (profileId: string) => string | undefined;
  scheduleCreate?: { projectId: string };
  /** Hash of enabled agent-callable plugin caps. Default '' so omitted callers stay stable. */
  pluginSetHash?: string;
  meshAwareness?: 'off' | 'subtree';
  meshMessaging?: 'off' | 'tree';
  meshEdgeSetHash?: string;
  /** Current designation catalogue. Absent from the hash when omitted. */
  designations?: string[];
  /** Drop roles whose resolved agent type is not usable (e.g. grok-bot down). */
  isAgentUsable?: (agentType: string) => boolean;
  selfTimer?: { conversationId: string; isChild: boolean };
  globalTasks?: { conversationId: string; isChild: boolean };
  /** Operator rules view; undefined when none apply. */
  operatorRules?: RulesView;
  markupHint?: MarkupHint;
  /** Agent history search scope. Hashed only when project|all and memory is allowed. */
  searchScope?: ResolvedAgentSearchScope;
  /** Same gate as memory lines — search is part of the memory capability. */
  memoryEnabled?: boolean;
}): {
  t: string;
  r: [string, string, string][];
  i: string;
  a: boolean;
  m: string;
  s: boolean;
  p: string;
  d?: string[];
  ma?: 'subtree';
  mm?: 'tree';
  me?: string;
  st?: 1 | 2;
  gt?: 1 | 2;
  rules?: string;
  mk?: MarkupHint;
  ss?: 'project' | 'all';
  ssc?: 1;
} {
  const filtered = filterRolesForMode(args.template, args.parentInteractionMode, args.resolveAgentType, args.isAgentUsable);
  return {
    t: args.template.name,
    r: filtered.map((r) => [r.role, r.profileId, r.when]),
    i: args.template.delegationInstructions?.trim() ?? '',
    a: args.spawnApprovalRequired ?? false,
    m: args.parentInteractionMode ?? 'bypass',
    s: !!args.scheduleCreate,
    p: args.pluginSetHash ?? '',
    ...(args.designations && args.designations.length > 0 ? { d: args.designations } : {}),
    ...meshFpExtras(args),
    ...(args.selfTimer ? { st: args.selfTimer.isChild ? 2 : 1 } : {}),
    ...(args.globalTasks ? { gt: args.globalTasks.isChild ? 2 : 1 } : {}),
    ...rulesFpExtra(args.operatorRules),
    ...(args.markupHint ? { mk: args.markupHint } : {}),
    ...searchFpExtra(args.searchScope, args.memoryEnabled),
  };
}


/** Agent-visible plugin capabilities, as returned by PluginHost.listForAgent(). */
export type AgentPlugins = Array<{
  id: string;
  name: string;
  help?: string;
  capabilities: Array<{ name: string; summary: string; usageProvider?: true }>;
}>;

/**
 * Filter the agent-visible plugin list down to a conversation's capability
 * profile. Capabilities the profile doesn't grant are dropped; plugins left
 * with zero capabilities are dropped. `minimal` ⇒ []. Used by
 * `GET /agent/plugins` — usageProvider caps stay when the grant allows them.
 */
export function filterAgentPlugins(plugins: AgentPlugins | undefined, profile: ResolvedCapabilityProfile): AgentPlugins {
  const scoped: AgentPlugins = [];
  for (const p of plugins ?? []) {
    const caps = p.capabilities.filter((c) => profileAllowsCapability(profile, p.id, c));
    if (caps.length > 0) scoped.push({ ...p, capabilities: caps });
  }
  return scoped;
}

/**
 * Preamble roster: same grant filter, then strip usageProvider capabilities
 * (usage data is reached through the single `usage · telemetry` router line).
 */
export function scopeAgentPlugins(plugins: AgentPlugins | undefined, profile: ResolvedCapabilityProfile): AgentPlugins {
  const scoped: AgentPlugins = [];
  for (const p of filterAgentPlugins(plugins, profile)) {
    const caps = p.capabilities.filter((c) => !c.usageProvider);
    if (caps.length > 0) scoped.push({ ...p, capabilities: caps });
  }
  return scoped;
}

/**
 * Capability routing roster for enabled, agent-callable Tierwyn plugins, plus
 * the single `usage · telemetry` router line when the profile grants usage.
 * Empty when the server exposes nothing. 'full' teaches the call shape once
 * (~110 tokens) on the first preamble / after a plugin-set change; 'stub' is
 * the one-line reminder on token-only resumes (~35 tokens). `usage` defaults
 * false so legacy callers render no usage line.
 */
export function pluginRosterLines(
  port: number,
  plugins?: AgentPlugins,
  mode: 'full' | 'stub' = 'full',
  usage = false,
): string[] {
  const active = (plugins ?? []).filter((p) => p.capabilities.length > 0);
  if (mode === 'stub') {
    if (active.length === 0 && !usage) return [];
    if (active.length === 0) {
      return [
        `Tierwyn server capabilities (use the new Bearer above): usage·telemetry — GET http://127.0.0.1:${port}/agent/usage[/<target>]`,
      ];
    }
    const names = active
      .flatMap((p) => p.capabilities.map((c) => `${p.id}·${c.name}`))
      .concat(usage ? ['usage·telemetry'] : [])
      .join(', ');
    const hasAnyHelp = active.some((p) => Boolean(p.help));
    const helpSuffix = hasAnyHelp ? ` · docs: GET http://127.0.0.1:${port}/agent/plugins/<id>/help` : '';
    const usageSuffix = usage ? ` · usage: GET http://127.0.0.1:${port}/agent/usage[/<target>]` : '';
    return [
      `Tierwyn server capabilities (use the new Bearer above): ${names} — POST http://127.0.0.1:${port}/agent/plugins/<id>/capabilities/<name>${helpSuffix}${usageSuffix}`,
    ];
  }
  if (active.length === 0 && !usage) return [];
  const lines = [
    "## Tierwyn server capabilities (enabled here — not your harness's plugins or skills)",
    'Prefer these over any local skill or CLI tool that requires its own API key.',
  ];
  if (active.length > 0) {
    lines.push(`Invoke: POST http://127.0.0.1:${port}/agent/plugins/<id>/capabilities/<name> (Headers: Authorization: Bearer <spawnToken>, Content-Type: application/json; JSON body)`);
  }
  for (const p of active) {
    for (const c of p.capabilities) {
      lines.push(`- ${p.id} · ${c.name} — ${c.summary}`);
    }
    if (p.help) {
      lines.push(`  Docs: GET http://127.0.0.1:${port}${p.help} (read once before first use)`);
    }
  }
  if (usage) {
    lines.push(`- usage · telemetry — quota/rate-limit windows for built-in agents and usage providers. All: GET http://127.0.0.1:${port}/agent/usage · one: GET http://127.0.0.1:${port}/agent/usage/<target> (target = agent type e.g. claude-code, or provider id e.g. zai-usage). Same Bearer. 6 calls/min.`);
  }
  return lines;
}

/** Full-preamble roster block: blank separator line + roster, or nothing. */
function rosterBlock(port: number, plugins?: AgentPlugins, usage = false): string[] {
  const lines = pluginRosterLines(port, plugins, 'full', usage);
  return lines.length > 0 ? ['', ...lines] : [];
}

function searchLines(mode: 'full' | 'stub', port: number, s: ResolvedAgentSearchScope): string[] {
  const note = s.effective === 'all'
    ? 'scope=all enabled'
    : s.cappedBySandbox
      ? 'this project only — sandbox active'
      : 'this project only';
  if (mode === 'stub') {
    return [`History search: GET http://127.0.0.1:${port}/agent/search?q=<words> (${note}; same Bearer; \`GET /agent/help/search\`).`];
  }
  const paren = s.effective === 'all'
    ? 'default: this project; scope=all enabled; same Bearer'
    : s.cappedBySandbox
      ? 'this project only — sandbox active; same Bearer'
      : 'this project only; same Bearer';
  return [
    '',
    `Conversation history search: GET http://127.0.0.1:${port}/agent/search?q=<words> (${paren}). Context fetch & options: \`GET /agent/help/search\`.`,
  ];
}

/** HTTP save/search instruction. Not hashed — token and port rotate every session. */
function memoryLines(mode: 'full' | 'stub', port: number, token: string): string[] {
  if (mode === 'stub') {
    return [`Project memories: GET http://127.0.0.1:${port}/agent/memory?q=<words> · POST same path {"kind":"gotcha|decision|fact","text":"..."} (same Bearer).`];
  }
  return [
    '',
    '## Project memories',
    `Search: GET http://127.0.0.1:${port}/agent/memory?q=<words>`,
    `Save: POST http://127.0.0.1:${port}/agent/memory {"kind":"gotcha|decision|fact","text":"..."}`,
    `Bearer: ${token}`,
    '',
    'Before debugging something unfamiliar, search first.',
    'Save only what a future agent could NOT learn by reading the code, CLAUDE.md or git log: a trap that cost you time, a decision whose *reason* is not visible in the code, or behaviour that contradicts what the code suggests.',
    'Do not save what you built, where something lives, default values, menu/layout order, or which files you touched — the code already says that.',
    'Test: would knowing this at the start have saved you real time? If not, skip it. Most turns should save nothing.',
    'One fact, 500 characters at most, understandable without this conversation. Never save secrets or task progress.',
    'If a save returns a similar memory yours replaces, supersede it.',
    `Found a memory that is wrong or out of date? Save the corrected text, then POST http://127.0.0.1:${port}/agent/memory/<old m_N>/supersede {"by":"<new m_N>"}. Never edit in place — the old one stays for the operator to review.`,
    'If an agent would need this before it knows to look, add "suggestRule":true,"ruleReason":"<one line>".',
  ];
}

/** Inline markup hint; the web parser lives in apps/web/src/remark/directives.ts. Static text per mode. */
export type MarkupHint = 'all' | 'chat';
function markupLines(mode?: MarkupHint): string[] {
  if (!mode) return [];
  const base = 'Optional inline markup (use sparingly for status, never inside code): `:color[text]{.ok}` (tokens: ok, warn, error, info, muted), `:mark[text]`, `:kbd[Ctrl+S]`, `:badge[v2]{.info}`.';
  const alerts = ' For callouts use GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!WARNING]`, `[!CAUTION]`) — fine anywhere.';
  return ['', (mode === 'chat'
    ? `${base} Chat replies only — never in files, commits, PRs or anything read outside Tierwyn (it shows as raw text there).`
    : `${base} Fine in chat and markdown files; not in commits or PRs (GitHub shows it as raw text).`) + alerts];
}

function selfTimerBlock(port: number, st?: { conversationId: string; isChild: boolean }): string[] {
  if (!st) return [];
  return [
    '',
    '## Self-timer (wake yourself later)',
    'Use only to wait out a rate-limit window or when the operator asked you to check back later — never as a polling loop. After creating it, end your turn. Any new prompt into this conversation cancels it, so don\'t rely on it while children run. One pending at a time, ≤8h, own conversation only.',
    `\`POST http://127.0.0.1:${port}/conversations/${st.conversationId}/timers/agent {text, fireInMs|fireAtMs}\`. Details: \`GET /agent/help/timer\`.`,
    ...(st.isChild ? ['A self-timer wake does NOT notify your parent. If your parent must see the resumed result, finish this turn with a ## Result saying when you plan to resume and let your parent defer you instead.'] : []),
  ];
}

function globalTasksBlock(port: number, gt?: { conversationId: string; isChild: boolean }): string[] {
  if (!gt) return [];
  return [
    '',
    "## Global task log (operator's cross-project view)",
    'Track any user request to accomplish or modify something, no matter how small (features, bug fixes, UI tweaks, refactoring, code changes). Only skip pure conversational chit-chat or informational questions that make no changes.',
    `Endpoints: \`GET|POST http://127.0.0.1:${port}/tasks/agent\`, \`PATCH http://127.0.0.1:${port}/tasks/agent/<id>\` (or \`/conversations/${gt.conversationId}/tasks/agent\`). Do NOT curl \`/tasks/<taskId>\` directly (that is the cookie-only operator route and will 401).`,
    'Follow these 3 lifecycle steps for every piece of work: (1) check open tasks, create if none match; (2) PATCH progress/testing at milestones; (3) PATCH `status:"completed"` when done — crucial for the ≤3 open-task limit.',
    `At most 3 open tasks per conversation. ${gt.isChild
      ? "Children: record your own sub-task; keep it narrower than your parent's."
      : 'Children: report to your parent through ## Result — your parent owns the task.'} Curls: \`GET /agent/help/tasks\`.`,
  ];
}

export function buildDelegationPreamble(args: {
  template: SpawnTemplate;
  parentConversationId: string;
  spawnToken: string;
  port: number;
  spawnApprovalRequired?: boolean;
  /** When non-bypass, bypass-only roles are omitted from the roster. */
  parentInteractionMode?: 'bypass' | 'questions' | 'prompt';
  /** Resolve a profileId to its agentType for capability filtering. */
  resolveAgentType?: (profileId: string) => string | undefined;
  /** Label of the profile the PARENT conversation runs as; omitted for roots. */
  parentProfileLabel?: string;
  /**
   * When set, append a short schedule-create pointer (any depth).
   * Full docs live on GET /agent/schedule-help — do not dump curls here.
   */
  scheduleCreate?: { projectId: string };
  /** The child's own conversation id + its parent's — so a delegate can cite them
   *  in its ## Result / RESULT.md when the one-shot notify may have been missed. */
  selfConversationId?: string;
  selfParentConversationId?: string;
  /** Agent-visible plugin capabilities (PluginHost.listForAgent()). Rendered
   *  as a capability routing roster when non-empty. Pass the profile-scoped
   *  list (scopeAgentPlugins) so the roster matches the token's grant. */
  plugins?: AgentPlugins;
  /** Whether the conversation's profile grants the usage telemetry surface;
   *  renders the single `usage · telemetry` router line. Defaults false. */
  usage?: boolean;
  meshAwareness?: 'off' | 'subtree';
  meshMessaging?: 'off' | 'tree';
  /** Current designation catalogue. Omitted = no chip teaching. */
  designations?: string[];
  isAgentUsable?: (agentType: string) => boolean;
  selfTimer?: { conversationId: string; isChild: boolean };
  globalTasks?: { conversationId: string; isChild: boolean };
  /** When true, append the HTTP save/search instruction (setting on + profile grant). */
  memoryEnabled?: boolean;
  operatorRules?: RulesView;
  markupHint?: MarkupHint;
  searchScope?: ResolvedAgentSearchScope;
}): string {
  const { template, parentConversationId, spawnToken, port, spawnApprovalRequired = false,
    parentInteractionMode, resolveAgentType, parentProfileLabel, scheduleCreate,
    selfConversationId, selfParentConversationId, plugins, usage = false,
    meshAwareness = 'off', meshMessaging = 'off', designations, isAgentUsable, selfTimer, globalTasks,
    memoryEnabled, operatorRules, searchScope } = args;


  // ponytail: filter bypass-only roles only in full 'prompt' mode
  const filteredRoles = filterRolesForMode(template, parentInteractionMode, resolveAgentType, isAgentUsable);
  const omittedCount = template.roles.length - filteredRoles.length;

  const roster = filteredRoles
    .map((r) => `- **${r.role}** (${r.profileId}) — use when: ${r.when}`)
    .join('\n');
  const exampleRole = filteredRoles[0]?.role ?? 'REPLACE_WITH_ROLE_NAME';
  // Safe to interpolate unescaped: spawnToken is a server-issued UUID (no quotes) and parentConversationId is a server UUID. Not a general user-input sink.
  const curlRaw = [
    `curl -s -X POST http://127.0.0.1:${port}/spawn/raw \\`,
    `  -H 'Authorization: Bearer ${spawnToken}' \\`,
    `  -H 'Content-Type: text/plain' \\`,
    `  -H 'X-Spawn-Parent: ${parentConversationId}' \\`,
    `  -H 'X-Spawn-Role: ${exampleRole}' \\`,
    `  -H 'X-Spawn-Wait: false' \\`,
    `  -H 'X-Spawn-Notify: true' \\`,
    `  --data-binary @/abs/path/to/.tierwyn/delegates/ROLE-slug.md`,
  ].join('\n');
  const helpTopics = [
    'spawn', 'messaging', 'results', 'helpers',
    ...(selfTimer ? ['timer'] : []),
    ...(globalTasks ? ['tasks'] : []),
    ...(meshAwareness === 'subtree' ? ['mesh'] : []),
    ...(searchAdvertised(searchScope, memoryEnabled) ? ['search'] : []),
  ];
  const isChild = Boolean(selfConversationId && selfParentConversationId);
  return [
    'You can delegate sub-tasks to other agents. Available delegates:',
    roster,
    ...(omittedCount > 0 ? [
      '',
      `_(${omittedCount} bypass-only role${omittedCount > 1 ? 's' : ''} omitted — parent conversation is in permission mode '${parentInteractionMode}' and only permission-capable agents are available for delegation.)_`,
    ] : []),
    '',
    '**Roster lock:** the list above is a hard allow-list, enforced server-side. Spawn only a **role** or `profileId` / `X-Spawn-Profile` from this list. Do not invent roles, reuse profile ids from other conversations, or retry with a different profile hoping it is accepted.',
    ...helpersGlossary(true),
    '',
    ...(designations && designations.length > 0 ? [
      `Optional designation — pick one of: ${designations.join(', ')}. Add \`"designation":"<token>"\` on JSON spawn or \`-H 'X-Spawn-Designation: <token>'\` on raw. Omit if none. Do not invent spellings.`,
      '',
    ] : []),
    ...(parentProfileLabel ? [`_Your parent conversation is running as ${parentProfileLabel}._`, ''] : []),
    ...(selfConversationId ? [
      selfParentConversationId
        ? `_You are conversation \`${selfConversationId}\`; your parent is \`${selfParentConversationId}\`. Cite these in your ## Result if you suspect the notify was missed._`
        : `_You are conversation \`${selfConversationId}\`. Cite this in your ## Result if you suspect the notify was missed._`,
      '',
    ] : []),
    'To delegate, write the task to a file and post the file — the prompt never touches the shell, so quotes, parentheses, code, and newlines are all safe.',
    '',
    '1. Write the full task to a file with your Write tool (raw prose, no escaping):',
    '   `.tierwyn/delegates/<role>-<slug>.md`  (create the directory if needed)',
    '',
    designations && designations.length > 0
      ? '2. Post it — edit only the role, header `X-Spawn-Role`, optional `X-Spawn-Designation`, and the file path:'
      : '2. Post it — edit only the role, header `X-Spawn-Role`, and the file path:',
    '```bash',
    curlRaw,
    '```',
    '',
    'Never put task prose on the curl command line. Never paste multiline JSON into the shell.',
    'For "role", use the bolded name from the roster above (e.g. Master planner) — not the profileId in parens.',
    '',
    'Trivial one-liner? A short JSON form exists: `GET /agent/help/spawn`.',
    '',
    'Set `X-Spawn-Wait: true` (or `"wait": true` in JSON) only for short (<2min) tasks where you need the result to continue. Long tasks should run async — your turn will be resumed with the result when the child finishes.',
    'After an async spawn (`wait:false`; notify is the default — only an explicit `notifyParent:false` / `X-Spawn-Notify: false` silences it): **end your turn**. Do **not** `sleep`, busy-wait, loop on a timer, repeatedly call `GET /spawn/.../result`, or create a schedule job to "check the child later." A one-shot **upstream notify** already wakes this conversation when the child finishes. Use `GET /spawn/<child>/result` or the child\'s RESULT.md **only** on stall, a ⚠/degenerate marker, or a suspected missed notify — **once**, not on a polling loop.',
    ...(spawnApprovalRequired ? [
      '',
      '**Spawn approval is ON.** When you POST /spawn or /spawn/raw you will receive',
      '`202 { requestId, status: "pending" }` — NOT a running child. This is expected,',
      'not a failure: the operator must approve the request before the child starts.',
      'Do not retry or treat the 202 as an error. If you set `notifyParent: true`',
      '(or `X-Spawn-Notify: true`), your turn will be resumed with the child\'s result',
      'once the operator approves and the child completes. If the operator denies or',
      'your session ends first, you will be notified that the spawn was denied/expired',
      'and should stop waiting on it.',
    ] : []),
    'The Bearer is session-scoped; always use the one in the newest preamble/stub, never one copied from an earlier tool call. On 401 do not retry remembered UUIDs — ask the operator to re-inject.',
    '',
    template.delegationInstructions?.trim() || DEFAULT_DELEGATION_INSTRUCTIONS,
    ...(isChild ? ['', ...childProtocolLines(selfConversationId!, selfParentConversationId!)] : []),
    '',
    'Mid-turn narration (a `◀ result:` that is not the child\'s final `## Result`) is not completion. On ⚠, a stall, or a suspected missed notify, fetch the result **once** (`GET /spawn/<child>/result?parentConversationId=<you>`) or read the child\'s RESULT.md. Operator follow-ups typed into the child UI do not notify you. Curl: `GET /agent/help/results`.',
    '',
    '## Messaging an existing child (switch profile, steer, or resume)',
    'You can follow up, steer a running child, resume an idle child on another roster model, hand it off fresh/summary, or defer its wake-up: `POST /spawn/<childId>/message` with JSON `{parentConversationId, text}`. You are only woken by the reply if you pass `notifyParent:true` (or the spawn edge had notify on). Fields: `GET /agent/help/messaging`.',
    ...(scheduleCreate ? [
      '',
      '## Scheduler (opt-in — not a standing task)',
      'Do not create a schedule unless the operator asked to schedule (delay, recur, or verify later). Spawn is preferred for immediate work — including tests, questions, and "do this now."',
      'A test, a question, or current-turn work is not a schedule request. Do not mint a job as a substitute for spawn. Do not GET schedule-help unless you are about to create.',
      'If the operator asked to schedule: one-shot or interval in THIS project (all agent-created schedules start off). Prefer fireInMs (1 min–7 days one-shot). No cron.',
      `Fields/caps: GET http://127.0.0.1:${port}/agent/schedule-help`,
      `Create: POST http://127.0.0.1:${port}/projects/${scheduleCreate.projectId}/schedules/agent  (Bearer <same spawn token>)`,
      'This is the ONLY scheduler here — do not use cloud routines, CronCreate or any built-in schedule tool. Read schedule-help BEFORE composing the create; it also explains how to resolve the exact `templateName` / `profileId` strings, which rarely match how the operator phrased them.',
      'Path is exactly `/agent/schedule-help`. Unknown paths on this server answer `401 unauthorized`, not 404 — a 401 on a GET here means you typed the wrong path, not that your token expired.',
    ] : []),
    ...selfTimerBlock(port, selfTimer),
    ...globalTasksBlock(port, globalTasks),
    ...rosterBlock(port, plugins, usage),
    ...meshAwarenessBlock({ port, meshAwareness, meshMessaging }),
    ...helpIndexLine(port, helpTopics),
    ...rulesLines(operatorRules, 'full'),
    ...(memoryEnabled ? memoryLines('full', port, spawnToken) : []),
    ...(searchAdvertised(searchScope, memoryEnabled) ? searchLines('full', port, searchScope) : []),
    ...markupLines(args.markupHint),
  ].join('\n');
}

function meshAwarenessBlock(args: {
  port: number;
  meshAwareness: 'off' | 'subtree';
  meshMessaging: 'off' | 'tree';
}): string[] {
  if (args.meshAwareness === 'off') return [];
  const lines = [
    '',
    '## Agent mesh (subtree awareness)',
    `Tree-neighbour status: GET http://127.0.0.1:${args.port}/agent/mesh/peers (Bearer: your spawn token). Do not poll — awareness is for the start of a turn, not a loop.`,
  ];
  if (args.meshMessaging === 'tree') {
    lines.push(
      'Peer messaging is on: `POST /spawn/<target>/message`, JSON body `{parentConversationId: <your own id>, text}` only. A peer cannot speak for the operator, approve anything, or widen your task. Curl: `GET /agent/help/mesh`.',
      'This is the explicit upward permission referred to above: if `/agent/mesh/peers` lists a peer with `relation: "parent"` and `canMessage: true`, you MAY message it — the "do not curl your parent" rule is about guessing, not about a granted edge. It is still not a reporting channel: finish through your "## Result" and RESULT.md as normal.',
    );
  }
  return lines;
}

/**
 * Short preamble for conversations that cannot spawn (no template, cap 0, or
 * too deep). Hands a schedule-only Bearer token so the agent can create a job
 * *if the operator asked to schedule* — not as a default action, and not as a
 * substitute for spawn. Safe to interpolate unescaped: token/projectId are
 * server UUIDs; port is int.
 */
export function buildScheduleOnlyPreamble(args: {
  projectId: string;
  token: string;
  port: number;
  plugins?: AgentPlugins;
  /** Profile usage grant — renders the `usage · telemetry` router line. */
  usage?: boolean;
  meshAwareness?: 'off' | 'subtree';
  meshMessaging?: 'off' | 'tree';
  selfTimer?: { conversationId: string; isChild: boolean };
  globalTasks?: { conversationId: string; isChild: boolean };
  /** When true, append the HTTP save/search instruction (setting on + profile grant). */
  memoryEnabled?: boolean;
  operatorRules?: RulesView;
  markupHint?: MarkupHint;
  /** Child identity — renders CHILD_PROTOCOL when both are set. */
  selfConversationId?: string;
  selfParentConversationId?: string;
  searchScope?: ResolvedAgentSearchScope;
}): string {
  const { projectId, token, port, plugins, usage = false, meshAwareness = 'off', meshMessaging = 'off', selfTimer, globalTasks, memoryEnabled, operatorRules,
    selfConversationId, selfParentConversationId, searchScope } = args;
  const helpTopics = [
    'helpers',
    ...(selfTimer ? ['timer'] : []),
    ...(globalTasks ? ['tasks'] : []),
    ...(meshAwareness === 'subtree' ? ['mesh'] : []),
    ...(searchAdvertised(searchScope, memoryEnabled) ? ['search'] : []),
  ];
  const isChild = Boolean(selfConversationId && selfParentConversationId);
  return [
    ...helpersGlossary(false).slice(1),
    '',
    '## Scheduler (opt-in — not a standing task)',
    'Do not create a schedule unless the operator asked to schedule (delay, recur, or verify later). This conversation cannot spawn; that is not permission to schedule instead.',
    'A test, a question, or current-turn work is not a schedule request. Do not GET schedule-help unless you are about to create.',
    'If the operator asked to schedule: one-shot or interval in THIS project (no spawning; all agent-created schedules start off). Prefer fireInMs (1 min–7 days one-shot). No cron. This token schedules only — it cannot spawn agents.',
    `Full fields/caps: GET http://127.0.0.1:${port}/agent/schedule-help`,
    `Create: POST http://127.0.0.1:${port}/projects/${projectId}/schedules/agent`,
    `  Authorization: Bearer ${token}`,
    'This is the ONLY scheduler here — do not use cloud routines, CronCreate or any built-in schedule tool. Read schedule-help BEFORE composing the create; it explains how to resolve the exact `templateName` / `profileId` strings. Path is exactly `/agent/schedule-help`: unknown paths answer `401`, not 404, so a 401 on GET means wrong path, not a dead token.',
    ...(selfConversationId ? [
      '',
      selfParentConversationId
        ? `_You are conversation \`${selfConversationId}\`; your parent is \`${selfParentConversationId}\`. Cite these in your ## Result if you suspect the notify was missed._`
        : `_You are conversation \`${selfConversationId}\`. Cite this in your ## Result if you suspect the notify was missed._`,
    ] : []),
    ...(isChild ? ['', ...childProtocolLines(selfConversationId!, selfParentConversationId!)] : []),
    ...selfTimerBlock(port, selfTimer),
    ...globalTasksBlock(port, globalTasks),
    ...rosterBlock(port, plugins, usage),
    ...meshAwarenessBlock({ port, meshAwareness, meshMessaging }),
    ...helpIndexLine(port, helpTopics),
    ...rulesLines(operatorRules, 'full'),
    ...(memoryEnabled ? memoryLines('full', port, token) : []),
    ...(searchAdvertised(searchScope, memoryEnabled) ? searchLines('full', port, searchScope) : []),
    ...markupLines(args.markupHint),
  ].join('\n');
}


export function buildDelegationStub(args: {
  parentConversationId: string;
  spawnToken: string;
  port: number;
  scheduleCreate?: { projectId: string };
  selfConversationId?: string;
  selfParentConversationId?: string;
  /** Agent-visible plugin capabilities; rendered as a one-line stub roster. */
  plugins?: AgentPlugins;
  /** Profile usage grant — appends `usage·telemetry` to the stub names list. */
  usage?: boolean;
  selfTimer?: { conversationId: string; isChild: boolean };
  globalTasks?: { conversationId: string; isChild: boolean };
  /** When true, append the one-line HTTP reminder (setting on + profile grant). */
  memoryEnabled?: boolean;
  operatorRules?: RulesView;
  searchScope?: ResolvedAgentSearchScope;
}): string {
  const { parentConversationId, spawnToken, port, scheduleCreate,
    selfConversationId, selfParentConversationId, plugins, usage = false, selfTimer, globalTasks,
    memoryEnabled, operatorRules, searchScope } = args;
  const projectId = scheduleCreate?.projectId ?? '';
  return [
    '## Delegation + scheduler (rules unchanged — already in this session)',
    'Roster, curl format, and delegation rules are unchanged from the roster block earlier in this session. Reuse them verbatim; do not re-derive or guess.',
    `**New Bearer — every earlier token is dead, use only this one:** \`${spawnToken}\``,
    'Never reuse a Bearer or Authorization header copied from an earlier tool call in this conversation — earlier commands used now-dead tokens. Always take the Bearer from the latest stub above.',
    `Parent conversation \`${parentConversationId}\` · project \`${projectId}\` · port \`${port}\``,
    `Spawn: POST http://127.0.0.1:${port}/spawn/raw (file body) or /spawn (one-liner JSON). Message/steer child: POST http://127.0.0.1:${port}/spawn/<childId>/message (supports role/profileId/handoff/fireInMs/wait/notifyParent). Syntax: \`GET /agent/help/<topic>\`.`,
    `Schedule: POST http://127.0.0.1:${port}/projects/${projectId}/schedules/agent — only if the operator asked to schedule (delay, recur, verify later). Prefer spawn for immediate work. This is the ONLY scheduler: no cloud routines, no CronCreate, no harness schedule tool.`,
    ...(selfTimer ? [`Self-timer: POST http://127.0.0.1:${port}/conversations/${selfTimer.conversationId}/timers/agent {"text","fireInMs"|"fireAtMs"} (≤8h, own conversation only).`] : []),
    ...(globalTasks ? [`Global tasks: GET|POST http://127.0.0.1:${port}/tasks/agent, PATCH http://127.0.0.1:${port}/tasks/agent/<taskId> (Bearer: ${spawnToken}; ≤3 open, mark completed when done).`] : []),
    'If you cannot find the earlier roster block, say so and ask the operator to re-inject — do not invent roles or headers.',
    ...pluginRosterLines(port, plugins, 'stub', usage),
    ...rulesLines(operatorRules, 'stub'),
    ...(memoryEnabled ? memoryLines('stub', port, spawnToken) : []),
    ...(searchAdvertised(searchScope, memoryEnabled) ? searchLines('stub', port, searchScope) : []),
    ...(selfConversationId ? [
      selfParentConversationId
        ? `_You are conversation \`${selfConversationId}\`; your parent is \`${selfParentConversationId}\`._`
        : `_You are conversation \`${selfConversationId}\`._`,
    ] : []),
  ].join('\n');
}

export function buildScheduleOnlyStub(args: {
  projectId: string;
  token: string;
  port: number;
  plugins?: AgentPlugins;
  /** Profile usage grant — appends `usage·telemetry` to the stub names list. */
  usage?: boolean;
  selfTimer?: { conversationId: string; isChild: boolean };
  globalTasks?: { conversationId: string; isChild: boolean };
  /** When true, append the one-line HTTP reminder (setting on + profile grant). */
  memoryEnabled?: boolean;
  operatorRules?: RulesView;
  searchScope?: ResolvedAgentSearchScope;
}): string {
  const { projectId, token, port, plugins, usage = false, selfTimer, globalTasks, memoryEnabled, operatorRules, searchScope } = args;
  return [
    '## Scheduler (rules unchanged — already in this session)',
    `**New Bearer — every earlier token is dead, use only this one:** \`${token}\``,
    'Never reuse a Bearer or Authorization header copied from an earlier tool call in this conversation — earlier commands used now-dead tokens. Always take the Bearer from the latest stub above.',
    `Create: POST http://127.0.0.1:${port}/projects/${projectId}/schedules/agent — only if the operator asked to schedule (delay, recur, verify later). This conversation cannot spawn; that is not permission to schedule instead.`,
    `Fields/caps: GET http://127.0.0.1:${port}/agent/schedule-help — only when you are about to create. This is the ONLY scheduler: no cloud routines, no CronCreate, no harness schedule tool. Syntax: \`GET /agent/help/<topic>\`.`,
    ...(selfTimer ? [`Self-timer: POST http://127.0.0.1:${port}/conversations/${selfTimer.conversationId}/timers/agent {"text","fireInMs"|"fireAtMs"} (≤8h, own conversation only).`] : []),
    ...(globalTasks ? [`Global tasks: GET|POST http://127.0.0.1:${port}/tasks/agent, PATCH http://127.0.0.1:${port}/tasks/agent/<taskId> (Bearer: ${token}; ≤3 open, mark completed when done).`] : []),
    ...pluginRosterLines(port, plugins, 'stub', usage),
    ...rulesLines(operatorRules, 'stub'),
    ...(memoryEnabled ? memoryLines('stub', port, token) : []),
    ...(searchAdvertised(searchScope, memoryEnabled) ? searchLines('stub', port, searchScope) : []),
  ].join('\n');
}

