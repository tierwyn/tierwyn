import type { RemotePathCheck } from './remotePathHint.js';
import type {
  FileBrowserListing,
  ProjectsResponse, ConversationsResponse, TranscriptResponse,
  ActiveAgentResponse, ActiveSessionsResponse, CompactionSettingsResponse, CompactionSettings,
  GeneralSettings, NotificationSettingsResponse, PublicNotificationSettings,
  DecisionSettings, PublicDecisionSettings, CatalogueTag, TagCatalogueSettings,
  RetentionStats, RetentionPurgeResponse, ArchiveEntry, RetentionArchiveListResponse, RetentionRestoreResponse,
  RetentionArchiveDeleteResponse,
  VoiceSettings, WhisperConfigResponse, WhisperDownloadProgress, WhisperModel,
  VoiceTtsSettings,
  TtsRecording,
  TtsRecordingsListResponse,
  ConversationUsageResponse, AgentUsageSnapshot, ClaudeInsights, CodexInsights, AntigravityInsights, CursorInsights,
  PluginEnvelope, PluginInvocationRow, PluginsResponse,
  MeshPeer,
  Project, Conversation, Workdir, UpdateProjectRequest,
  MoveProjectRequest, MoveProjectResponse, MoveProjectErrorCode,
  LoginRequest, LoginResponse, SessionResponse,
  AgentsResponse, CatalogueResponse, AgentRecord, ModelRecord, ModelDescriptor,
  CreateAgentRequest, UpdateAgentRequest, CreateModelRequest, UpdateModelRequest,
  CreateCommandRequest, UpdateCommandRequest,
  PullModelsResponse, CommandRecord, CommandsResponse, PullCommandsResponse,
  UpgradeAgentResponse,
  VersionsRefreshResponse, AgentsInstallAllResponse, InstallAllMode,
  Summary, SummariesListResponse, Handoff, SpawnRequest, SpawnResponse, SpawnTemplate, RoleWhenPreset, SpawnRequestRow,
  CapabilityProfile,
  MemoryDto, MemoryCounts, ListMemoriesResponse,
  ConversationMcpView, McpControlAction, McpLiveStatus, McpNativeInstallInput, McpNativeInstallResult,
  McpNativeRemoveResult, McpNativeView, McpNativeWriteScope, McpSecretKind, McpServerDef, McpServerInput,
  BtwAskResponse, BtwListResponse, BtwSettings, BtwAvailability, BtwForkResponse,
  ConversationTimer, ConversationTimerResponse, ConversationTimersResponse,
  PendingTimersResponse,
  CreateConversationTimerRequest, UpdateConversationTimerRequest,
  Checkpoint, CheckpointsResponse, RewindConversationResponse,
  GetDraftResponse, PutDraftRequest, PutDraftResponse,
  EnhanceStartedResponse, UndoEnhanceResponse,
  ScheduleJob, ScheduleJobDetail, ScheduleRun, ScheduleStep, StepStatus,
  CreateScheduleJobRequest, PatchScheduleJobRequest, PatchScheduleStepsRequest,
  UpcomingFiresResponse,
  EnhanceSettings, EnhanceMode, EnhanceConfigResponse,
  DirectLlmProfile,
  DirectLlmTestResult,
  SidecarLlmSettings,
  VoiceCleanupProvider,
  SchedulePack,
  PromptCollectionEntry,
  GitWorkingTreeStatus,
  GitWorkingTreePathRequest,
  GitWorkingTreeCommitRequest,
  GitWorkingTreeCommitMessageRequest,
  GitWorkingTreePushRequest,
  GitWorkingTreePushResponse,
  GitHistoryResponse,
  GitCommitDetail,
  GitCommitDiffResponse,
  GitCommitFileResponse,
  GitBranchRef,
  GitBranchesResponse,
  GitSwitchBranchRequest,
  GitCreateBranchRequest,
  GitStashRequest,
  ProjectBrowseRoots,
  ProjectBrowseListing,
  ProjectBrowseStat,
  GitWorkingTreeCtxRequest,
  GitBranchOpResponse,
  GitSyncResponse,
  GitCreateWorktreeRequest,
  GitCreateWorktreeResponse,
  GitBranchDiffResponse,
  SystemResources,
  GrokBotLifecycleStatus,
  GlobalTasksResponse,
  GlobalTaskCounts,
  GlobalTaskStatus,
  GlobalTaskDto,
  GlobalTaskView,
  GlobalTasksSettings,
  PendingHandoffMode,
  RulePreset,
  ConversationRulesResponse,
  ProjectRulesResponse,
  RemoteHostView,
  SandboxSettings,
  SubtreeTimeSummary,
  EffortPreference,
} from '@tierwyn/shared';
import type { ScheduleCalendarResponse } from './scheduleCalendar.js';
import { modelResourcePath } from './cataloguePaths.js';

/** Wire shape from GET/POST /settings/sidecar-llm capableAdapters. */
export interface OneShotCapableAdapter {
  type: string;
  label: string;
  supportsToolsOff: boolean;
  supportsReadOnly: boolean;
}

export interface TagCatalogueResponse {
  builtins: readonly CatalogueTag[];
  catalogue: TagCatalogueSettings;
}

export interface DesignationCatalogue {
  builtins: string[];
  custom: string[];
  catalogue: string[];
}

const base = '';
/** Same-origin API prefix used by fetch helpers and sendBeacon flush. Empty in
 *  Vite (proxied); export so InputBar beacon can reuse it. */
export const apiBase = base;

/** Thrown when the server returns 401 (session expired / not authenticated). */
export class UnauthorizedError extends Error {
  constructor(path: string) { super(`GET ${path} -> 401`); this.name = 'UnauthorizedError'; }
}

export class PackFileConflictError extends Error {
  constructor(readonly conflicts: string[], message = 'pack file conflict') {
    super(`${message}: ${conflicts.join(', ')}`);
    this.name = 'PackFileConflictError';
  }
}

/** Per-agent vault env metadata — values themselves are never returned. */
export interface AgentEnvVar { agentType: string; name: string; updatedAt: number }
export interface AgentEnvList {
  vaultAvailable: boolean;
  vaultUnavailableReason?: string;
  vars: AgentEnvVar[];
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${base}${path}`, { credentials: 'include', signal, cache: 'no-store' });
  if (r.status === 401) throw new UnauthorizedError(path);
  if (!r.ok) {
    const err = new Error(`GET ${path} -> ${r.status}`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json() as Promise<T>;
}
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (r.status === 401) throw new UnauthorizedError(path);
  if (!r.ok) {
    let payload: { error?: string; conflicts?: unknown } = {};
    try { payload = await r.json() as { error?: string; conflicts?: unknown }; } catch { /* ignore */ }
    const conflicts = Array.isArray(payload.conflicts)
      ? payload.conflicts.filter((c): c is string => typeof c === 'string')
      : [];
    if (r.status === 409 && conflicts.length > 0) {
      throw new PackFileConflictError(conflicts, payload.error || 'pack file conflict');
    }
    if (conflicts.length > 0) {
      throw new Error(`${payload.error || 'pack file conflict'}: ${conflicts.join(', ')}`);
    }
    throw new Error(payload.error || `POST ${path} -> ${r.status}`);
  }
  return r.json() as Promise<T>;
}
async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (r.status === 401) throw new UnauthorizedError(path);
  if (!r.ok) {
    let detail = '';
    try {
      const payload = await r.json() as { error?: string; installHint?: string };
      detail = payload.error ?? '';
      if (payload.installHint) {
        detail = detail ? `${detail} — ${payload.installHint}` : payload.installHint;
      }
    } catch { /* ignore */ }
    throw new Error(detail || `PATCH ${path} -> ${r.status}`);
  }
  return r.json() as Promise<T>;
}
async function del(path: string): Promise<void> {
  const r = await fetch(`${base}${path}`, { method: 'DELETE', credentials: 'include' });
  if (r.status === 401) throw new UnauthorizedError(path);
  if (!r.ok) throw new Error(`DELETE ${path} -> ${r.status}`);
}

async function delJson<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`, { method: 'DELETE', credentials: 'include' });
  if (r.status === 401) throw new UnauthorizedError(path);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json() as { error?: string }).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `DELETE ${path} -> ${r.status}`);
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}
async function putJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (r.status === 401) throw new UnauthorizedError(path);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json() as { error?: string }).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `PUT ${path} -> ${r.status}`);
  }
  return r.json() as Promise<T>;
}

/** Shape of GET /projects/:id/schedules/tree (not yet in shared). */
export interface ScheduleTreeRunEntry {
  run: ScheduleRun;
  conversation?: Conversation;
  descendants: Conversation[];
}
export interface ScheduleTreeJobEntry {
  job: ScheduleJob;
  runs: ScheduleTreeRunEntry[];
}
export interface ScheduleTreeResponse {
  jobs: ScheduleTreeJobEntry[];
}

/** Artificial Analysis suggest — local to TemplateSettings, not in shared. */
export type AaStatus = {
  configured: boolean;
  source: 'vault' | 'env' | null;
  vaultAvailable: boolean;
  tier: string | null;
  fetchedAt: number | null;
};
export type AaModelListItem = { slug: string; name: string; intel: number | null };
export type AaSuggestResponse = {
  draft: string | null;
  source: 'llm' | 'template';
  llmError?: string;
  match: 'override' | 'exact' | 'alias' | 'base' | 'none';
  aaModel: { slug: string; name: string } | null;
  candidates: AaModelListItem[];
  metrics: {
    intel: number | null;
    eng: number | null;
    priceIn: number | null;
    priceOut: number | null;
    tps: number | null;
  } | null;
  tier: string;
  stale?: true;
};

/** Auth — these three never throw UnauthorizedError by design (used pre/post login). */
export const auth = {
  session: () => fetch(`${base}/auth/session`, { credentials: 'include' })
    .then((r) => r.json() as Promise<SessionResponse>),

  login: async (password: string): Promise<{ ok: true } | { error: string; retryAfter?: number }> => {
    const body: LoginRequest = { password };
    let r: Response;
    try {
      r = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
      });
    } catch {
      // Network failure / backend unreachable — never leave the caller hanging.
      return { error: 'Cannot reach the server. Is the backend running?' };
    }
    if (r.ok) return r.json() as Promise<LoginResponse>;
    if (r.status === 429) {
      const retryAfter = Number(r.headers.get('Retry-After') ?? '60');
      const data = await r.json().catch(() => ({})) as { error?: string };
      return { error: data.error ?? 'Too many attempts', retryAfter };
    }
    const data = await r.json().catch(() => ({})) as { error?: string };
    return { error: data.error ?? (r.status === 503 ? 'Authentication is not configured.' : 'Incorrect password') };
  },

  logout: () => fetch(`${base}/auth/logout`, { method: 'POST', credentials: 'include' })
    .then((r) => r.json() as Promise<{ ok: true }>),
};

export interface ConversationSearchMatch {
  eventId: string;
  snippet: string;
  ts: number;
  sender: 'user' | 'agent' | 'system' | 'helper';
}

export interface ConversationSearchHit {
  id: string;
  projectId: string;
  title: string;
  updatedAt: number;
  /** FW-12: most recent matching events.id. Optional on purpose — a server that
   *  predates FW-12 (or a hit with no indexable payload) just means "no jump". */
  eventId?: string;
  /** FW-12: <=160 chars of the matched event; shown as a row tooltip only. */
  snippet?: string;
  /** Present only when the request named `matchesPerConversation`. Newest first. */
  matches?: ConversationSearchMatch[];
}

/** Content search across prompt + assistant-message text. Title/description filtering stays
 *  client-side in Sidebar; this only adds ids the local filter cannot see.
 *  `projectId` scopes server-side (Sidebar "This project"); omit for all projects (Ctrl+K). */
export async function searchConversationContent(
  q: string,
  projectId?: string,
  opts?: { matchesPerConversation?: number; limit?: number },
): Promise<ConversationSearchHit[]> {
  let url = `/conversations/search?q=${encodeURIComponent(q)}`;
  if (projectId) url += `&projectId=${encodeURIComponent(projectId)}`;
  if (opts?.matchesPerConversation != null) url += `&matchesPerConversation=${opts.matchesPerConversation}`;
  if (opts?.limit != null) url += `&limit=${opts.limit}`;
  const res = await fetch(url, {
    credentials: 'include',
  });
  // 400 = unindexable query (all punctuation) — not an outage.
  if (res.status === 400) return [];
  if (res.status === 401) throw new UnauthorizedError('/conversations/search');
  if (!res.ok) throw new Error(`GET /conversations/search -> ${res.status}`);
  return (await res.json()) as ConversationSearchHit[];
}

/**
 * FW-17 backup DTOs. Deliberately declared here rather than in `@tierwyn/shared`
 * — the roster scopes FW-17 to server + web with no shared change (D16). Keep
 * these field-identical to `BackupEntry` in
 * `apps/server/src/repositories/backups.ts`.
 */
export interface BackupEntry {
  name: string;
  bytes: number;
  createdAt: number;
  kind: 'db' | 'full';
}

export interface BackupListResponse {
  items: BackupEntry[];
  audioBytes: number;
  audioFiles: number;
}

export const api = {
  activeSessions: (signal?: AbortSignal) =>
    getJson<ActiveSessionsResponse>('/sessions/active', signal),
  listProjects: () => getJson<ProjectsResponse>('/projects').then((r) => r.projects),
  createProject: (name: string, rootPath: string, remoteHostId?: string, cloneUrl?: string, createIfMissing?: boolean) =>
    postJson<{ project: Project }>('/projects', {
      name,
      rootPath,
      ...(remoteHostId ? { remoteHostId } : {}),
      ...(cloneUrl ? { cloneUrl } : {}),
      ...(createIfMissing ? { createIfMissing: true } : {}),
    }).then((r) => r.project),
  projectBrowseRoots: (remoteHostId?: string) =>
    getJson<ProjectBrowseRoots>(`/project-browse/roots${remoteHostId ? `?remoteHostId=${encodeURIComponent(remoteHostId)}` : ''}`),
  listProjectDirs: (args: { remoteHostId?: string; root: string; path: string }) => {
    const qs = new URLSearchParams({
      root: args.root,
      path: args.path,
      ...(args.remoteHostId ? { remoteHostId: args.remoteHostId } : {}),
    }).toString();
    return getJson<ProjectBrowseListing>(`/project-browse/list?${qs}`);
  },
  statLocalPath: (path: string, signal?: AbortSignal) =>
    getJson<ProjectBrowseStat>(`/project-browse/stat?path=${encodeURIComponent(path)}`, signal),
  statRemotePath: (hostId: string, path: string, signal?: AbortSignal) =>
    getJson<{ path: RemotePathCheck['path']; parent?: RemotePathCheck['parent'] }>(
      `/remote-hosts/${encodeURIComponent(hostId)}/stat-path?path=${encodeURIComponent(path)}`,
      signal,
    ),
  listRemoteHosts: () =>
    getJson<{ hosts: RemoteHostView[] }>('/remote-hosts').then((r) => r.hosts),
  createRemoteHost: (name: string, autoTrust = false) =>
    postJson<{
      host: RemoteHostView;
      token: string;
      oneLiner: string;
      oneLinerGithub: string;
      packageAvailable: boolean;
      insecureOrigin: boolean;
      expiresAt: number;
    }>('/remote-hosts', { name, autoTrust }),
  trustRemoteHost: (id: string) =>
    postJson<{ host: RemoteHostView }>(`/remote-hosts/${id}/trust`, {}).then((r) => r.host),
  patchRemoteHost: (id: string, patch: { name?: string; allowMcpSecrets?: boolean; allowAgentEnvSecrets?: boolean; disabled?: boolean; description?: string | null }) =>
    patchJson<{ host: RemoteHostView }>(`/remote-hosts/${id}`, patch).then((r) => r.host),
  refreshRemoteHost: (id: string) =>
    postJson<{ host: RemoteHostView }>(`/remote-hosts/${id}/refresh`, {}).then((r) => r.host),
  installRemoteAgent: (id: string, agentType: string) =>
    postJson<{ ok: true; started: true }>(`/remote-hosts/${id}/agents/${encodeURIComponent(agentType)}/install`, {}),
  loginRemoteAgent: (id: string, agentType: string) =>
    postJson<{ ok: true; started: true }>(`/remote-hosts/${id}/agents/${encodeURIComponent(agentType)}/login`, {}),
  cancelRemoteAgentLogin: (id: string, agentType: string) =>
    postJson<{ ok: true; cancelled: true }>(`/remote-hosts/${id}/agents/${encodeURIComponent(agentType)}/login/cancel`, {}),
  submitRemoteAgentLoginCode: (id: string, agentType: string, code: string) =>
    postJson<{ ok: true }>(`/remote-hosts/${id}/agents/${encodeURIComponent(agentType)}/login/code`, { code }),
  installAllRemoteAgents: (id: string, mode: InstallAllMode) =>
    postJson<AgentsInstallAllResponse>(`/remote-hosts/${id}/agents/install-all`, { mode }),
  updateRemoteHost: (id: string) =>
    postJson<{ ok: true; started?: boolean; upToDate?: boolean }>(`/remote-hosts/${id}/update`, {}),
  deleteRemoteHost: (id: string, opts?: { unbind?: boolean }) =>
    delJson<{ ok: true }>(`/remote-hosts/${id}${opts?.unbind ? '?unbind=1' : ''}`),
  deleteProject: (id: string) => del(`/projects/${id}`),
  renameProject: (id: string, name: string) =>
    patchJson<{ project: Project }>(`/projects/${id}`, { name }).then((r) => r.project),
  updateProject: (id: string, patch: UpdateProjectRequest) =>
    patchJson<{ project: Project }>(`/projects/${id}`, patch).then((r) => r.project),
  moveProject: async (
    id: string,
    body: MoveProjectRequest,
  ): Promise<
    | { ok: true; body: MoveProjectResponse }
    | { ok: false; status: number; error: string; code?: MoveProjectErrorCode; conversations?: { conversationId: string; title: string }[] }
  > => {
    const path = `/projects/${id}/move`;
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError(path);
    if (!r.ok) {
      let payload: { error?: string; code?: MoveProjectErrorCode; conversations?: { conversationId: string; title: string }[] } = {};
      try {
        payload = (await r.json()) as typeof payload;
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        status: r.status,
        error: payload.error || `POST ${path} -> ${r.status}`,
        code: payload.code,
        conversations: payload.conversations,
      };
    }
    const resBody = (await r.json()) as MoveProjectResponse;
    return { ok: true, body: resBody };
  },
  listConversations: (projectId: string, opts?: { includeArchived?: boolean }) =>
    getJson<ConversationsResponse>(`/projects/${projectId}/conversations${opts?.includeArchived ? '?includeArchived=1' : ''}`).then((r) => r.conversations),
  createConversation: (projectId: string, title: string, templateName?: string, spawnWorkdir?: Workdir, parentConversationId?: string, designation?: string, tags?: string[], capabilityProfile?: string) =>
    postJson<{ conversation: Conversation }>('/conversations', { projectId, title, templateName, spawnWorkdir, parentConversationId, designation, tags, capabilityProfile }).then((r) => r.conversation),
  renameConversation: (id: string, title: string) =>
    patchJson<{ conversation: Conversation }>(`/conversations/${id}`, { title }).then((r) => r.conversation),
  /** PATCH /conversations/:id with any combination of fields. Use this for
   *  template swaps; rename-only callers use renameConversation. */
  updateConversation: (id: string, patch: { title?: string; templateName?: string | null; spawnWorkdir?: Workdir | null; pinned?: boolean; archived?: boolean; description?: string | null; projectId?: string; tags?: string[]; designation?: string | null; capabilityProfile?: string | null; mcpServers?: string[] | null; disableNativeMcp?: boolean; disabledNativeMcp?: string[]; permissionMode?: 'bypass' | 'questions' | 'prompt' | null; effort?: EffortPreference | null; pendingHandoffMode?: PendingHandoffMode | null; rules?: string | null; rulePresetIds?: string[] | null; sandbox?: 'on' | 'off' | null }) =>
    patchJson<{ conversation: Conversation }>(`/conversations/${id}`, patch).then((r) => r.conversation),
  getConversationRules: (id: string) =>
    getJson<ConversationRulesResponse>(`/conversations/${id}/rules`),
  getSubtreeTime: (id: string, signal?: AbortSignal) =>
    getSubtreeTime(id, signal),
  getProjectRules: (id: string) =>
    getJson<ProjectRulesResponse>(`/projects/${id}/rules`),
  listRulePresets: (projectId?: string) =>
    getJson<{ presets: RulePreset[] }>(`/rule-presets${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) => r.presets),
  createRulePreset: (body: { name: string; description?: string; content: string; projectId?: string | null }) =>
    postJson<{ preset: RulePreset }>('/rule-presets', body).then((r) => r.preset),
  updateRulePreset: (id: string, body: { name?: string; description?: string | null; content?: string }) =>
    patchJson<{ preset: RulePreset }>(`/rule-presets/${id}`, body).then((r) => r.preset),
  deleteRulePreset: (id: string) =>
    delJson<{ scrubbed: { projects: number; conversations: number } }>(`/rule-presets/${id}`),
  regenerateConversationDescription: (id: string) =>
    postJson<{ conversation: Conversation }>(`/conversations/${id}/describe`, {}).then((r) => r.conversation),
  deleteConversation: (id: string) =>
    delJson<{ ok: boolean; deletedIds?: string[] }>(`/conversations/${id}`),
  /** FW-18: one gesture, N conversations. Always 200 on a well-formed request —
   *  read `results` for per-id outcomes; `deletedIds` is delete-only and
   *  includes cascaded spawn descendants. */
  bulkConversations: (body: {
    action: 'delete' | 'move' | 'pin' | 'unpin' | 'archive' | 'unarchive';
    ids: string[];
    projectId?: string;
  }) =>
    postJson<{
      results: { id: string; ok: boolean; error?: string; skipped?: string }[];
      deletedIds?: string[];
    }>('/conversations/bulk', body),
  forkConversation: (id: string, eventId: string, title?: string) =>
    postJson<{ conversation: Conversation }>(`/conversations/${id}/fork`, { eventId, title }).then((r) => r.conversation),
  /** FW-13: clone a whole conversation into a new root chat ("Copy of …"). */
  duplicateConversation: (
    id: string,
    opts?: { projectId?: string; includeTools?: boolean; title?: string },
  ) =>
    postJson<{ conversation: Conversation }>(`/conversations/${id}/duplicate`, opts ?? {})
      .then((r) => r.conversation),
  markConversationUnread: (id: string) =>
    postJson<{ ok: boolean }>(`/conversations/${id}/mark-unread`, {}),
  markConversationRead: (id: string) =>
    postJson<{ ok: boolean }>(`/conversations/${id}/mark-read`, {}),
  reissueSpawnToken: (conversationId: string) =>
    postJson<{ token: string; expiresAt: number; injected: boolean }>(
      `/conversations/${conversationId}/reissue-token`,
      {},
    ),
  markConversationsRead: (ids?: string[]) =>
    postJson<{ ok: boolean }>('/conversations/mark-read', { ids }),
  transcript: (conversationId: string) =>
    getJson<TranscriptResponse>(`/conversations/${conversationId}/transcript`).then((r) => r.events),
  transcriptPage: (
    conversationId: string,
    options: { tailTurns: number; before?: string },
  ): Promise<TranscriptResponse> => {
    const params = new URLSearchParams({ tailTurns: String(options.tailTurns) });
    if (options.before) params.set('before', options.before);
    return getJson<TranscriptResponse>(`/conversations/${conversationId}/transcript?${params.toString()}`);
  },
  summaries: (
    conversationId: string,
    opts?: { tree?: boolean },
  ): Promise<SummariesListResponse> =>
    getJson<SummariesListResponse>(
      `/conversations/${conversationId}/summaries${opts?.tree ? '?tree=1' : ''}`,
    ),
  handoffs: (conversationId: string) =>
    getJson<{ handoffs: Handoff[] }>(`/conversations/${conversationId}/handoffs`).then((r) => r.handoffs),
  checkpoints: (conversationId: string) =>
    getJson<CheckpointsResponse>(`/conversations/${conversationId}/checkpoints`).then((r) => r.checkpoints),
  getDraft: (conversationId: string) =>
    getJson<GetDraftResponse>(`/conversations/${conversationId}/draft`),
  putDraft: (
    conversationId: string,
    text?: string,
    attachments?: PutDraftRequest['attachments'],
    profileId?: string,
  ) =>
    putJson<PutDraftResponse>(`/conversations/${conversationId}/draft`, {
      ...(text !== undefined ? { text } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(profileId !== undefined ? { profileId } : {}),
    } satisfies PutDraftRequest),
  deleteDraft: (conversationId: string) =>
    // 204 No Content — del() tolerates empty body; delJson also handles 204 but del is simpler.
    del(`/conversations/${conversationId}/draft`),
  /** Arm/disarm auto-send for an in-flight whisper transcription. 404 = no slot. */
  armTranscribe: (
    conversationId: string,
    ctx: { profileId: string; agent: string; agentModel: string },
    armed = true,
  ) =>
    postJson<{ armed: boolean }>('/transcribe/arm', { conversationId, ...ctx, armed }),
  /** Abort an in-flight whisper job. 404 = already settled — treat as success. */
  cancelTranscribe: async (conversationId: string): Promise<{ cancelled: boolean }> => {
    const r = await fetch(`${base}/transcribe/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId }),
      credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError('/transcribe/cancel');
    if (r.status === 404) return { cancelled: false };
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json() as { error?: string }).error ?? ''; } catch { /* ignore */ }
      throw new Error(detail || `POST /transcribe/cancel -> ${r.status}`);
    }
    return r.json() as Promise<{ cancelled: boolean }>;
  },
  createCheckpoint: (conversationId: string, body: { eventId: string; label?: string; pinned?: boolean }) =>
    postJson<{ checkpoint: Checkpoint }>(`/conversations/${conversationId}/checkpoints`, body).then((r) => r.checkpoint),
  checkpointCodeDiff: (conversationId: string, checkpointId: string, mode?: 'restore' | 'captured') =>
    getJson<{ diff: string | null }>(`/conversations/${conversationId}/checkpoints/${checkpointId}/code-diff${mode ? `?mode=${mode}` : ''}`).then((r) => r.diff),
  rewindConversation: async (conversationId: string, body: {
    eventId: string;
    rewindConversation?: boolean;
    rewindCode?: boolean;
    confirmSharedCode?: boolean;
    createCheckpoint?: boolean;
  }): Promise<RewindConversationResponse> => {
    const r = await fetch(`${base}/conversations/${conversationId}/rewind`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError(`/conversations/${conversationId}/rewind`);
    const data = await r.json() as RewindConversationResponse & { error?: string };
    if (r.status === 409) {
      throw Object.assign(new Error(data.error ?? 'rewind-conflict'), { status: 409 as const, ...data });
    }
    if (!r.ok) throw new Error(`POST /conversations/${conversationId}/rewind -> ${r.status}`);
    return data;
  },
  /** v2: POST /conversations/:id/excise-turn — surgically remove ONE turn from
   *  the transcript and fork the native session (parentUuid rewired). turnIndex
   *  is 0-indexed over turns[]; the route converts to the 1-indexed helper. */
  exciseTurn: async (conversationId: string, body: { turnIndex: number; eventIds: string[] }): Promise<{ ok: boolean; deletedEvents: number; nativeSessionId: string }> => {
    const r = await fetch(`${base}/conversations/${conversationId}/excise-turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError(`/conversations/${conversationId}/excise-turn`);
    const data = await r.json() as { ok?: boolean; deletedEvents?: number; nativeSessionId?: string; error?: string };
    // 409 (live session / unsupported adapter) and 400 (single-turn / bad input)
    // both carry an actionable `error` — surface it on the thrown object.
    if (!r.ok) throw Object.assign(new Error(data.error ?? `excise-turn -> ${r.status}`), { status: r.status, ...data });
    return { ok: !!data.ok, deletedEvents: data.deletedEvents ?? 0, nativeSessionId: data.nativeSessionId ?? '' };
  },
  activeAgent: (conversationId: string, agentId?: string) =>
    getJson<ActiveAgentResponse>(
      `/conversations/${conversationId}/active-agent${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`,
    ),
  conversationUsage: (conversationId: string, fresh = false) =>
    getJson<ConversationUsageResponse>(`/conversations/${conversationId}/usage${fresh ? '?fresh=1' : ''}`).then((r) => r.usage),
  agentUsage: (fresh = false) =>
    getJson<{ agents: AgentUsageSnapshot[] }>(`/settings/agent-usage${fresh ? '?fresh=1' : ''}`)
      .then((r) => r.agents),
  listPlugins: () => getJson<PluginsResponse>('/plugins'),
  importPlugin: async (file: File): Promise<PluginsResponse> => {
    const fd = new FormData();
    fd.append('archive', file, file.name);
    const r = await fetch(`${base}/plugins`, {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
    if (r.status === 401) throw new UnauthorizedError('/plugins');
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
      throw new Error(detail || `POST /plugins -> ${r.status}`);
    }
    return r.json() as Promise<PluginsResponse>;
  },
  deletePlugin: (id: string): Promise<PluginsResponse> =>
    delJson<PluginsResponse>(`/plugins/${encodeURIComponent(id)}`),
  setPluginEnabled: (id: string, enabled: boolean) =>
    patchJson<PluginsResponse>(`/plugins/${encodeURIComponent(id)}`, { enabled }),
  setPluginCredential: (id: string, key: string, value: string) =>
    putJson<PluginsResponse>(
      `/plugins/${encodeURIComponent(id)}/credentials/${encodeURIComponent(key)}`,
      { value },
    ),
  clearPluginCredential: (id: string, key: string) =>
    delJson<PluginsResponse>(
      `/plugins/${encodeURIComponent(id)}/credentials/${encodeURIComponent(key)}`,
    ),
  pluginInvocations: (id: string, limit?: number) =>
    getJson<{ invocations: PluginInvocationRow[] }>(
      `/plugins/${encodeURIComponent(id)}/invocations${limit != null ? `?limit=${encodeURIComponent(String(limit))}` : ''}`,
    ),
  listMeshPeers: (conversationId: string) =>
    getJson<{ peers: MeshPeer[] }>(`/agent/mesh/peers?conversationId=${encodeURIComponent(conversationId)}`),
  listMeshEdges: () =>
    getJson<{ edges: Array<{
      id: string; treeRoot: string; fromConversation: string; toConversation: string;
      mintedBy: string; scope: string; createdAt: number; revokedAt: number | null;
      fromTitle?: string; toTitle?: string; fromDetail?: string; toDetail?: string; fromDescription?: string; toDescription?: string; relation?: string;
    }> }>('/mesh/edges'),
  listMeshMessages: () =>
    getJson<{ messages: Array<{
      id: number; ts: number; callerKind: string; fromConversation: string; toConversation: string;
      decision: string; hop: number; bytes: number; durationMs: number; error: string | null;
      fromTitle?: string; toTitle?: string; fromDetail?: string; toDetail?: string; fromDescription?: string; toDescription?: string; relation?: string;
    }> }>('/mesh/messages?limit=500'),
  mintMeshEdge: (body: { fromConversationId: string; toConversationId: string; allowReplies?: boolean }) =>
    postJson<{ edge: { id: string }; reverse?: { id: string } }>('/mesh/edges', body),
  revokeMeshEdge: (id: string) =>
    delJson<{ ok: boolean }>(`/mesh/edges/${encodeURIComponent(id)}`),
  /** Operator-cookie invoke of an agent plugin capability (envelope, not throw-on-error). */
  invokePluginCapability: async <T = unknown>(
    pluginId: string,
    name: string,
    input: unknown = {},
  ): Promise<PluginEnvelope<T>> => {
    const path = `/agent/plugins/${encodeURIComponent(pluginId)}/capabilities/${encodeURIComponent(name)}`;
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input ?? {}),
      credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError(path);
    try {
      return await r.json() as PluginEnvelope<T>;
    } catch {
      return { ok: false, error: `POST ${path} -> ${r.status}`, code: 'upstream_error', retryable: true };
    }
  },
  listMcpServers: () =>
    getJson<{ servers: McpServerDef[]; vaultAvailable: boolean }>('/mcp/servers'),
  saveMcpServer: (input: McpServerInput) =>
    postJson<{ server: McpServerDef }>('/mcp/servers', input),
  deleteMcpServer: (id: string) =>
    delJson<{ ok: boolean }>(`/mcp/servers/${encodeURIComponent(id)}`),
  setMcpSecret: (id: string, kind: McpSecretKind, key: string, value: string) =>
    putJson<{ ok: boolean; server: McpServerDef }>(
      `/mcp/servers/${encodeURIComponent(id)}/secrets/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
      { value },
    ),
  clearMcpSecret: (id: string, kind: McpSecretKind, key: string) =>
    delJson<{ ok: boolean; server: McpServerDef }>(
      `/mcp/servers/${encodeURIComponent(id)}/secrets/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
    ),
  getNativeMcp: (agentType: string, projectId?: string) =>
    getJson<McpNativeView>(
      `/mcp/native?agentType=${encodeURIComponent(agentType)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  installNativeMcp: (agentType: string, body: McpNativeInstallInput) =>
    postJson<McpNativeInstallResult>(`/mcp/native/${encodeURIComponent(agentType)}`, body),
  removeNativeMcp: (agentType: string, name: string, scope: McpNativeWriteScope, projectId?: string) =>
    delJson<McpNativeRemoveResult>(
      `/mcp/native/${encodeURIComponent(agentType)}/entry/${encodeURIComponent(name)}?scope=${encodeURIComponent(scope)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  getConversationMcp: (id: string, query?: { agentType?: string; profileId?: string }) => {
    const params = new URLSearchParams();
    if (query?.agentType) params.set('agentType', query.agentType);
    if (query?.profileId) params.set('profileId', query.profileId);
    const qs = params.toString();
    return getJson<ConversationMcpView>(`/conversations/${encodeURIComponent(id)}/mcp${qs ? `?${qs}` : ''}`);
  },
  getMcpStatus: (id: string) =>
    getJson<{ statuses: McpLiveStatus[] }>(`/conversations/${encodeURIComponent(id)}/mcp/status`),
  mcpControl: (id: string, name: string, action: McpControlAction) =>
    postJson<{ ok: boolean }>(`/conversations/${encodeURIComponent(id)}/mcp/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, {}),
  claudeInsights: (fresh = false) =>
    getJson<{ insights: ClaudeInsights }>(`/settings/agent-usage/claude-insights${fresh ? '?fresh=1' : ''}`)
      .then((r) => r.insights),
  codexInsights: (fresh = false) =>
    getJson<{ insights: CodexInsights }>(`/settings/agent-usage/codex-insights${fresh ? '?fresh=1' : ''}`)
      .then((r) => r.insights),
  antigravityInsights: (fresh = false) =>
    getJson<{ insights: AntigravityInsights }>(`/settings/agent-usage/antigravity-insights${fresh ? '?fresh=1' : ''}`)
      .then((r) => r.insights),
  cursorInsights: (fresh = false) =>
    getJson<{ insights: CursorInsights }>(`/settings/agent-usage/cursor-insights${fresh ? '?fresh=1' : ''}`)
      .then((r) => r.insights),
  getCompaction: () =>
    getJson<CompactionSettingsResponse>('/settings/compaction').then((r) => r.settings),
  updateCompaction: (patch: Partial<CompactionSettings>) =>
    postJson<CompactionSettingsResponse>('/settings/compaction', patch).then((r) => r.settings),
  getSandboxSettings: () =>
    getJson<{ settings: SandboxSettings }>('/settings/sandbox').then((r) => r.settings),
  updateSandboxSettings: (body: SandboxSettings) =>
    postJson<{ settings: SandboxSettings }>('/settings/sandbox', body).then((r) => r.settings),
  getAgentEnv: () => getJson<AgentEnvList>('/settings/agent-env'),
  setAgentEnv: (agentType: string, name: string, value: string) =>
    putJson<{ agentType: string; name: string; updatedAt: number | null; vaultAvailable: boolean }>(
      `/settings/agent-env/${encodeURIComponent(agentType)}/${encodeURIComponent(name)}`,
      { value },
    ),
  clearAgentEnv: (agentType: string, name: string) =>
    delJson<{ ok: true; vaultAvailable: boolean }>(
      `/settings/agent-env/${encodeURIComponent(agentType)}/${encodeURIComponent(name)}`,
    ),
  getGeneral: () =>
    getJson<{ settings: GeneralSettings }>('/settings/general').then((r) => r.settings),
  updateGeneral: (patch: Partial<GeneralSettings>) =>
    postJson<{ settings: GeneralSettings }>('/settings/general', patch).then((r) => r.settings),
  getNotificationSettings: () =>
    getJson<NotificationSettingsResponse>('/settings/notifications').then((r) => r.settings),
  updateNotificationSettings: (patch: Partial<PublicNotificationSettings>) =>
    postJson<NotificationSettingsResponse>('/settings/notifications', patch).then((r) => r.settings),
  getDecisionSettings: () =>
    getJson<{ settings: PublicDecisionSettings }>('/settings/decision').then((r) => r.settings),
  updateDecisionSettings: (patch: Partial<DecisionSettings>) =>
    postJson<{ settings: PublicDecisionSettings }>('/settings/decision', patch).then((r) => r.settings),
  getTagCatalogue: () =>
    getJson<TagCatalogueResponse>('/settings/tag-catalogue'),
  updateTagCatalogue: (catalogue: TagCatalogueSettings) =>
    postJson<TagCatalogueResponse>('/settings/tag-catalogue', catalogue),
  /** Server-side probe. Resolves to a result object even on a 4xx/5xx so the UI can show the reason. */
  testDecision: async (): Promise<{ ok: boolean; model?: string; latencyMs?: number; error?: string }> => {
    const r = await fetch(`${base}/settings/decision/test`, { method: 'POST', credentials: 'include' });
    if (r.status === 401) throw new UnauthorizedError('/settings/decision/test');
    return (await r.json()) as { ok: boolean; model?: string; latencyMs?: number; error?: string };
  },
  getConversation: (id: string) =>
    getJson<{ conversation: Conversation }>(`/conversations/${id}`).then((r) => r.conversation),
  getVapidPublicKey: () =>
    getJson<{ key: string }>('/notifications/vapid-public-key').then((r) => r.key),
  subscribePush: async (sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }): Promise<void> => {
    const r = await fetch(`${base}/notifications/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub),
      credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError('/notifications/subscribe');
    if (!r.ok && r.status !== 204) throw new Error(`POST /notifications/subscribe -> ${r.status}`);
  },
  unsubscribePush: async (endpoint: string): Promise<void> => {
    const r = await fetch(`${base}/notifications/subscribe`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
      credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError('/notifications/subscribe');
    if (!r.ok && r.status !== 204) throw new Error(`DELETE /notifications/subscribe -> ${r.status}`);
  },
  getRetentionStats: () => getJson<RetentionStats>('/settings/retention/stats'),
  purgeRetentionNow: async (): Promise<RetentionPurgeResponse> => {
    const r = await fetch(`${base}/settings/retention/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError('/settings/retention/purge');
    const data = await r.json() as Partial<RetentionPurgeResponse> & { error?: string };
    if (r.status === 409 || data.alreadyRunning) {
      return { alreadyRunning: true, deleted: 0, eventsDeleted: 0, remaining: 0, dbSizeBytes: 0 };
    }
    if (!r.ok) throw new Error(data.error || `POST /settings/retention/purge -> ${r.status}`);
    return {
      alreadyRunning: false,
      deleted: data.deleted ?? 0,
      eventsDeleted: data.eventsDeleted ?? 0,
      remaining: data.remaining ?? 0,
      dbSizeBytes: data.dbSizeBytes ?? 0,
    };
  },
  /** FW-11: archive browser. Header metadata only — never file contents. */
  listRetentionArchive: () =>
    getJson<RetentionArchiveListResponse>('/settings/retention/archive').then((r) => r.items),
  /**
   * FW-11: re-insert an archived conversation (and its archived subtree).
   * `postJson` already surfaces the server's `{ error }` string as the thrown
   * message, so 400/404/409 all reach the caller as a readable Error.
   */
  restoreRetentionArchive: (id: string, projectId?: string) =>
    postJson<RetentionRestoreResponse>(
      `/settings/retention/archive/${encodeURIComponent(id)}/restore`,
      projectId ? { projectId } : {},
    ),
  deleteRetentionArchive: (id: string) =>
    delJson<RetentionArchiveDeleteResponse>(
      `/settings/retention/archive/${encodeURIComponent(id)}`,
    ),
  deleteAllRetentionArchives: () =>
    delJson<RetentionArchiveDeleteResponse>('/settings/retention/archive'),

  // ── FW-17: database backups ────────────────────────────────────────────
  listBackups: () => getJson<BackupListResponse>('/settings/backups'),
  /** `postJson` surfaces the server's `{ error }` string, so 409/507/500 all
   *  reach the caller as a readable Error. */
  createBackup: (includeAudio: boolean) =>
    postJson<{ backup: BackupEntry; rotated: string[] }>('/settings/backup', { includeAudio }),
  deleteBackup: (name: string) =>
    delJson<{ deleted: number }>(`/settings/backups/${encodeURIComponent(name)}`),

  // ── Catalogue (Phase 5) ────────────────────────────────────────────────
  listAgents: () => getJson<AgentsResponse>('/agents').then((r) => r.agents),
  getSandboxSupport: () => getJson<AgentsResponse>('/agents').then((r) => ({
    supportedAgents: r.supportedSandboxAgents ?? [],
    hubAvailable: r.sandboxAvailable,
  })),
  getCatalogue: () => getJson<CatalogueResponse>('/catalogue'),
  createAgent: (req: CreateAgentRequest) =>
    postJson<{ agent: AgentRecord }>('/agents', req).then((r) => r.agent),
  updateAgent: (id: string, patch: UpdateAgentRequest) =>
    patchJson<{ agent: AgentRecord }>(`/agents/${id}`, patch).then((r) => r.agent),
  getGrokBotStatus: () => getJson<GrokBotLifecycleStatus>('/grok-bot/status'),
  startGrokBot: (reason: 'manual' | 'on-demand') =>
    postJson<GrokBotLifecycleStatus>('/grok-bot/start', { reason }),
  createGrokBot: (title: string) =>
    postJson<{ conversation: Conversation }>('/grok-bot/bots', { title }).then((r) => r.conversation),
  deleteAgent: (id: string) => del(`/agents/${id}`),
  createModel: (agentId: string, req: CreateModelRequest) =>
    postJson<{ model: ModelRecord }>(`/agents/${agentId}/models`, req).then((r) => r.model),
  updateModel: (id: string, patch: UpdateModelRequest) =>
    patchJson<{ model: ModelRecord }>(modelResourcePath(id), patch).then((r) => r.model),
  deleteModel: (id: string) => del(modelResourcePath(id)),
  pullModels: (agentId: string): Promise<ModelDescriptor[]> =>
    postJson<PullModelsResponse>(`/agents/${agentId}/pull-models`, {}).then((r) => r.models),
  upgradeAgent: (id: string): Promise<UpgradeAgentResponse> =>
    postJson<UpgradeAgentResponse>(`/agents/${encodeURIComponent(id)}/upgrade`, {}),
  loginLocalAgent: (type: string) =>
    postJson<{ ok: true; started: true }>(`/agents/${encodeURIComponent(type)}/login`, {}),
  cancelLocalAgentLogin: (type: string) =>
    postJson<{ ok: true; cancelled: true }>(`/agents/${encodeURIComponent(type)}/login/cancel`, {}),
  submitLocalAgentLoginCode: (type: string, code: string) =>
    postJson<{ ok: true }>(`/agents/${encodeURIComponent(type)}/login/code`, { code }),
  installAllAgents: (mode: InstallAllMode) =>
    postJson<AgentsInstallAllResponse>('/agents/install-all', { mode }),
  refreshAgentVersions: () =>
    postJson<VersionsRefreshResponse>('/agents/versions/refresh', {}),

  listCommands: (agentId: string, opts?: { includeDisabled?: boolean; projectId?: string }): Promise<CommandRecord[]> => {
    const q = new URLSearchParams();
    if (opts?.includeDisabled) q.set('includeDisabled', '1');
    if (opts?.projectId) q.set('projectId', opts.projectId);
    const qs = q.toString();
    return getJson<CommandsResponse>(`/agents/${agentId}/commands${qs ? `?${qs}` : ''}`).then((r) => r.commands);
  },
  listCommandsWithStatus: (agentId: string, projectId?: string): Promise<{ commands: CommandRecord[]; hostOffline: boolean }> =>
    getJson<CommandsResponse>(
      `/agents/${agentId}/commands${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ).then((r) => ({ commands: r.commands, hostOffline: r.hostOffline === true })),
  createCommand: (agentId: string, req: CreateCommandRequest) =>
    postJson<{ command: CommandRecord }>(`/agents/${agentId}/commands`, req).then((r) => r.command),
  updateCommand: (agentId: string, cmdId: string, patch: UpdateCommandRequest) =>
    patchJson<{ command: CommandRecord }>(`/agents/${agentId}/commands/${cmdId}`, patch).then((r) => r.command),
  deleteCommand: (agentId: string, cmdId: string) =>
    delJson<{ ok: true }>(`/agents/${agentId}/commands/${cmdId}`),
  pullCommands: (agentId: string) =>
    postJson<PullCommandsResponse>(`/agents/${agentId}/pull-commands`, {}).then((r) => r.commands),
  deleteEvent: (id: string) => del(`/events/${id}`),

  // ── Cross-agent spawn ──────────────────────────────────────────────────
  spawn: async (body: SpawnRequest): Promise<SpawnResponse> => {
    const r = await fetch(`${base}/spawn`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError('/spawn');
    if (r.status === 409) throw Object.assign(new Error('worktree-unavailable'), { conflict: await r.json() });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'spawn failed');
    return r.json() as Promise<SpawnResponse>;
  },
  listTemplates: () =>
    getJson<{ templates: SpawnTemplate[] }>('/settings/templates').then((r) => r.templates),
  /** Manual "push result up": operator forwards this child's latest answer to
   *  its parent (side quests after the recovery slot is spent). Cookie-only. */
  pushResultUp: (childConversationId: string) =>
    postJson<{ ok: boolean; childConversationId: string; parentConversationId: string; proseLength: number }>(
      `/spawn/${encodeURIComponent(childConversationId)}/push`, {},
    ),
  saveTemplate: (t: SpawnTemplate) =>
    postJson<{ templates: SpawnTemplate[] }>('/settings/templates', t).then((r) => r.templates),
  deleteTemplate: (name: string) =>
    del(`/settings/templates/${encodeURIComponent(name)}`),
  aaStatus: () => getJson<AaStatus>('/settings/aa'),
  aaSetKey: (value: string) => putJson<{ ok: true }>('/settings/aa/key', { value }),
  aaClearKey: () => delJson<{ ok: true; cleared: boolean }>('/settings/aa/key'),
  aaModels: () => getJson<{ models: AaModelListItem[]; tier: string; fetchedAt: number; stale?: true }>(
    '/settings/aa/models',
  ),
  aaSuggest: (body: { profileId: string; role?: string; aaSlug?: string; siblingWhens?: string[] }) =>
    postJson<AaSuggestResponse>('/settings/aa/suggest', body),

  listCustomPrompts: () =>
    getJson<{ prompts: PromptCollectionEntry[] }>('/settings/prompts').then((r) => r.prompts),
  saveCustomPrompt: (p: PromptCollectionEntry) =>
    postJson<{ prompts: PromptCollectionEntry[] }>('/settings/prompts', p).then((r) => r.prompts),
  deleteCustomPrompt: (id: string) =>
    del(`/settings/prompts/${encodeURIComponent(id)}`),
  importPrompts: (pack: unknown, overwrite = false) =>
    postJson<{
      prompts: PromptCollectionEntry[];
      imported: string[];
      skipped: Array<{ id: string; name: string }>;
    }>('/settings/prompts/import', { pack, overwrite }),

  listRolePresets: () =>
    getJson<{ presets: RoleWhenPreset[] }>('/settings/role-presets').then((r) => r.presets),
  saveRolePreset: (p: RoleWhenPreset) =>
    postJson<{ presets: RoleWhenPreset[] }>('/settings/role-presets', p).then((r) => r.presets),
  deleteRolePreset: (id: string) =>
    del(`/settings/role-presets/${encodeURIComponent(id)}`),

  listCapabilityProfiles: () =>
    getJson<{ profiles: CapabilityProfile[]; defaultProfileId: string }>('/settings/capability-profiles').then((r) => r.profiles),
  getCapabilityProfilesSettings: () =>
    getJson<{ profiles: CapabilityProfile[]; defaultProfileId: string }>('/settings/capability-profiles'),
  saveCapabilityProfile: (profile: CapabilityProfile) =>
    postJson<{ profile: CapabilityProfile; profiles: CapabilityProfile[]; defaultProfileId: string }>('/settings/capability-profiles', profile),
  deleteCapabilityProfile: (id: string) =>
    delJson<{ profiles: CapabilityProfile[]; defaultProfileId: string }>(`/settings/capability-profiles/${encodeURIComponent(id)}`),
  setDefaultCapabilityProfile: (id: string) =>
    postJson<{ ok: boolean; defaultProfileId: string; profiles: CapabilityProfile[] }>('/settings/capability-profiles/default', { id }),

  listDesignations: () =>
    getJson<DesignationCatalogue>('/settings/designations'),
  addDesignation: (token: string) =>
    postJson<DesignationCatalogue>('/settings/designations', { token }),
  deleteDesignation: (token: string) =>
    delJson<DesignationCatalogue>(`/settings/designations/${encodeURIComponent(token)}`),

  // ── Voice / STT ──────────────────────────────────────────────────────────
  getVoiceSettings: () =>
    getJson<{ settings: VoiceSettings }>('/settings/voice').then((r) => r.settings),
  updateVoiceSettings: (patch: { cleanup?: Partial<VoiceSettings['cleanup']>; tts?: Partial<VoiceSettings['tts']> }) =>
    postJson<{ settings: VoiceSettings }>('/settings/voice', patch).then((r) => r.settings),
  getTtsConfig: () =>
    getJson<{ tts: VoiceTtsSettings; piperUp: boolean; kokoroUp: boolean; summarizeConfigured: boolean }>('/tts/config'),
  summarizeForTts: (text: string, opts?: { kind?: 'prose' | 'code'; filename?: string; lang?: string }) =>
    postJson<{ text: string }>('/tts/summarize', { text, ...opts }),
  listTtsRecordings: (
    conversationId: string,
    opts?: { tree?: boolean },
  ): Promise<TtsRecordingsListResponse> =>
    getJson<TtsRecordingsListResponse>(
      `/conversations/${conversationId}/tts-recordings${opts?.tree ? '?tree=1' : ''}`,
    ),
  listProjectTtsRecordings: (projectId: string): Promise<TtsRecordingsListResponse> =>
    getJson<TtsRecordingsListResponse>(`/projects/${projectId}/tts-recordings`),
  /** Poll / re-hydrate a TTS job by id (includes running/error/ephemeral). */
  getTtsRecording: (id: string): Promise<{ recording: TtsRecording }> =>
    getJson<{ recording: TtsRecording }>(`/tts/recordings/${id}`),
  deleteTtsRecording: (id: string) => del(`/tts/recordings/${id}`),
  /**
   * Absolute-path-style URL for <audio src> (cookie auth).
   * Pass `{ download: true }` for Content-Disposition attachment (offline save).
   */
  ttsRecordingAudioUrl: (id: string, opts?: { download?: boolean }) =>
    opts?.download
      ? `/tts/recordings/${id}/audio?download=1`
      : `/tts/recordings/${id}/audio`,
  getWhisperConfig: () => getJson<WhisperConfigResponse>('/transcribe/config'),
  /** Probe the cleanup LLM with a fixed string; returns the latency + reply. */
  testVoiceCleanup: async (probe: VoiceSettings['cleanup']): Promise<{ ok: boolean; reply?: string; error?: string }> => {
    const r = await fetch(`${base}/transcribe/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cleanup: probe }), credentials: 'include',
    });
    return r.json() as Promise<{ ok: boolean; reply?: string; error?: string }>;
  },

  // ── Prompt enhancer ──────────────────────────────────────────────────────
  getEnhanceConfig: () =>
    getJson<EnhanceConfigResponse>('/settings/enhance'),
  enhance: async (body: { conversationId: string; text: string; mode: EnhanceMode; promptId?: string; instruction?: string }) => {
    const r = await fetch(`${base}/enhance`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), credentials: 'include',
    });
    if (r.status === 401) throw new UnauthorizedError('/enhance');
    if (r.status === 409) {
      const data = await r.json().catch(() => ({})) as { error?: string; processing?: string };
      throw Object.assign(new Error(data.error || 'draft busy'), {
        status: 409 as const,
        processing: data.processing,
      });
    }
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json() as { error?: string }).error ?? ''; } catch { /* ignore */ }
      throw new Error(detail || `POST /enhance -> ${r.status}`);
    }
    return r.json() as Promise<EnhanceStartedResponse>;
  },
  undoEnhance: (conversationId: string) =>
    postJson<UndoEnhanceResponse>(`/conversations/${conversationId}/draft/undo-enhance`, {}),
  testEnhance: async (): Promise<{ ok: boolean; reply?: string; error?: string }> => {
    const r = await fetch(`${base}/enhance/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), credentials: 'include',
    });
    return r.json() as Promise<{ ok: boolean; reply?: string; error?: string }>;
  },

  getSidecarLlmSettings: () =>
    getJson<{ settings: SidecarLlmSettings; capableAdapters: OneShotCapableAdapter[] }>('/settings/sidecar-llm'),
  updateSidecarLlmSettings: (patch: Partial<SidecarLlmSettings>) =>
    postJson<{ settings: SidecarLlmSettings; capableAdapters: OneShotCapableAdapter[] }>(
      '/settings/sidecar-llm', patch,
    ),
  getDirectLlmProfiles: () =>
    getJson<{ profiles: DirectLlmProfile[] }>('/settings/direct-llm').then((r) => r.profiles),
  createDirectLlmProfile: (input?: { label?: string; provider?: VoiceCleanupProvider }) =>
    postJson<{ profiles: DirectLlmProfile[]; createdId: string }>('/settings/direct-llm', input ?? {}),
  updateDirectLlmProfile: (id: string, patch: Partial<DirectLlmProfile>) =>
    postJson<{ profiles: DirectLlmProfile[] }>(`/settings/direct-llm/${encodeURIComponent(id)}`, patch)
      .then((r) => r.profiles),
  deleteDirectLlmProfile: (id: string) =>
    delJson<{ profiles: DirectLlmProfile[]; sidecar: SidecarLlmSettings }>(
      `/settings/direct-llm/${encodeURIComponent(id)}`),
  testDirectLlmProfile: (id: string) =>
    postJson<DirectLlmTestResult>(`/settings/direct-llm/${encodeURIComponent(id)}/test`, {})
      .catch((e) => {
        if (e instanceof UnauthorizedError) throw e;
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }),
  /** Kick off a background model download; poll progress via getDownloadProgress. */
  downloadWhisperModel: (model: WhisperModel) =>
    postJson<{ ok: boolean; model: WhisperModel }>(`/transcribe/model/download?model=${model}`, {}).then((r) => r),
  getDownloadProgress: (model: WhisperModel) =>
    getJson<WhisperDownloadProgress>(`/transcribe/model/download/progress?model=${model}`),

  // ── /btw side questions ──────────────────────────────────────────────────
  askBtw: (conversationId: string, question: string) =>
    postJson<BtwAskResponse>(`/conversations/${conversationId}/btw`, { question }),
  listBtw: (conversationId: string) =>
    getJson<BtwListResponse>(`/conversations/${conversationId}/btw`).then((r) => r.queries),
  getBtwSettings: () =>
    getJson<{ settings: BtwSettings; availability: BtwAvailability }>('/settings/btw').then((r) => r.settings),
  getBtwAvailability: () =>
    getJson<{ availability: BtwAvailability }>('/settings/btw').then((r) => r.availability),
  updateBtwSettings: (patch: Partial<BtwSettings>) =>
    postJson<{ settings: BtwSettings }>('/settings/btw', patch).then((r) => r.settings),
  forkBtw: (conversationId: string, btwId: string) =>
    postJson<BtwForkResponse>(`/conversations/${conversationId}/btw/${btwId}/fork`, {})
      .then((r) => r.conversation),

  // ── Prompt timers (per-conversation; never a schedule job) ───────────────
  listConversationTimers: (conversationId: string): Promise<ConversationTimer[]> =>
    getJson<ConversationTimersResponse>(`/conversations/${conversationId}/timers`)
      .then((r) => r.timers),
  createConversationTimer: (
    conversationId: string,
    body: CreateConversationTimerRequest,
  ): Promise<ConversationTimer> =>
    postJson<ConversationTimerResponse>(`/conversations/${conversationId}/timers`, body)
      .then((r) => {
        window.dispatchEvent(new CustomEvent('conversation-timers-changed', {
          detail: { conversationId, timerId: r.timer.id, action: 'created' },
        }));
        return r.timer;
      }),
  cancelConversationTimer: (conversationId: string, timerId: string): Promise<void> =>
    del(`/conversations/${conversationId}/timers/${timerId}`).then(() => {
      window.dispatchEvent(new CustomEvent('conversation-timers-changed', {
        detail: { conversationId, timerId, action: 'cancelled' },
      }));
    }),
  updateConversationTimer: (
    conversationId: string,
    timerId: string,
    body: UpdateConversationTimerRequest,
  ): Promise<ConversationTimer> =>
    patchJson<ConversationTimerResponse>(`/conversations/${conversationId}/timers/${timerId}`, body)
      .then((r) => {
        window.dispatchEvent(new CustomEvent('conversation-timers-changed', {
          detail: { conversationId, timerId: r.timer.id, action: 'updated' },
        }));
        return r.timer;
      }),
  pendingTimers: (signal?: AbortSignal): Promise<PendingTimersResponse> =>
    getJson<PendingTimersResponse>('/timers/pending', signal),

  // ── Global Tasks (operator-global) ───────────────────────────────────────
  globalTasks: (view: GlobalTaskView, projectId?: string, signal?: AbortSignal) =>
    getJson<GlobalTasksResponse>(`/tasks?view=${view}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`, signal),
  globalTaskCount: (signal?: AbortSignal) => getJson<GlobalTaskCounts>('/tasks/count', signal),
  updateGlobalTask: (id: string, patch: { status?: GlobalTaskStatus; hidden?: boolean }) =>
    patchJson<{ task: GlobalTaskDto }>(`/tasks/${encodeURIComponent(id)}`, patch),
  hideCompletedGlobalTasks: () => postJson<{ hidden: number }>('/tasks/hide-completed', {}),
  deleteGlobalTask: (id: string) => delJson<{ ok: true }>(`/tasks/${encodeURIComponent(id)}`),
  deleteHiddenGlobalTasks: () => delJson<{ deleted: number }>('/tasks?view=hidden'),
  globalTasksSettings: () => getJson<GlobalTasksSettings>('/settings/global-tasks'),
  saveGlobalTasksSettings: (s: Partial<GlobalTasksSettings>) => postJson<GlobalTasksSettings>('/settings/global-tasks', s),

  // ── Memories (operator-global) ──────────────────────────────────────────
  listMemories: (
    o: { view: 'all' | 'suggestions' | 'flagged'; projectId?: string; q?: string; includeSuperseded?: boolean },
    signal?: AbortSignal,
  ): Promise<ListMemoriesResponse> => {
    const params = new URLSearchParams();
    if (o.view) params.set('view', o.view);
    if (o.projectId) params.set('projectId', o.projectId);
    if (o.q) params.set('q', o.q);
    if (o.includeSuperseded) params.set('includeSuperseded', '1');
    return getJson<ListMemoriesResponse>(`/memories?${params.toString()}`, signal);
  },
  memoryCounts: (signal?: AbortSignal): Promise<MemoryCounts> =>
    getJson<MemoryCounts>('/memories/counts', signal),
  getMemory: (id: string): Promise<MemoryDto> =>
    getJson<MemoryDto>(`/memories/${encodeURIComponent(id)}`),
  deleteMemory: (id: string): Promise<void> =>
    delJson<void>(`/memories/${encodeURIComponent(id)}`),
  editMemory: (id: string, text: string): Promise<MemoryDto> =>
    postJson<MemoryDto>(`/memories/${encodeURIComponent(id)}/edit`, { text }),
  approveMemory: (id: string): Promise<void> =>
    postJson<{ ok: boolean }>(`/memories/${encodeURIComponent(id)}/approve`, {}).then(() => undefined),
  flagMemory: (id: string): Promise<void> =>
    postJson<{ ok: boolean }>(`/memories/${encodeURIComponent(id)}/flag`, {}).then(() => undefined),
  promoteMemory: (id: string): Promise<void> =>
    postJson<{ ok: boolean }>(`/memories/${encodeURIComponent(id)}/promote`, {}).then(() => undefined),
  dismissMemorySuggestion: (id: string): Promise<void> =>
    postJson<{ ok: boolean }>(`/memories/${encodeURIComponent(id)}/dismiss`, {}).then(() => undefined),

  // ── Spawn approval queue (cookie-only, operator-global) ─────────────────
  // No arg → ALL pending across every conversation (the approval queue is
  // operator-global). Pass a parentConversationId to scope to one conversation.
  listSpawnRequests: (parentConversationId?: string) =>
    getJson<{ requests: SpawnRequestRow[] }>(
      parentConversationId
        ? `/spawn/requests?parentConversationId=${encodeURIComponent(parentConversationId)}`
        : '/spawn/requests',
    ).then((r) => r.requests),
  approveSpawnRequest: (id: string) =>
    postJson<{ ok: boolean; requestId: string; childConversationId?: string }>(`/spawn/requests/${id}/approve`, {}),
  denySpawnRequest: (id: string, reason?: string) =>
    postJson<{ ok: boolean; requestId: string; status: string }>(`/spawn/requests/${id}/deny`, { reason }),

  // ── Piper voices ─────────────────────────────────────────────────────────
  listPiperVoices: () =>
    getJson<PiperVoicesResponse>('/tts/voices'),
  downloadPiperVoice: (id: string) =>
    postJson<{ ok: boolean; id: string }>(`/tts/voices/download?id=${encodeURIComponent(id)}`, {}),
  piperVoiceDownloadProgress: (id: string) =>
    getJson<PiperDownloadProgress>(`/tts/voices/download/progress?id=${encodeURIComponent(id)}`),

  /** Kokoro-FastAPI baked voices (proxied; empty when sidecar is down). */
  listKokoroVoices: () =>
    getJson<{ voices: { id: string; name: string }[]; kokoroUrl?: string }>('/tts/kokoro/voices'),

  // ── Scheduled jobs ───────────────────────────────────────────────────────
  listSchedules: (projectId: string) =>
    getJson<{ jobs: ScheduleJob[] }>(`/projects/${projectId}/schedules`).then((r) => r.jobs),
  getSchedule: (projectId: string, jobId: string) =>
    getJson<{ job: ScheduleJobDetail }>(`/projects/${projectId}/schedules/${jobId}`).then((r) => r.job),
  createSchedule: (projectId: string, body: CreateScheduleJobRequest) =>
    postJson<{ job: ScheduleJobDetail; warnings?: string[]; packFiles?: string[] }>(
      `/projects/${projectId}/schedules`,
      body,
    ),
  listSchedulePacks: () =>
    getJson<{ packs: SchedulePack[] }>('/schedule-packs').then((r) => r.packs),
  importSchedulePack: (doc: SchedulePack) =>
    postJson<{ pack: SchedulePack }>('/schedule-packs', doc).then((r) => r.pack),
  deleteSchedulePack: (slug: string) =>
    del(`/schedule-packs/${encodeURIComponent(slug)}`),
  patchSchedule: (projectId: string, jobId: string, body: PatchScheduleJobRequest) =>
    patchJson<{ job: ScheduleJobDetail }>(`/projects/${projectId}/schedules/${jobId}`, body).then((r) => r.job),
  /** Hard-delete job + all run conversations / spawn trees / TTS recordings. */
  deleteSchedule: (projectId: string, jobId: string) =>
    delJson<{ ok: boolean; deletedConversationIds?: string[] }>(
      `/projects/${projectId}/schedules/${jobId}`,
    ),
  /** FW-18: one gesture, N schedule jobs. Always 200 on a well-formed request. */
  bulkSchedules: (body: {
    action: 'enable' | 'disable' | 'archive' | 'unarchive' | 'delete';
    ids: string[];
  }) =>
    postJson<{
      results: { id: string; ok: boolean; error?: string; skipped?: string }[];
      deletedConversationIds?: string[];
      deletedIds?: string[];
    }>('/schedules/bulk', body),
  /** Soft-archive (hide from lists; keep rows). */
  archiveSchedule: (projectId: string, jobId: string) =>
    postJson<{ job: ScheduleJobDetail }>(`/projects/${projectId}/schedules/${jobId}/archive`, {})
      .then((r) => r.job),
  unarchiveSchedule: (projectId: string, jobId: string) =>
    postJson<{ job: ScheduleJobDetail }>(`/projects/${projectId}/schedules/${jobId}/unarchive`, {})
      .then((r) => r.job),
  enableSchedule: (projectId: string, jobId: string) =>
    postJson<{ job: ScheduleJobDetail }>(`/projects/${projectId}/schedules/${jobId}/enable`, {}).then((r) => r.job),
  disableSchedule: (projectId: string, jobId: string) =>
    postJson<{ job: ScheduleJobDetail }>(`/projects/${projectId}/schedules/${jobId}/disable`, {}).then((r) => r.job),
  runScheduleNow: (projectId: string, jobId: string) =>
    postJson<{ runId: string }>(`/projects/${projectId}/schedules/${jobId}/run-now`, {}),
  deleteScheduleRun: (projectId: string, jobId: string, runId: string) =>
    delJson<{ ok: boolean; deletedRunId: string }>(
      `/projects/${projectId}/schedules/${jobId}/runs/${runId}`,
    ),
  clearScheduleErrors: (projectId: string, jobId: string, opts?: { onlyOrphaned?: boolean }) =>
    postJson<{ ok: boolean; deletedCount: number }>(
      `/projects/${projectId}/schedules/${jobId}/clear-errors${opts?.onlyOrphaned ? '?onlyOrphaned=1' : ''}`,
      opts ?? {},
    ),
  listScheduleRuns: (projectId: string, jobId: string, limit?: number) =>
    getJson<{ runs: ScheduleRun[] }>(
      `/projects/${projectId}/schedules/${jobId}/runs${limit != null ? `?limit=${limit}` : ''}`,
    ).then((r) => r.runs),
  scheduleUpcoming: (projectId: string, jobId: string, count = 5) =>
    getJson<UpcomingFiresResponse>(
      `/projects/${projectId}/schedules/${jobId}/upcoming?count=${count}`,
    ),
  /**
   * FW-20 — project-wide projected fires for the calendar grid.
   * from/to are UTC ms; the server clamps the start to now and caps markers per job.
   */
  scheduleCalendar: (projectId: string, from: number, to: number) =>
    getJson<ScheduleCalendarResponse>(
      `/projects/${projectId}/schedules/calendar?from=${Math.round(from)}&to=${Math.round(to)}`,
    ),
  /**
   * Full-window calendar. Omit projectId for every project; supply it to scope
   * to one. The server clamps the start to now and fair-shares the marker budget
   * across the TOTAL job count.
   */
  scheduleCalendarGlobal: (from: number, to: number, projectId?: string) =>
    getJson<ScheduleCalendarResponse>(
      `/schedules/calendar?from=${Math.round(from)}&to=${Math.round(to)}`
      + (projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''),
    ),
  /**
   * Operator skip.
   * - mode 'this' (default): hole-punch — only this occurrence.
   * - mode 'through': jump clock past fireAtMs (and earlier).
   */
  skipScheduleFire: (
    projectId: string,
    jobId: string,
    fireAtMs: number,
    mode: 'this' | 'through' = 'this',
  ) =>
    postJson<{ job: ScheduleJobDetail }>(
      `/projects/${projectId}/schedules/${jobId}/skip`,
      { fireAtMs, mode },
    ).then((r) => r.job),
  /** Restore next_fire_at to a previously operator-skipped fire (re-arms exhausted once). */
  unskipScheduleFire: (projectId: string, jobId: string, fireAtMs: number) =>
    postJson<{ job: ScheduleJobDetail }>(
      `/projects/${projectId}/schedules/${jobId}/unskip`,
      { fireAtMs },
    ).then((r) => r.job),
  scheduleTree: (projectId: string, runLimit?: number, opts?: { includeArchived?: boolean }) =>
    getJson<ScheduleTreeResponse>(
      `/projects/${projectId}/schedules/tree?${runLimit != null ? `runLimit=${runLimit}&` : ''}${opts?.includeArchived ? 'includeArchived=1' : ''}`,
    ),
  /** Operator cookie path (preferred for web UI). */
  putScheduleSteps: (projectId: string, jobId: string, body: PatchScheduleStepsRequest) =>
    putJson<{ steps: ScheduleStep[] }>(`/projects/${projectId}/schedules/${jobId}/steps`, body).then((r) => r.steps),
  /** In-place single-step update (status/title/body); does not remint ids. */
  patchScheduleStep: (
    projectId: string,
    jobId: string,
    stepId: string,
    body: { status?: StepStatus; title?: string; body?: string },
  ) =>
    patchJson<{ step: ScheduleStep; promoted?: ScheduleStep[] }>(
      `/projects/${projectId}/schedules/${jobId}/steps/${stepId}`,
      body,
    ),
  /** Unstick blocked/running → ready. */
  retryScheduleStep: (projectId: string, jobId: string, stepId: string) =>
    postJson<{ step: ScheduleStep }>(
      `/projects/${projectId}/schedules/${jobId}/steps/${stepId}/retry`,
      {},
    ).then((r) => r.step),
  /** Mark every step done (workload finished offline). */
  completeAllScheduleSteps: (projectId: string, jobId: string) =>
    postJson<{ steps: ScheduleStep[] }>(
      `/projects/${projectId}/schedules/${jobId}/steps/complete-all`,
      {},
    ).then((r) => r.steps),
  /** Operator cookie: set/clear pending_context; optional carryContextEnabled toggle. */
  putSchedulePendingContext: (
    projectId: string,
    jobId: string,
    body: { text: string | null; carryContextEnabled?: boolean },
  ) =>
    putJson<{ job: ScheduleJobDetail }>(
      `/projects/${projectId}/schedules/${jobId}/pending-context`,
      body,
    ).then((r) => r.job),
  /** Public deploy fingerprint. */
  health: () => getJson<{
    ok: true;
    version: string;
    gitSha: string | null;
    builtAt: string;
    serverMode: 'dist' | 'tsx' | 'unknown';
    startedAt: number;
  }>('/health'),

  /** Operator shell: run a host command (no leading '!'). Fire-and-forget from
   *  InputBar — refusals return 4xx JSON but the result card still arrives via WS. */
  runShell: async (conversationId: string, command: string): Promise<ShellResult & { error?: string; reason?: string }> => {
    const r = await fetch(`${base}/conversations/${conversationId}/shell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ command }),
    });
    if (r.status === 401) throw new UnauthorizedError(`/conversations/${conversationId}/shell`);
    return r.json() as Promise<ShellResult & { error?: string; reason?: string }>;
  },
  getShellAllow: (projectId: string) =>
    getJson<{ base: string[][]; project: { id: string; rule: string[] }[] }>(
      `/projects/${projectId}/shell-allow`,
    ),
  /** Returns { rule } on success or { error, reason } on 400 — does not throw on 400
   *  so the modal can show forbidden/invalid inline. */
  addShellAllow: async (
    projectId: string,
    rule: string[],
  ): Promise<{ rule?: { id: string; rule: string[] }; error?: string; reason?: string }> => {
    const r = await fetch(`${base}/projects/${projectId}/shell-allow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ rule }),
    });
    if (r.status === 401) throw new UnauthorizedError(`/projects/${projectId}/shell-allow`);
    return r.json() as Promise<{ rule?: { id: string; rule: string[] }; error?: string; reason?: string }>;
  },
  removeShellAllow: (projectId: string, ruleId: string) =>
    delJson<{ ok: boolean }>(`/projects/${projectId}/shell-allow/${ruleId}`),
};

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

/** Web-local Piper voice types — no shared rebuild. */
export interface PiperVoiceCatalogueEntry {
  id: string;
  label: string;
  language: string;
  quality: string;
  onnxPath: string;
  jsonPath: string;
  installed: boolean;
}

export interface PiperInstalledVoice {
  id: string;
  label: string;
  installed: true;
}

export interface PiperVoicesResponse {
  voices: PiperVoiceCatalogueEntry[];
  installed: PiperInstalledVoice[];
}

export interface PiperDownloadProgress {
  id: string;
  downloaded: number;
  total: number;
  pct: number;
  done: boolean;
  error: string | null;
}

/**
 * Optional context for resolving non-absolute paths on GET /files.
 * Pass a bare conversation id string for the common chat case, or an object
 * when only a project is known (e.g. schedule browser).
 */
export type FileResolveContext =
  | string
  | { conversationId?: string; projectId?: string }
  | undefined;

function resolveFileContext(ctx: FileResolveContext): {
  conversationId?: string;
  projectId?: string;
} {
  if (ctx == null) return {};
  if (typeof ctx === 'string') return { conversationId: ctx };
  return { conversationId: ctx.conversationId, projectId: ctx.projectId };
}

/**
 * URL for the authenticated file-serving endpoint. Use as `<img src={fileUrl(p)}>`
 * or fetch it for text. Cookie auth flows automatically because it's same-origin.
 *
 * The server validates the path against an allow-list and rejects anything that
 * isn't an image or markdown file. Callers don't need to know the rules.
 *
 * For non-absolute paths the server needs either `conversationId` (workdir or
 * project root) or `projectId` (project root only). For remote-host projects,
 * conversationId or projectId is forwarded even for absolute paths so the hub
 * knows which remote host owns the path and proxies the read to the node.
 */
export function fileUrl(absPath: string, ctx?: FileResolveContext): string {
  const pathPart = `path=${encodeURIComponent(absPath)}`;
  const { conversationId, projectId } = resolveFileContext(ctx);
  // Prefer conversation (worktree-aware); projectId is for schedule / no-convo UIs.
  if (conversationId) {
    return `${base}/files?${pathPart}&conversationId=${encodeURIComponent(conversationId)}`;
  }
  if (projectId) {
    return `${base}/files?${pathPart}&projectId=${encodeURIComponent(projectId)}`;
  }
  return `${base}/files?${pathPart}`;
}

export function fileDownloadUrl(absPath: string, name?: string, ctx?: FileResolveContext): string {
  let url = fileUrl(absPath, ctx) + '&download=1';
  if (name) url += `&name=${encodeURIComponent(name)}`;
  return url;
}

export function fileGitDiffUrl(absPath: string, ctx?: FileResolveContext): string {
  const pathPart = `path=${encodeURIComponent(absPath)}`;
  const { conversationId, projectId } = resolveFileContext(ctx);
  if (conversationId) {
    return `${base}/files/git-diff?${pathPart}&conversationId=${encodeURIComponent(conversationId)}`;
  }
  if (projectId) {
    return `${base}/files/git-diff?${pathPart}&projectId=${encodeURIComponent(projectId)}`;
  }
  return `${base}/files/git-diff?${pathPart}`;
}

export interface FileGitDiffResult {
  modified: boolean;
  diff: string;
  isTracked?: boolean;
}

export interface FileGitRestoreResult {
  action: 'restored' | 'deleted';
  path: string;
}

export async function fetchFileGitDiff(absPath: string, ctx?: FileResolveContext): Promise<FileGitDiffResult> {
  const r = await fetch(fileGitDiffUrl(absPath, ctx), { credentials: 'include' });
  if (r.status === 401) throw new UnauthorizedError(`/files/git-diff?path=…`);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(`git diff ${absPath} -> ${r.status} ${detail}`);
  }
  return r.json() as Promise<FileGitDiffResult>;
}

export async function restoreFileGit(absPath: string, ctx?: FileResolveContext): Promise<FileGitRestoreResult> {
  const { conversationId, projectId } = resolveFileContext(ctx);
  const r = await fetch(`${base}/files/git-restore`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: absPath, conversationId, projectId }),
  });
  if (r.status === 401) throw new UnauthorizedError(`/files/git-restore`);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(`git restore ${absPath} -> ${r.status} ${detail}`);
  }
  return r.json() as Promise<FileGitRestoreResult>;
}

export async function listFiles(args: { conversationId?: string; projectId?: string; path?: string }): Promise<FileBrowserListing> {
  const qs = new URLSearchParams();
  if (args.conversationId) qs.set('conversationId', args.conversationId);
  else if (args.projectId) qs.set('projectId', args.projectId);
  qs.set('path', args.path ?? '');
  const r = await fetch(`${base}/files/list?${qs}`, { credentials: 'include' });
  if (r.status === 401) throw new UnauthorizedError('/files/list');
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `list ${args.path ?? ''} -> ${r.status}`);
  }
  return r.json() as Promise<FileBrowserListing>;
}

/**
 * Fetch a text file (typically `.md`) via the authenticated endpoint.
 * Throws on 403/404/5xx so callers can surface the error in the modal.
 *
 * Relative-path context (`conversationId` / `projectId`) is forwarded.
 */
export async function fetchFileText(absPath: string, ctx?: FileResolveContext): Promise<string> {
  const r = await fetch(fileUrl(absPath, ctx), { credentials: 'include' });
  if (r.status === 401) throw new UnauthorizedError(`/files?path=…`);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(`file fetch ${absPath} -> ${r.status} ${detail}`);
  }
  return r.text();
}

export interface FileLoad {
  text: string;
  resolvedPath: string;   // X-Tierwyn-File-Path
  version: string | null; // X-Tierwyn-File-Version
  writable: boolean;      // X-Tierwyn-File-Writable === '1'
}

/**
 * The hub percent-encodes X-Tierwyn-File-Path (header values are byte strings;
 * non-ASCII paths would otherwise throw). Older nodes may still send it raw,
 * so fall back to the undecoded value when it wasn't valid percent-encoding.
 */
function decodeFilePathHeader(v: string | null, fallback: string): string {
  if (v == null) return fallback;
  try { return decodeURIComponent(v); } catch { return v; }
}

/** Same fetch as fetchFileText, plus version/writable headers for the editor. */
export async function fetchFileForEdit(absPath: string, ctx?: FileResolveContext): Promise<FileLoad> {
  const r = await fetch(fileUrl(absPath, ctx), { credentials: 'include' });
  if (r.status === 401) throw new UnauthorizedError(`/files?path=…`);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(`file fetch ${absPath} -> ${r.status} ${detail}`);
  }
  return {
    text: await r.text(),
    resolvedPath: decodeFilePathHeader(r.headers.get('X-Tierwyn-File-Path'), absPath),
    version: r.headers.get('X-Tierwyn-File-Version'),
    writable: r.headers.get('X-Tierwyn-File-Writable') === '1',
  };
}

export type SaveFileResult =
  | { ok: true; version: string }
  | { ok: false; status: number; error: string; currentVersion?: string };

export async function saveFileText(
  absPath: string,
  ctx: FileResolveContext | undefined,
  content: string,
  version: string,
): Promise<SaveFileResult> {
  const ctxFields = resolveFileContext(ctx);
  const r = await fetch(`${base}/files`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: absPath, ...ctxFields, content, version }),
  });
  if (r.status === 401) throw new UnauthorizedError('PUT /files');
  let json: { path?: string; version?: string; error?: string; currentVersion?: string } = {};
  try { json = await r.json() as typeof json; } catch { /* ignore */ }
  if (r.ok && typeof json.version === 'string') {
    return { ok: true, version: json.version };
  }
  return {
    ok: false,
    status: r.status,
    error: json.error ?? `save failed -> ${r.status}`,
    currentVersion: json.currentVersion,
  };
}

/**
 * Lightweight openability probe for draft path chips. Prefer HEAD (server
 * short-circuits without streaming). Falls back to GET + body cancel when HEAD
 * is rejected. Returns false on 403/404/network errors — callers omit the badge.
 */
export async function canOpenFile(
  absPath: string,
  ctx?: FileResolveContext,
  signal?: AbortSignal,
): Promise<boolean> {
  const url = fileUrl(absPath, ctx);
  try {
    const head = await fetch(url, { method: 'HEAD', credentials: 'include', signal });
    if (head.ok) return true;
    // Only fall back when HEAD is unsupported; 403/404 mean "not openable".
    if (head.status !== 405 && head.status !== 501) return false;
    const get = await fetch(url, { method: 'GET', credentials: 'include', signal });
    if (get.body) void get.body.cancel();
    return get.ok;
  } catch {
    return false;
  }
}

export interface WorkingTreeContext {
  conversationId?: string;
  projectId?: string;
  cwd?: string;
}

function workingTreeQuery(ctx: WorkingTreeContext): string {
  const params = new URLSearchParams();
  if (ctx.conversationId) params.set('conversationId', ctx.conversationId);
  if (ctx.projectId) params.set('projectId', ctx.projectId);
  if (ctx.cwd) params.set('cwd', ctx.cwd);
  return params.toString();
}

export async function fetchWorkingTree(ctx: WorkingTreeContext): Promise<GitWorkingTreeStatus> {
  const q = workingTreeQuery(ctx);
  const r = await fetch(`${base}/files/working-tree?${q}`, { credentials: 'include' });
  if (r.status === 401) throw new UnauthorizedError(`/files/working-tree?${q}`);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(`working-tree -> ${r.status} ${detail}`);
  }
  return r.json() as Promise<GitWorkingTreeStatus>;
}

async function postGitJson<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new UnauthorizedError(path);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `${path} -> ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export async function stageWorkingTreePath(body: GitWorkingTreePathRequest): Promise<void> {
  await postGitJson('/files/working-tree/stage', body);
}

export async function unstageWorkingTreePath(body: GitWorkingTreePathRequest): Promise<void> {
  await postGitJson('/files/working-tree/unstage', body);
}

export async function deleteWorkingTreeUntracked(body: GitWorkingTreePathRequest): Promise<void> {
  await postGitJson('/files/working-tree/delete', body);
}

export async function discardWorkingTreePath(body: GitWorkingTreePathRequest): Promise<void> {
  await postGitJson('/files/working-tree/discard', body);
}

export interface GitHistoryQuery extends WorkingTreeContext {
  limit?: number;
  skip?: number;
  ref?: string;
}

export function gitHistoryUrl(ctx: GitHistoryQuery): string {
  const params = new URLSearchParams();
  if (ctx.conversationId) params.set('conversationId', ctx.conversationId);
  if (ctx.projectId) params.set('projectId', ctx.projectId);
  if (ctx.cwd) params.set('cwd', ctx.cwd);
  if (ctx.limit !== undefined) params.set('limit', String(ctx.limit));
  if (ctx.skip !== undefined) params.set('skip', String(ctx.skip));
  if (ctx.ref) params.set('ref', ctx.ref);
  return `/files/git-history?${params.toString()}`;
}

export function gitCommitUrl(ctx: WorkingTreeContext, sha: string): string {
  const params = new URLSearchParams(workingTreeQuery(ctx));
  params.set('sha', sha);
  return `/files/git-history/commit?${params.toString()}`;
}

export function gitCommitDiffUrl(ctx: WorkingTreeContext, sha: string, path: string): string {
  const params = new URLSearchParams(workingTreeQuery(ctx));
  params.set('sha', sha);
  params.set('path', path);
  return `/files/git-history/diff?${params.toString()}`;
}

export function gitCommitFileUrl(ctx: WorkingTreeContext, sha: string, path: string): string {
  const params = new URLSearchParams(workingTreeQuery(ctx));
  params.set('sha', sha);
  params.set('path', path);
  return `/files/git-history/file?${params.toString()}`;
}

async function fetchGitJson<T>(url: string): Promise<T> {
  const r = await fetch(`${base}${url}`, { credentials: 'include' });
  if (r.status === 401) throw new UnauthorizedError(url);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `${url} -> ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export async function fetchGitHistory(ctx: GitHistoryQuery): Promise<GitHistoryResponse> {
  return fetchGitJson<GitHistoryResponse>(gitHistoryUrl(ctx));
}

export async function fetchGitCommitDetail(
  ctx: WorkingTreeContext,
  sha: string,
): Promise<GitCommitDetail> {
  return fetchGitJson<GitCommitDetail>(gitCommitUrl(ctx, sha));
}

export async function fetchGitCommitDiff(
  ctx: WorkingTreeContext,
  sha: string,
  path: string,
): Promise<GitCommitDiffResponse> {
  return fetchGitJson<GitCommitDiffResponse>(gitCommitDiffUrl(ctx, sha, path));
}

export async function fetchGitCommitFile(
  ctx: WorkingTreeContext,
  sha: string,
  path: string,
): Promise<GitCommitFileResponse> {
  return fetchGitJson<GitCommitFileResponse>(gitCommitFileUrl(ctx, sha, path));
}

export async function commitWorkingTree(body: GitWorkingTreeCommitRequest): Promise<{ ok: true; sha: string }> {
  const r = await fetch(`${base}/files/working-tree/commit`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new UnauthorizedError('/files/working-tree/commit');
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(`commit -> ${r.status} ${detail}`);
  }
  return r.json() as Promise<{ ok: true; sha: string }>;
}

export async function generateWorkingTreeCommitMessage(
  body: GitWorkingTreeCommitMessageRequest,
): Promise<{ ok: true; generating: true }> {
  const r = await fetch(`${base}/files/working-tree/commit-message`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new UnauthorizedError('/files/working-tree/commit-message');
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `commit-message -> ${r.status}`);
  }
  return r.json() as Promise<{ ok: true; generating: true }>;
}

export async function cancelWorkingTreeCommitMessage(
  body: GitWorkingTreeCommitMessageRequest,
): Promise<{ ok: true; cancelled: true }> {
  const r = await fetch(`${base}/files/working-tree/commit-message/cancel`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new UnauthorizedError('/files/working-tree/commit-message/cancel');
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `commit-message cancel -> ${r.status}`);
  }
  return r.json() as Promise<{ ok: true; cancelled: true }>;
}

export async function putWorkingTreeCommitMessage(
  body: GitWorkingTreeCommitMessageRequest & { message: string },
): Promise<void> {
  const r = await fetch(`${base}/files/working-tree/commit-message`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new UnauthorizedError('/files/working-tree/commit-message');
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `commit-message PUT -> ${r.status}`);
  }
}

export async function pushWorkingTree(
  body: GitWorkingTreePushRequest,
): Promise<GitWorkingTreePushResponse> {
  const r = await fetch(`${base}/files/working-tree/push`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new UnauthorizedError('/files/working-tree/push');
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `push -> ${r.status}`);
  }
  return r.json() as Promise<GitWorkingTreePushResponse>;
}

export async function fetchGitBranches(ctx: WorkingTreeContext): Promise<GitBranchesResponse> {
  const q = new URLSearchParams(workingTreeQuery(ctx)).toString();
  return fetchGitJson<GitBranchesResponse>(`/files/git-branches?${q}`);
}

export async function switchWorkingTreeBranch(b: GitSwitchBranchRequest): Promise<GitBranchOpResponse> {
  return postGitJson<GitBranchOpResponse>('/files/working-tree/switch-branch', b);
}

export async function createWorkingTreeBranch(b: GitCreateBranchRequest): Promise<GitBranchOpResponse> {
  return postGitJson<GitBranchOpResponse>('/files/working-tree/create-branch', b);
}

export async function fetchWorkingTreeRemotes(b: GitWorkingTreeCtxRequest): Promise<GitSyncResponse> {
  return postGitJson<GitSyncResponse>('/files/working-tree/fetch', b);
}

export async function pullWorkingTree(b: GitWorkingTreeCtxRequest): Promise<GitSyncResponse> {
  return postGitJson<GitSyncResponse>('/files/working-tree/pull', b);
}

export async function stashWorkingTree(b: GitStashRequest): Promise<void> {
  await postGitJson('/files/working-tree/stash', b);
}

export async function popWorkingTreeStash(b: GitWorkingTreeCtxRequest): Promise<void> {
  await postGitJson('/files/working-tree/stash-pop', b);
}

export async function createOperatorWorktree(b: GitCreateWorktreeRequest): Promise<GitCreateWorktreeResponse> {
  return postGitJson<GitCreateWorktreeResponse>('/files/working-tree/create-worktree', b);
}

export function gitBranchDiffUrl(ctx: WorkingTreeContext, baseRef: string, targetRef: string): string {
  const params = new URLSearchParams(workingTreeQuery(ctx));
  params.set('base', baseRef);
  params.set('target', targetRef);
  return `/files/git-branch-diff?${params.toString()}`;
}

export function gitBranchFileDiffUrl(ctx: WorkingTreeContext, fromSha: string, toSha: string, path: string): string {
  const params = new URLSearchParams(workingTreeQuery(ctx));
  params.set('from', fromSha);
  params.set('to', toSha);
  params.set('path', path);
  return `/files/git-branch-diff/file?${params.toString()}`;
}

export async function fetchGitBranchDiff(
  ctx: WorkingTreeContext,
  baseRef: string,
  targetRef: string,
): Promise<GitBranchDiffResponse> {
  return fetchGitJson<GitBranchDiffResponse>(gitBranchDiffUrl(ctx, baseRef, targetRef));
}

export async function fetchGitBranchFileDiff(
  ctx: WorkingTreeContext,
  fromSha: string,
  toSha: string,
  path: string,
): Promise<GitCommitDiffResponse> {
  return fetchGitJson<GitCommitDiffResponse>(gitBranchFileDiffUrl(ctx, fromSha, toSha, path));
}

export interface HealthLatencyResult {
  ok: boolean;
  latencyMs: number;
  version?: string;
}

export function fetchSystemResources(signal?: AbortSignal): Promise<SystemResources> {
  return getJson<SystemResources>('/system/resources', signal);
}

/** Round-trip time of one unauthenticated GET /health, in ms.
 *  Uses `cache: 'no-store'` so caching does not distort latency. */
export async function measureHealthLatency(signal?: AbortSignal): Promise<HealthLatencyResult> {
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/health`, { credentials: 'include', cache: 'no-store', signal });
    const latencyMs = performance.now() - t0;
    if (!r.ok) return { ok: false, latencyMs };
    const data = await r.json() as { ok?: boolean; version?: string };
    return { ok: true, latencyMs, version: data.version };
  } catch {
    return { ok: false, latencyMs: -1 };
  }
}

export function getSubtreeTime(conversationId: string, signal?: AbortSignal): Promise<SubtreeTimeSummary> {
  return getJson<SubtreeTimeSummary>(`/conversations/${encodeURIComponent(conversationId)}/subtree-time`, signal);
}

