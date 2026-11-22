import './loadEnv.js'; // must be first — loads the nearest .env (searches up from CWD)
import { randomBytes, randomUUID } from 'crypto';
import zlib from 'node:zlib';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { catalogue } from './catalogue.js';
import { registry } from './registry.js';
import { registerStdioAdapters } from './adapters/registerAll.js';
import { pruneUnregisteredAgents } from './db/pruneAgents.js';
import { probeClaudeRateLimits, probeClaudeInsights } from './adapters/claude-code/probeUsage.js';
import { probeAgyRateLimits, probeAgyUsageGroups, probeAntigravityInsights } from './adapters/antigravity/probeUsage.js';
import { probeCodexRateLimits, probeCodexInsights, type ProbedRateLimits } from './adapters/codex/probeUsage.js';
import { readGrokSessionSignals } from './adapters/grok-build/signals.js';
import { probeGrokRateLimits } from './adapters/grok-build/probeUsage.js';
import { GrokBotAdapter } from './adapters/grok-bot/index.js';
import { getApp } from './adapters/grok-bot/app.js';
import { resetBridgeCache } from './adapters/grok-bot/bridge.js';
import { startGrokBotWatcher } from './adapters/grok-bot/watcher.js';
import { recordGrokBotHandover, relayLateChildReply } from './adapters/grok-bot/watcherHooks.js';
import { createGrokBotSupervisor, grokBotEnabled, supervisorMessage } from './adapters/grok-bot/supervisor.js';
import { registerGrokBotRoutes } from './routes/grokBot.js';
import { createAgent as createGrokBotAgent } from './adapters/grok-bot/inject.js';
import { DEFAULT_DB_PATH, deletePluginVaultKeys, envPref, envPrefOr, pluginVaultKeyFromEnv } from './config/env.js';
import { runDir } from './config/brand.js';
import { probeKiroRateLimits, probeKiroContext } from './adapters/kiro/probeUsage.js';
import { probeCopilotRateLimits } from './adapters/copilot/probeUsage.js';
import { startModelDiscoveryScheduler, type DiscoverableAgent } from './scheduler.js';
import { registerConversationMutationRoutes } from './routes/conversations.js';
import type { ConversationRouteDeps } from './routes/conversations.js';
import { registerConversationBulkRoutes } from './routes/conversationsBulk.js';
import { registerScheduleBulkRoutes } from './routes/schedulesBulk.js';
import type { ScheduleRouteDeps } from './routes/schedules.js';
import { registerProjectMutationRoutes } from './routes/projects.js';
import { registerProjectBrowseRoutes } from './routes/projectBrowse.js';
import { registerRulePresetRoutes } from './routes/rulePresets.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerCatalogueRoutes, disposeCatalogueLogin } from './routes/catalogue.js';
import { registerFileRoutes } from './routes/files.js';
import { registerGitWorkingTreeRoutes } from './routes/gitWorkingTree.js';
import { registerGeneralSettingsRoutes, registerNotificationSettingsRoutes, registerDecisionSettingsRoutes, registerRetentionPurgeRoute, registerRetentionArchiveRoutes } from './routes/settings.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerAgentUsageRoutes, buildAgentUsageForAgent, buildUnifiedUsage, buildUsageTarget, isBuiltinUsageTarget, type AgentUsageDeps } from './routes/agentUsage.js';
import { discoverInstalledAgents } from './discovery.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { decideThenNotify, judgeInterrupt, notifyOperator, notifierDeps } from './notifications/notifier.js';
import { listPushSubscriptions, deletePushSubscription } from './repositories/pushSubscriptions.js';
import { registerSummaryRoutes } from './routes/summaries.js';
import { registerHandoffRoutes } from './routes/handoffs.js';
import { registerBtwRoutes, btwAvailability } from './routes/btw.js';
import { registerConversationTimerRoutes, registerAgentSelfTimerRoutes } from './routes/conversationTimers.js';
import { registerAgentGlobalTaskRoutes, registerGlobalTaskRoutes } from './routes/globalTasks.js';
import { registerAgentMemoryRoutes, registerOperatorMemoryRoutes } from './routes/memories.js';
import { registerAgentSearchRoutes } from './routes/agentSearch.js';
import { checkMemoryIfEnabled } from './memory/check.js';
import { countMemories } from './repositories/memories.js';
import { registerSpawnRoutes } from './routes/spawn.js';
import { registerMeshRoutes } from './routes/mesh.js';
import { getLiveEdge } from './mesh/edges.js';
import { reconcileSpawnEdges } from './spawn/rearm.js';
import { registerScheduleRoutes, registerScheduleAgentRoutes } from './routes/schedules.js';
import { registerAgentHelpRoutes } from './spawn/agentHelp.js';
import { registerSchedulePackRoutes } from './routes/schedulePacks.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSystemRoutes } from './routes/system.js';
import { JobScheduler } from './schedules/jobScheduler.js';
import { createScheduleDispatch } from './schedules/dispatch.js';
import { bindEnsureGrokBot } from './schedules/grokBotEnsure.js';
import { createConversationTimerSweep } from './schedules/conversationTimerSweep.js';
import { createUsageLimitWatcher, findUsageProvider, findBuiltinUsageCard, type UsageWatcherNotification } from './schedules/usageLimitWatcher.js';
import { registerTranscribeRoutes } from './routes/transcribe.js';
import { registerTtsRoutes } from './routes/tts.js';
import { registerEnhanceRoutes, enhanceConfigPayload } from './routes/enhance.js';
import { registerDirectLlmRoutes } from './routes/directLlm.js';
import { registerShellRoutes } from './routes/shell.js';
import { verifySessionCookieHeader, setSessionRevocation, passwordFingerprint } from './auth/cookie.js';
import { estimateTokens } from './compaction/tokenizer.js';
import { openDb, setDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedCatalogue, seedCommands, seedDefaultSettings, seedSchedulePacks, ensureRemoteAgentsProject, REMOTE_AGENTS_PROJECT_ID } from './db/seed.js';
import { SessionManager } from './sessionManager.js';
import { liveAgentStatusForSession, hasOtherInFlightSession, resolveSteerTargetSessionId } from './liveStatus.js';
import { buildActiveSessionsResponse } from './activeAgents.js';
import { conversationUpdatedFromSessionFrame, holdTerminalFrame } from './conversationUpdatedFan.js';
import { sessionHub } from './sessionHub.js';
import { awaitStopsWithBudget } from './shutdownHelpers.js';
import { getProject, deleteProject } from './repositories/projects.js';
import {
  unlinkTtsWavPaths,
  reconcileStaleTtsJobs,
  reapEphemeralTtsRecordings,
} from './repositories/ttsRecordings.js';
import { listConversations, createConversation, markConversationViewed, getConversation, updateConversationTags, setConversationsChangedListener, clearConversationPendingHandoffMode } from './repositories/conversations.js';
import { listEventsForConversation, listEventsForConversationPage, deleteEvent } from './repositories/events.js';
import { lastSessionForConversation, getConversationUsage, closeStaleSessions, applyStatusLineUsage, applyGrokSignalsUsage, applyLiveAdapterContextUsage } from './repositories/sessions.js';
import { pruneInertOperatorHoleRows } from './repositories/schedules.js';
import { getCompactionSettings, updateCompactionSettings, getGeneralSettings, getVoiceSettings, updateVoiceSettings, updateEnhanceSettings, getSidecarLlmSettings, updateSidecarLlmSettings, listTemplates, saveTemplate, deleteTemplate, invalidTemplateProfile, invalidTemplateDesignation, invalidTemplateMcp, invalidTemplateEffort, listRoleWhenPresets, saveRoleWhenPreset, deleteRoleWhenPreset, getBtwSettings, updateBtwSettings, getPluginState, listCustomDesignations, listDesignationCatalogue, addCustomDesignation, deleteCustomDesignation, getNotificationSettings, getDecisionSettings, getGlobalTasksSettings, getSessionFloorMs, bumpSessionFloor } from './repositories/settings.js';
import { insertDecisionUsage, pruneDecisionUsage, summariseDecisionUsage } from './repositories/decisionUsage.js';
import { setTimersChangedListener } from './repositories/conversationTimers.js';
import { decideDeps } from './decide.js';
import { startRetentionScheduler } from './repositories/retention.js';
import { getCapabilityProfile, listCapabilityProfiles, getDefaultCapabilityProfileId } from './repositories/capabilityProfiles.js';
import { buildResumePlan } from './compaction/compactor.js';
import { makeAdapterRunner } from './compaction/runner.js';
import { loadAuthConfig, assertAuthBindSafe } from './auth/config.js';
import { registerAuthRoutes } from './auth/routes.js';
import { requireAuth, csrfGuard } from './auth/middleware.js';
import { attachAuthenticatedWss, hostAllowedWhenAuthDisabled } from './auth/wsGuard.js';
import { LoginRateLimiter } from './auth/rateLimit.js';
import { apiErrorHandler } from './http/errorHandler.js';
import { jsonAuthed, preAuthJson, WS_OPERATOR_MAX_PAYLOAD } from './http/limits.js';
import { registerNodeEnrollRoute, registerRemoteHostRoutes } from './routes/remoteHosts.js';
import { registerNodePackageRoutes } from './routes/nodePackage.js';
import { NodeHub } from './node/nodeHub.js';
import { setCheckpointNodeHub } from './git/checkpointOps.js';
import { originGuard } from './node/originGuard.js';
import { replayTunnelRequest } from './node/tunnel.js';
import { computeSubtreeTime } from './subtreeTime.js';
import { makeLoopbackStreamReplay } from './node/tunnelStream.js';
import { RemoteAdapterProxy, createAdapterFor } from './node/proxyAdapter.js';
import { sweepRemoteInStaging } from './node/artifacts.js';
import { getRemoteHost, remoteHostIdFor } from './repositories/remoteHosts.js';
import { usageCapabilitiesFor } from './usageCapabilities.js';
import { resolveContextWindowWithFallback, setCatalogueContextWindowLookup } from './contextWindow.js';
import type {
  ClientFrame, ServerFrame, ProfilesResponse,
  ConversationsResponse, TranscriptResponse, ActiveAgentResponse, ActiveSessionsResponse,
  CompactionSettingsResponse, CreateConversationRequest, AgentStatus, CursorInsights, NotificationInput,
  RemoteHostView,
  AgentsLoginEvent,
} from '@tierwyn/shared';
import { agentSupportsPermissionMode, BUILTIN_DESIGNATIONS, canonicalCapabilityProfileId, isKnownDesignation, normaliseTags, parseOptionalDesignation } from '@tierwyn/shared';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.PORT ?? '8787', 10);
const nodeSecret = randomBytes(32).toString('hex');
// Stable copy for internal callers (sessionManager spawn URLs, etc.) after we
// strip process.env.PORT so agent/MCP children cannot re-bind our listen port.
// See: react-grab-mcp inherits PORT=8788 and steals the socket → login 404s.
process.env.TIERWYN_LISTEN_PORT = String(PORT);

import { listOneShotCapableAdapters, sidecarDeps } from './sidecar.js';
import { runGrokBotPruneSweep } from './repositories/grokBotPrune.js';
import { hiddenSweepCutoff, sweepHiddenGlobalTasks } from './repositories/globalTasks.js';
import { setAgentEnvSource, setPluginScrubKeys } from './childEnv.js';
import { captureMcpEnv } from './mcp/envFallback.js';
import { captureAaEnv } from './aa/catalogue.js';
import { refreshMcpRedactSet } from './secrets/mcpRedact.js';
import { COPILOT_ENV_NAME, loadAgentEnv, migrateCopilotTokenKey } from './secrets/agentEnv.js';
import { setCopilotTokenSource } from './adapters/copilot/index.js';
import { PluginHost } from './plugins/host.js';
import { setExtraRedactor } from './secrets/redactAll.js';
import { assertOperatorEndpointIfPresent, OutboundUrlError } from './net/outboundUrl.js';
import { scanManifests, credentialKeysFrom, activatePlugins } from './plugins/loader.js';
import { initVaultKey, vaultAvailable, vaultUnavailableReason } from './plugins/vault.js';
import { registerPluginAgentRoutes, registerPluginOperatorRoutes } from './routes/plugins.js';
import { registerMcpBridgeRoutes } from './routes/mcpBridge.js';
import { closeAllHubPipes } from './mcp/hubPipe.js';
import { registerCapabilityProfileRoutes } from './routes/capabilityProfiles.js';
import { registerSandboxSettingsRoutes } from './routes/sandboxSettings.js';
import { registerAgentEnvRoutes } from './routes/agentEnv.js';
import { registerAaRoutes } from './routes/aaSuggest.js';
import { registerMcpRoutes } from './routes/mcp.js';
import type { Database } from 'better-sqlite3';

// ── Auth (fail fast before any boot work if secrets are missing) ───────────────
const authConfig = loadAuthConfig();
if (authConfig.disabled) {
  console.warn(
    '\n  ⚠️  AUTH_DISABLED=true — authentication is OFF for every REST route and the\n' +
    '      WebSocket. This is for LOCAL DEV ONLY. Do NOT expose this server on the LAN\n' +
    '      while auth is disabled.\n',
  );
}
try {
  assertAuthBindSafe(authConfig, HOST);
} catch (e) {
  console.error(`[Tierwyn] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
if (!authConfig.disabled && !authConfig.configured) {
  console.warn(
    '\n  ⚠️  Authentication is NOT CONFIGURED. The server is running fail-closed:\n' +
    '      every request is rejected and no one can log in until you set both\n' +
    '      OPERATOR_PASSWORD_HASH and SESSION_SECRET in .env and restart.\n' +
    '      Generation commands are in .env.example.\n',
  );
}

// Plugin scan is sync so the child-env scrub list exists before any spawn (F18).
// Capture-and-delete plugin keys + auth secrets immediately after loadAuthConfig
// (F3+D4). `delete process.env.X` does not alter /proc/self/environ (F1 residual).
let db!: Database;
const pluginHost = new PluginHost({ getDb: () => db });
setExtraRedactor((t) => pluginHost.redactSecrets(t));
const scannedPlugins = scanManifests();
const pluginCredentialKeys = credentialKeysFrom(scannedPlugins);
setPluginScrubKeys(pluginCredentialKeys);
pluginHost.captureCredentials(pluginCredentialKeys);
captureMcpEnv();
captureAaEnv();
delete process.env.SESSION_SECRET;
delete process.env.OPERATOR_PASSWORD_HASH;
initVaultKey({ envKey: pluginVaultKeyFromEnv(process.env), sessionSecret: authConfig.sessionSecret });
deletePluginVaultKeys(process.env);
if (!vaultAvailable()) {
  console.warn(`[plugins] vault unavailable: ${vaultUnavailableReason()}`);
}

const loginRateLimiter = new LoginRateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
});

function readSubscriptionType(): string | undefined {
  try {
    const creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf-8'));
    return (creds?.claudeAiOauth?.subscriptionType as string) || undefined;
  } catch { return undefined; }
}

// ── Boot DB ──────────────────────────────────────────────────────────────────
const DB_PATH = envPrefOr('DB', DEFAULT_DB_PATH);
process.env.TIERWYN_DB = DB_PATH;
const dataDir = dirname(DB_PATH);
db = openDb(DB_PATH);
runMigrations(db, migrations);
seedCatalogue(db);
seedCommands(db);
seedDefaultSettings(db);
seedSchedulePacks(db);
ensureRemoteAgentsProject(db);
setDb(db);
setCatalogueContextWindowLookup((agentId, modelName) => {
  const row = db
    .prepare(
      `SELECT context_window FROM agent_models
       WHERE agent_id = ? AND model_name = ? AND context_window IS NOT NULL
       ORDER BY CASE source WHEN 'user' THEN 0 WHEN 'seed' THEN 1 ELSE 2 END
       LIMIT 1`,
    )
    .get(agentId, modelName) as { context_window: number | null } | undefined;
  return row?.context_window ?? undefined;
});
refreshMcpRedactSet(db);
migrateCopilotTokenKey(db);
setAgentEnvSource((agentType) => loadAgentEnv(db, agentType));
setCopilotTokenSource(() => loadAgentEnv(db, 'copilot').own[COPILOT_ENV_NAME]);
let sessionFloor = 0;
if (authConfig.configured) {
  sessionFloor = getSessionFloorMs(db);
  setSessionRevocation({
    floorMs: () => sessionFloor,
    passwordFp: passwordFingerprint(authConfig.sessionSecret, authConfig.passwordHash),
  });
}
// Best-effort boot sweep: drop stale `.remote-in` staging dirs left behind if
// the hub died mid-call (see invokeForRemote in node/artifacts.ts).
sweepRemoteInStaging(resolve(dataDir, 'artifacts'));
void activatePlugins(pluginHost, scannedPlugins, getPluginState(db).disabled);
{
  const stale = reconcileStaleTtsJobs(db);
  if (stale > 0) {
    console.log(`[Tierwyn] Marked ${stale} interrupted TTS job(s) as error`);
  }
  const reaped = reapEphemeralTtsRecordings(db, 10 * 60_000);
  if (reaped > 0) {
    console.log(`[Tierwyn] Reaped ${reaped} ephemeral TTS recording(s)`);
  }
}

// ── Catalogue + adapters ─────────────────────────────────────────────────────
catalogue.load(db);
registerStdioAdapters(registry, () => getCompactionSettings(db).interactionMode);
const grokSupervisor = createGrokBotSupervisor({
  db,
  isEnabled: () => grokBotEnabled(db),
  policy: () => getGeneralSettings(db).grokBotAutoStart ?? 'keep-running',
  onTransition: (s) => fanOpenClients({ type: 'grokbot_status', status: s }),
  notify: (s) => notifyOperator(db, { category: 'grokBotApp', description: supervisorMessage(s) }),
  health: () => getApp().health(),
});
registry.register('grok-bot', () => new GrokBotAdapter({
  deleteBotOnConversationDelete: () => getGeneralSettings(db).grokBotDeleteBotOnConversationDelete === true,
  ensureRunning: (r) => grokSupervisor.ensureRunning(r),
  onIngested: (botId, entryIds) => grokWatcher.noteAdapterIngested(botId, entryIds),
  attachmentsDir: join(dataDir, 'attachments'),
}), 'Grok Bot');

const prunedAgents = pruneUnregisteredAgents(db, registry.registeredTypes());
if (prunedAgents > 0) {
  console.log(`[Tierwyn] Pruned ${prunedAgents} unregistered agent type(s) from the catalogue`);
  catalogue.load(db);
}

const discoverableAgents = registry.toDiscoverableAgents();
catalogue.validateAgentTypes(registry.registeredTypes());

// Boot run populates discovered Pi models before the first /profiles fetch.
const stopDiscovery = startModelDiscoveryScheduler(db, discoverableAgents, () => {
  catalogue.load(db);
  fanOpenClients({ type: 'catalogue_updated' });
});

// Assigned in the HTTP+WS block below. Broadcast closures may run before
// that assignment (and listen is later still) — must be optional or we TDZ-crash.
let wss: WebSocketServer | undefined;

function fanOpenClients(payload: object): void {
  if (!wss) return;
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch { /* ignore */ }
    }
  }
}

setTimersChangedListener((conversationIds) => fanOpenClients({ type: 'timers_changed', conversationIds }));
setConversationsChangedListener((c) => {
  fanOpenClients({ type: 'conversations_changed', ...c });
  // ponytail: purges every deleted id on each remote project in the batch; a missing shard is a no-op. Deleted projects lose their host binding first, so their shards wait for the P3 node age sweep.
  for (const projectId of c.projectIds) {
    const hostId = remoteHostIdFor(db, { projectId });
    if (!hostId || !nodeHub.isConnected(hostId)) continue;
    const link = nodeHub.link(hostId);
    for (const deletedId of c.deletedIds ?? []) {
      void link.request('artifact.purge', { conversationId: deletedId }).catch(() => {});
    }
  }
});

function consumePendingHandoff(convId: string): void {
  if (clearConversationPendingHandoffMode(db, convId)) {
    fanOpenClients({ type: 'conversation_updated', conversationId: convId, ts: Date.now(), pendingHandoffMode: null });
  }
}

// ── Session manager ──────────────────────────────────────────────────────────
// jobScheduler is assigned below; the broadcast wrapper closes over it so
// mid-run status events can emit schedule_updated without a DB lookup.
let jobScheduler: JobScheduler;
let nodeHub: NodeHub;
// Per-conversation status frame counter: lets a held terminal frame notice a newer status.
const statusGen = new Map<string, number>();

function viewRemoteHost(id: string): RemoteHostView | undefined {
  const row = getRemoteHost(db, id);
  return row ? nodeHub.view(row) : undefined;
}

const sessionManager = new SessionManager({
  pluginHost,
  grokBotStatus: () => grokSupervisor.status(),
  remoteHosts: { view: viewRemoteHost },
  broadcastAll: (frame) => fanOpenClients(frame),
  broadcast: (conversationId, frame) => {
    sessionHub.broadcast(conversationId, frame);

    // Operator-global sidebar unread/live-status. Same helper the tests use:
    // extract status from an inner status event so non-subscribed clients
    // (sidebar) can mirror the badge live. Without this, status events only
    // reach conversation subscribers (sessionHub.broadcast above).
    const updateFrame = conversationUpdatedFromSessionFrame(conversationId, frame, Date.now());
    const helperCount = frame.type === 'event' && frame.event.type === 'helper'
      ? sessionManager.runningHelperCount(conversationId)
      : undefined;
    if (helperCount !== undefined) updateFrame.helpersRunning = helperCount;
    const eventSid = frame.type === 'event' ? frame.event.sessionId : undefined;
    const overlappingLive = (updateFrame.status === 'done' || updateFrame.status === 'idle')
      && !!eventSid
      && hasOtherInFlightSession(sessionManager.activeSessions(), conversationId, eventSid);
    // A terminal status from one session must not grey the conversation while
    // another turn is still in flight (mesh fan-in / late hold-open reap).
    const status = overlappingLive ? undefined : updateFrame.status;
    if (updateFrame.status !== undefined) {
      statusGen.set(conversationId, (statusGen.get(conversationId) ?? 0) + 1);
    }

    const isRunConv = !!jobScheduler?.lookupActiveRunByConversation(conversationId);
    let input: NotificationInput | undefined;
    if ((status === 'done' || status === 'error') && !isRunConv
        && !(status === 'done' && sessionManager.runningHelperCount(conversationId) > 0)) {
      const conv = getConversation(db, conversationId);
      input = {
        category: 'conversationComplete',
        conversationId,
        conversationTitle: conv?.title,
        description: conv?.description,
        projectName: conv ? getProject(db, conv.projectId)?.name : undefined,
        agentStatus: status,
      };
    }
    // Jev interrupt filter: only a terminal `done` frame is held (≤ decide timeout); everything
    // else, including `error`, is fanned and pushed immediately, exactly as before.
    const verdict = input ? judgeInterrupt(db, input) : undefined;
    if (verdict && input) {
      const gen = statusGen.get(conversationId);
      const pushInput = input;
      void holdTerminalFrame(updateFrame, verdict, () => statusGen.get(conversationId) !== gen, fanOpenClients)
        .then((w) => notifyOperator(db, pushInput, w))
        .catch((err) => console.warn('[notifications] held terminal frame failed:', err instanceof Error ? err.message : 'error'));
    } else {
      fanOpenClients(overlappingLive
        ? { type: 'conversation_updated', conversationId, ts: updateFrame.ts }
        : updateFrame);
      if (input) notifyOperator(db, input);
    }

    // Mid-run schedule ticks: also fan schedule_updated with agentStatus so
    // Schedules tree / ScheduleBrowser update without a full REST refetch.
    // Lookup is in-memory (JobScheduler active-run registry) — no DB hit.
    if (status !== undefined && jobScheduler) {
      const binding = jobScheduler.lookupActiveRunByConversation(conversationId);
      if (binding) {
        sessionHub.broadcastAll({
          type: 'schedule_updated',
          projectId: binding.projectId,
          jobId: binding.jobId,
          runId: binding.runId,
          runStatus: 'running',
          conversationId,
          agentStatus: status,
        });
      }
    }

    // session_started and session_ended are fanned out to EVERY client so the
    // sidebar (which doesn't subscribe to any single conversation) can mirror
    // active-session indicators in real time. Other frames go only to
    // conversation subscribers above.
    if (frame.type === 'session_started' || frame.type === 'session_ended') {
      fanOpenClients(frame);
      if (frame.type === 'session_ended') {
        fanOpenClients({ type: 'conversation_updated', conversationId, ts: Date.now(), helpersRunning: 0 });
      }
    }
  },
});

// ── Usage-limit watcher (Phase 5: notify-only) ──────────────────────────────
// Layer 1 arms candidates from terminal quota signals (sessionManager via
// setUsageWatcher below); layer 2 drains on the job tick. probeCard reuses the
// unified usage builder (force:false — cache-friendly, one probe per tick max)
// and lazily references agentUsageDeps, declared further down: drains only run
// on interval ticks, long after module init.
/** [S2-5] Watcher pushes travel their own delivery path. Shared
 *  buildNotification derives the tag from category (conversationComplete →
 *  tierwyn:conv:<id>) and renders agentStatus 'error' as "Failed", which made
 *  the watcher's push indistinguishable from a real completion push. The
 *  watcher already stamps tag/title/body — deliver those verbatim, mirroring
 *  notifier's deliver(): 404/410 prunes the subscription. */
function pushUsageWatcherNotification(push: UsageWatcherNotification): void {
  try {
    const settings = getNotificationSettings(db);
    if (!settings.enabled || !settings.conversationComplete || !settings.vapidPrivateKey) return;
    const subs = listPushSubscriptions(db);
    if (subs.length === 0) return;
    const payload = JSON.stringify({
      title: push.title,
      body: push.body,
      tag: push.tag,
      data: { conversationId: push.conversationId },
    });
    void (async () => {
      notifierDeps.setVapidDetails(settings.vapidSubject, settings.vapidPublicKey, settings.vapidPrivateKey);
      await Promise.all(subs.map(async (row) => {
        try {
          await notifierDeps.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            payload,
          );
        } catch (err) {
          const status = (err as { statusCode?: number } | null)?.statusCode;
          if (status === 404 || status === 410) {
            deletePushSubscription(db, row.endpoint);
            return;
          }
          console.warn('[usage-watcher] push send failed:', err);
        }
      }));
    })().catch((err) => console.warn('[usage-watcher] deliver failed:', err));
  } catch (err) {
    console.warn('[usage-watcher] push failed:', err);
  }
}

const usageWatcher = createUsageLimitWatcher({
  getDb: () => db,
  probeCard: async (agentType, model) => {
    const body = await buildUnifiedUsage(agentUsageDeps, pluginHost, { kind: 'operator' });
    // [S2-4b] Profile-routed lookup only: a provider whose stamped profiles
    // carry this exact agentType+model, else a builtin whose stamped profiles
    // carry the exact model. No id-equality and no any-model fallback — an
    // unmatched combo is unprobeable and the watcher classifies that as
    // unclassified (notify, never resume).
    return (
      findUsageProvider(body.providers, agentType, model) ??
      findBuiltinUsageCard(body.builtins, agentType, model) ?? {
        id: agentType,
        label: agentType,
        error: `no usage card for ${agentType}:${model}`,
      }
    );
  },
  // Notify stays ungated by usageAutoResume in Phase 5: the operator always
  // hears about a suspected limit, even with auto-resume off. [S2-5] bespoke
  // tierwyn:usage:<id> tag + [usage-watcher] identity — never the completion
  // push shape.
  notify: (push) => pushUsageWatcherNotification(push),
  // [S2-5] Quota-looking text on an agent with no usage card anywhere is
  // noise — the watcher drops (and logs) those arms instead of probing.
  hasUsageCard: (agentType, model) =>
    isBuiltinUsageTarget(agentType) || !!pluginHost.findUsageProviderForAgent?.(agentType, model),
  hasLiveSession: (conversationId) => sessionManager.hasLiveSession(conversationId),
  getSettings: () => getCompactionSettings(db),
});
sessionManager.setUsageWatcher(usageWatcher);

// ── Scheduled jobs ───────────────────────────────────────────────────────────
// Constructed before Express mounts so operator REST (run-now) and the poll
// loop share one instance; reclaim stuck runs from a prior process, then poll.
jobScheduler = new JobScheduler({
  getDb: () => db,
  dispatchTick: createScheduleDispatch({
    sessionManager,
    getDb: () => db,
    nodeHub: { link: (id) => nodeHub.link(id) },
    onComplete: (runId, result) => jobScheduler.finalizeRun(runId, result),
    registerActiveRun: (conversationId, binding) =>
      jobScheduler.registerActiveRun(conversationId, binding),
    unregisterActiveRun: (conversationId) =>
      jobScheduler.unregisterActiveRun(conversationId),
    broadcastScheduleUpdated: (projectId, jobId, detail) => {
      sessionHub.broadcastAll({ type: 'schedule_updated', projectId, jobId, ...detail });
    },
    // Kick on-demand launch without awaiting; read live status (see bindEnsureGrokBot).
    // grokSupervisor is declared ~L227, before this JobScheduler block.
    ensureGrokBot: bindEnsureGrokBot(grokSupervisor),
    remoteHostView: viewRemoteHost,
  }),
  broadcastScheduleUpdated: (projectId, jobId, detail) => {
    sessionHub.broadcastAll({ type: 'schedule_updated', projectId, jobId, ...detail });
  },
  notify: (input, w) => notifyOperator(db, input, w),
  judge: (input) => judgeInterrupt(db, input),
  // Per-conversation prompt timers. Delivery is the operator-send path
  // (handlePrompt) — deliberately NOT createScheduleDispatch, which would mint a
  // child conversation under the schedule home.
  sweepTimers: createConversationTimerSweep({
    getDb: () => db,
    handlePrompt: (input) => sessionManager.handlePrompt(input),
    onPendingHandoffConsumed: (conversationId) => consumePendingHandoff(conversationId),
  }),
  // Usage-limit watcher layer-2 drain rides the same poll (notify-only).
  sweepUsageLimits: (now) => usageWatcher.drainLayer2(now).then(() => undefined),
});
const reclaimed = jobScheduler.reclaimStuck();
if (reclaimed > 0) {
  console.log(`[Tierwyn] Reclaimed ${reclaimed} stuck schedule run(s)`);
}
{
  const pruned = pruneInertOperatorHoleRows(db, Date.now());
  if (pruned > 0) {
    console.log(`[Tierwyn] Pruned ${pruned} inert operator hole row(s)`);
  }
}
jobScheduler.start();

// ── Grok Bot inbound watcher ─────────────────────────────────────────────────
// Long-lived roster poll on the CDP singleton. Ingests unsolicited Bot output
// into pinned conversations when no Tierwyn session is open. Kill switch:
// TIERWYN_GROKBOT_WATCH=0. Interval: TIERWYN_GROKBOT_WATCH_MS (default 25000).
const grokWatcher = startGrokBotWatcher({
  db,
  getClient: () => getApp().getClient(),
  health: () => getApp().health(),
  dropClient: () => { getApp().drop(); resetBridgeCache(); },
  isLive: (conversationId) => Boolean(sessionManager.activeSessions().find((s) => s.conversationId === conversationId)),
  broadcast: (conversationId, frame) => {
    sessionHub.broadcast(conversationId, frame);
    if (frame.type === 'conversation_updated') fanOpenClients(frame);
  },
  notify: (n) => decideThenNotify(db, n),
  autoCreateEnabled: () => getGeneralSettings(db).grokBotAutoCreateRemoteAgents !== false,
  backfillEntries: () => getGeneralSettings(db).grokBotBackfillEntries,
  onCatalogueChanged: () => catalogue.load(db),
  enabled: () => grokBotEnabled(db),
  onUnreachableEdge: () => grokSupervisor.kick(),
  onHandover: (h) => recordGrokBotHandover(db, sessionManager, h),
  onReply: (conversationId, prose) => relayLateChildReply(db, sessionManager, conversationId, prose),
  attachmentsDir: join(dataDir, 'attachments'),
});

// Jev (TypeSafe System One) usage ledger: every callSystemOne records one row (fail-closed in decide.ts).
decideDeps.record = (r) => insertDecisionUsage(db, r);
// ponytail: fixed windows; add settings/a range selector when someone asks
const JEV_USAGE_RETENTION_MS = 90 * 86_400_000;
const JEV_USAGE_WINDOW_MS = 30 * 86_400_000;

// ── Retention purge (nightly) ────────────────────────────────────────────────
// Deletes unpinned chat conversations idle > conversationRetentionDays days
// (General settings; 0 = disabled). Archives each to data/archive/<id>.jsonl
// before deletion. Live sessions are skipped, never reaped.
const retentionCtl = startRetentionScheduler(db, {
  getRetentionDays: () => getGeneralSettings(db).conversationRetentionDays,
  getToolResultTrimDays: () => getGeneralSettings(db).toolResultTrimDays,
  dataDir,
  // activeSessions() includes parked hold-open sessions, so parked trees are
  // conservatively skipped (self-healing next nightly pass). BTW children
  // intentionally die with their root (accepted policy).
  isLive: (conversationId) => Boolean(sessionManager.activeSessions().find(s => s.conversationId === conversationId)),
  onNativeSessions: (sessions) => {
    void (async () => {
      for (const { agentId, nativeSessionId, projectId } of sessions) {
        try {
          // ponytail: host offline at purge time = the native file leaks on that
          // host; queue a per-host purge list if that ever matters.
          const adapter = createAdapterFor(db, agentId, { projectId });
          await adapter.deleteNativeSession?.(nativeSessionId);
        } catch (err) {
          console.error(`[retention] native unlink failed for ${agentId}/${nativeSessionId}:`, err);
        }
      }
    })();
  },
  // Phase 4: Remote Agents pruning rides the same nightly chain (one pass per settled drain).
  afterPass: () => {
    // Own try/catch so a failing ledger prune never skips the Grok Bot sweep below.
    try { pruneDecisionUsage(db, Date.now() - JEV_USAGE_RETENTION_MS); } catch (err) { console.warn('[decision-usage] prune failed:', err); }
    try {
      const cut = hiddenSweepCutoff(Date.now(), getGlobalTasksSettings(db).autoDeleteHiddenAfterDays);
      if (cut !== null) sweepHiddenGlobalTasks(db, cut);   // silent: hidden rows only, no frame
    } catch (err) { console.warn('[global-tasks] sweep failed:', err); }
    return grokBotEnabled(db) ? runGrokBotPruneSweep(db, {
      dataDir,
      eventLimit: getGeneralSettings(db).grokBotTranscriptEventLimit,
      retentionDays: getGeneralSettings(db).conversationRetentionDays,
      isLive: (id) => Boolean(sessionManager.activeSessions().find(s => s.conversationId === id)),
    }).then(() => undefined) : Promise.resolve();
  },
});

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
// Behind the reverse proxy on the same host, trust the loopback hop so req.ip
// (used as the rate-limit key) and `secure` detection reflect the real client.
// A numeric TRUST_PROXY is a hop count; Express treats the string '1' as an IP list.
const trustProxy = process.env.TRUST_PROXY?.trim();
app.set('trust proxy', !trustProxy ? 'loopback' : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
// originGuard is header-only and must run before JSON so nodeHostId can
// raise the dual-auth body cap. Public/unauth JSON is 64kb; cookie-only
// routes skip parsing until jsonAuthed after requireAuth (25mb).
app.use(originGuard({ db: () => db, nodeSecret }));
app.use(csrfGuard(authConfig));
if (authConfig.disabled) {
  app.use((req, res, next) => {
    if (hostAllowedWhenAuthDisabled(req.headers.host)) { next(); return; }
    res.status(403).json({ error: 'host not allowed (AUTH_DISABLED; set TIERWYN_ALLOWED_HOSTS)' });
  });
}

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.options('*', (_req, res) => res.sendStatus(200));

app.use(preAuthJson(authConfig));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));

// Public liveness + deploy fingerprint (gitSha / serverMode) — no auth.
registerHealthRoutes(app);

// Auth routes are public; everything mounted after requireAuth is protected.
registerAuthRoutes(app, {
  config: authConfig,
  rateLimiter: loginRateLimiter,
  onLogout: authConfig.configured
    ? () => {
        sessionFloor = bumpSessionFloor(db, Date.now());
        if (wss) {
          for (const client of wss.clients) {
            try { client.close(1008, 'session_logged_out'); } catch { /* ignore */ }
          }
        }
      }
    : undefined,
});
// Public node enroll — token-gated, rate-limited like login. MUST stay before requireAuth.
registerNodeEnrollRoute(app, { db: () => db, rateLimiter: loginRateLimiter });
registerNodePackageRoutes(app, { db: () => db, rateLimiter: loginRateLimiter });

// Dual-auth agent routes mounted BEFORE requireAuth so bearer tokens (run/spawn)
// without an operator cookie still reach the handlers.
const isOperatorAuthed = (req: import('express').Request) => authConfig.disabled
  || (authConfig.configured && verifySessionCookieHeader(req.headers.cookie, authConfig.sessionSecret, undefined, { secure: authConfig.cookieSecure }));

// /spawn is mounted BEFORE requireAuth so token-bearing agent calls (which carry
// no operator cookie) reach the handler. The route does its own auth: a valid
// ephemeral spawn token (session+conversation scoped) OR an operator session cookie.
registerSpawnRoutes(app, {
  getDb: () => db,
  sessionManager,
  isAuthed: isOperatorAuthed,
  grokBotStatus: () => grokSupervisor.status(),
  remoteHosts: { view: viewRemoteHost },
  nodeHub: { link: (id) => nodeHub.link(id) },
});
// Shared agent-usage deps: insights routes use it directly; /agent/usage is the
// unified builder (builtins + plugin providers, profiles stamped after the
// 30s provider cache). Safe to declare here: db/pluginHost are initialized
// above and every field is a closure.
const agentUsageDeps: AgentUsageDeps = {
  isInstalled: (agentType) => {
    // Pure existsSync sweep; an explicit catalogue executable_path wins.
    return discoverInstalledAgents(db).find((d) => d.agentType === agentType)?.installed ?? false;
  },
  probeClaude: (o) => probeClaudeRateLimits({ force: o.force }),
  probeClaudeInsights: (o) => probeClaudeInsights({ force: o.force }),
  probeCodex: (o) => probeCodexRateLimits({ force: o.force }),
  probeCodexInsights: (o) => probeCodexInsights({ force: o.force }),
  probeAntigravityInsights: (o) => probeAntigravityInsights({ force: o.force }),
  probeCursorInsights: async () => {
    const res = await pluginHost.invoke('cursor-usage', 'insights.get', {}, { kind: 'operator' });
    if (!res.ok) throw new Error(res.error || 'Failed to fetch Cursor insights');
    return res.data as CursorInsights;
  },
  probeGrok: (o) => probeGrokRateLimits({ force: o.force }),
  probeAgyGroups: (o) => probeAgyUsageGroups({ force: o.force }),
  probeKiro: (o) => probeKiroRateLimits({ force: o.force }),
  probeCopilot: (o) => probeCopilotRateLimits({ force: o.force }),
  listUsageProviders: () => pluginHost.listUsageProviders(),
  // Built-in (non-plugin) Jev spend card; only /settings/agent-usage appends it, so agents never see it.
  jevUsage: () => {
    const s = getDecisionSettings(db);
    const now = Date.now();
    return {
      agentType: 'jev',
      label: 'Jev · TypeSafe System One',
      kind: 'provider',
      source: 'builtin',
      installed: s.enabled && !!s.apiKey,
      builtinAvailable: true, // keeps the body visible while Jev is disabled — history still matters
      groups: [],
      installHint: 'Enable Jev and set its API key in Settings → Jev.',
      updatedAt: now,
      spend: { ...summariseDecisionUsage(db, now - JEV_USAGE_WINDOW_MS), windowLabel: 'last 30 days' },
    };
  },
};
// Hub-placed MCP bridge — node-tunnel requests only (x-tierwyn-node auth via
// originGuard), no bearer/cookie; mounted before requireAuth so the node's
// fetches reach it. Browsers hitting it without node auth get a plain 404.
registerMcpBridgeRoutes(app, { getDb: () => db });
registerPluginAgentRoutes(app, {
  host: pluginHost,
  isAuthed: isOperatorAuthed,
  getUsage: (caller) => buildUnifiedUsage(agentUsageDeps, pluginHost, caller),
  getUsageTarget: (target, caller) => buildUsageTarget(target, agentUsageDeps, pluginHost, caller),
  nodeLink: (id) => nodeHub.link(id),
  hubArtifactsRoot: resolve(dataDir, 'artifacts'),
});
registerMeshRoutes(app, {
  getDb: () => db,
  isAuthed: isOperatorAuthed,
  activeSessions: () => sessionManager.activeSessions(),
  hasLiveEdge: (from, to) => {
    if (getCompactionSettings(db).meshMessaging !== 'tree') return false;
    const e = getLiveEdge(db, from, to);
    return !!e && e.scope === 'tree' && (e.expiresAt == null || e.expiresAt > Date.now());
  },
});

// Loopback-only agent help docs (spawn/messaging/results/timer/tasks/mesh/helpers).
// Same gate as GET /agent/schedule-help — no auth, static markdown.
registerAgentHelpRoutes(app);

// Schedule agent step API — same dual-auth pattern as spawn (run token | spawn under home | cookie).
registerScheduleAgentRoutes(app, {
  getDb: () => db,
  isAuthed: isOperatorAuthed,
  broadcast: (projectId, jobId, detail) => {
    sessionHub.broadcastAll({ type: 'schedule_updated', projectId, jobId, ...detail });
  },
  remoteHostView: viewRemoteHost,
  nodeHub: { link: (id) => nodeHub.link(id) },
});

// Agent self-timers — bearer-only, so mounted before requireAuth. Operator
// timers stay on the cookie routes registered further down.
registerAgentSelfTimerRoutes(app, { getDb: () => db });

const globalTaskDeps = {
  getDb: () => db,
  isLive: (id: string) => sessionManager.hasLiveSession(id),
  broadcastAll: (f: ServerFrame) => sessionHub.broadcastAll(f),
};
registerAgentGlobalTaskRoutes(app, globalTaskDeps);

const memoryRouteDeps = {
  getDb: () => db,
  broadcastAll: (f: ServerFrame) => sessionHub.broadcastAll(f),
  checkMemory: (memoryId: number, conversationId: string) => {
    void checkMemoryIfEnabled(db, memoryId, conversationId, () => {
      sessionHub.broadcastAll({ type: 'memory_updated', counts: countMemories(db) });
    });
  },
};
registerAgentMemoryRoutes(app, memoryRouteDeps);
registerAgentSearchRoutes(app, { getDb: () => db });

app.use(requireAuth(authConfig));
app.use(jsonAuthed);

let pushRemoteHost: (id: string) => void = () => {};
let applyRemoteLoginEvent: (hostId: string, ev: AgentsLoginEvent) => void = () => {};

nodeHub = new NodeHub({
  db: () => db,
  onStatus: (host) => pushRemoteHost(host.id),
  onLoginEvent: (hostId, ev) => applyRemoteLoginEvent(hostId, ev),
  isLiveSession: (sid) => sessionManager.activeSessions().some((s) => s.id === sid),
});
nodeHub.setHttpHandler((hostId, p) => replayTunnelRequest(hostId, p, { port: PORT, nodeSecret }));
nodeHub.setStreamHandler(makeLoopbackStreamReplay({ port: PORT, nodeSecret }));
registry.setRemoteFactory((t, o) => new RemoteAdapterProxy(
  nodeHub.link(o.remoteHostId),
  t,
  {
    interactionMode: o.interactionMode ?? getCompactionSettings(db).interactionMode,
    allowMcpSecrets: getRemoteHost(db, o.remoteHostId)?.allowMcpSecrets ?? true,
    sandbox: o.sandbox === true,
    sandboxPaths: o.sandboxPaths,
    prepareEnv: () => nodeHub.syncAgentEnv(o.remoteHostId),
  },
));
sidecarDeps.hostView = viewRemoteHost;
// Checkpoint code snapshots ride git.call for remote-host projects (git.shadow).
setCheckpointNodeHub(nodeHub);

// Cookie-only remote host catalogue. NodeHub owns /ws/node (wired at attachAuthenticatedWss).
const { pushHost, applyLoginEvent } = registerRemoteHostRoutes(app, {
  db: () => db,
  hub: nodeHub,
  broadcast: (host) => fanOpenClients({ type: 'remote_host_status', host }),
  reapParkedForHost: (id) => sessionManager.reapParkedSessionsByHost(id),
});
pushRemoteHost = pushHost;
applyRemoteLoginEvent = applyLoginEvent;

registerCapabilityProfileRoutes(app, {
  getDb: () => db,
  listPluginIds: () => pluginHost.listForOperator().map((p) => p.id),
  sessionManager,
});
registerSandboxSettingsRoutes(app, {
  getDb: () => db,
  sessionManager,
  remoteStat: async (hostId, path) => {
    if (!nodeHub.isConnected(hostId)) return null;
    try {
      const st = await nodeHub.link(hostId).request<{ exists?: boolean }>('fs.statPath', { path }, 5_000);
      return { exists: st.exists === true };
    } catch {
      return null;
    }
  },
});
registerAgentEnvRoutes(app, { getDb: () => db, sessionManager, syncRemoteHosts: () => nodeHub.syncAllAgentEnv() });
registerAaRoutes(app, { getDb: () => db });

// MCP registry + native view + live status — cookie-only (after requireAuth).
registerMcpRoutes(app, {
  getDb: () => db,
  sessionManager,
  getActiveSessions: () => sessionManager.activeSessions(),
  nodeHub: { link: (id) => nodeHub.link(id) },
});

registerGrokBotRoutes(app, grokSupervisor, {
  getDb: () => db,
  getClient: () => getApp().getClient(),
  createAgent: (client, name) => createGrokBotAgent(client, name),
  onCatalogueChanged: () => {
    catalogue.load(db);
    fanOpenClients({ type: 'catalogue_updated' });
  },
  tickNow: () => grokWatcher.tickNow(),
});

app.get('/profiles', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const profiles = catalogue.listProfiles().map((p) => ({
    ...p,
    permissionCapable: agentSupportsPermissionMode(p.agentType),
  }));
  const body: ProfilesResponse = { profiles };
  res.json(body);
});

app.delete('/projects/:id', async (req, res) => {
  const id = req.params.id;
  const project = getProject(db, id);
  if (!project) { res.status(404).json({ error: 'no such project' }); return; }
  if (project.system) { res.status(409).json({ error: 'system project cannot be deleted' }); return; }
  // Stop any active agent sessions for this project's conversations first,
  // so their child subprocesses are killed before the rows go away. Without
  // this, deleting a project mid-turn would orphan the subprocess.
  const activeForProject = sessionManager.activeSessions().filter((s) => {
    const conv = getConversation(db, s.conversationId);
    return conv?.projectId === id;
  });
  await Promise.all(activeForProject.map((s) => sessionManager.stopSession(s.id).catch(() => {})));
  // Async route: a throw (e.g. FK violation) would escape Express 4 and crash the hub.
  try {
    const result = deleteProject(db, id);
    if (!result.ok) { res.status(404).json({ error: 'no such project' }); return; }
    unlinkTtsWavPaths(result.ttsWavPaths);
    res.json({ ok: true });
  } catch (err) {
    console.error('[delete-project] failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/projects/:id/conversations', (req, res) => {
  if (!getProject(db, req.params.id)) { res.status(404).json({ error: 'no such project' }); return; }
  // Migration 114: archived rows are hidden from the default list; the
  // sidebar's "Archived" view opts back in with ?includeArchived=1.
  const conversations = listConversations(db, req.params.id, {
    includeArchived: req.query.includeArchived === '1' || req.query.includeArchived === 'true',
  });
  const activeSessions = sessionManager.activeSessions();
  const sessionByConv = new Map(activeSessions.map((s) => [s.conversationId, s]));
  const activeConvIds = new Set(activeSessions.map((s) => s.conversationId));
  const conversationsWithActive = conversations.map((c) => {
    const session = sessionByConv.get(c.id);
    const liveStatus = liveAgentStatusForSession(session);
    return {
      ...c,
      isActive: activeConvIds.has(c.id),
      ...(liveStatus !== undefined ? { liveStatus } : {}),
    };
  });
  const body: ConversationsResponse = { conversations: conversationsWithActive };
  res.json(body);
});

// Global in-flight session list for the Active Agents modal. Polled while the
// modal is open; nothing computes this when nobody is looking.
app.get('/sessions/active', (_req, res) => {
  // Stamp steerQueueLength so parked-vs-pending can be decided without
  // leaking SessionRecord (adapter / AbortController) into the builder.
  // Filtering itself lives in buildActiveSessionsResponse — do not hide
  // parked sessions from activeSessions(); other subsystems still need them.
  const sessions = sessionManager.activeSessions().map((s) => ({
    id: s.id,
    conversationId: s.conversationId,
    agentType: s.agentType,
    profileId: s.profileId,
    model: s.model,
    startedAt: s.startedAt,
    lastStatus: s.lastStatus,
    steerQueueLength: s.steerQueue.length,
    ...(s.effort ? { effort: s.effort } : {}),
  }));
  const body: ActiveSessionsResponse = buildActiveSessionsResponse(
    sessions,
    (id) => getConversation(db, id),
    (id) => {
      const p = getProject(db, id);
      return p ? { id: p.id, name: p.name } : undefined;
    },
    Date.now(),
  );
  res.json(body);
});

app.post('/conversations', (req, res) => {
  const { projectId, title, templateName, spawnWorkdir, parentConversationId, capabilityProfile, designation, tags } = req.body as CreateConversationRequest;
  if (!projectId || !title) { res.status(400).json({ error: 'projectId and title required' }); return; }
  if (projectId === REMOTE_AGENTS_PROJECT_ID) {
    res.status(403).json({ error: 'conversations in Remote Agents container cannot be manually created' });
    return;
  }
  if (spawnWorkdir !== undefined && spawnWorkdir !== 'shared' && spawnWorkdir !== 'worktree') {
    res.status(400).json({ error: `invalid spawnWorkdir: ${spawnWorkdir}` });
    return;
  }
  const capProfileId = typeof capabilityProfile === 'string' && capabilityProfile.trim() ? capabilityProfile.trim() : undefined;
  if (capProfileId && !getCapabilityProfile(db, capProfileId)) {
    res.status(400).json({ error: `unknown capability profile: ${capProfileId}` });
    return;
  }
  let initialTags: string[] | undefined;
  if (tags !== undefined) {
    const normalised = normaliseTags(tags);
    if (!normalised.ok) { res.status(400).json({ error: normalised.error }); return; }
    initialTags = normalised.tags;
  }
  let desToken: string | undefined;
  if (designation !== undefined && designation !== null) {
    const parsed = parseOptionalDesignation(designation);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    if (parsed.token && !isKnownDesignation(parsed.token, listCustomDesignations(db))) {
      res.status(400).json({ error: `unknown designation: ${parsed.token}` });
      return;
    }
    desToken = parsed.token ?? undefined;
  }
  if (parentConversationId) {
    const parent = getConversation(db, parentConversationId);
    if (!parent) { res.status(400).json({ error: 'parent conversation not found' }); return; }
    if (parent.projectId !== projectId) { res.status(400).json({ error: 'parent conversation belongs to different project' }); return; }
  }
  const conv = createConversation(db, {
    projectId,
    title,
    templateName,
    spawnWorkdir,
    parentConversationId,
    capabilityProfile: capProfileId ? (canonicalCapabilityProfileId(capProfileId, getDefaultCapabilityProfileId(db)) ?? undefined) : undefined,
    designation: desToken,
  });
  res.json({ conversation: initialTags?.length ? updateConversationTags(db, conv.id, initialTags) : conv });
});

// MUST precede registerConversationMutationRoutes: that registers GET /conversations/:id,
// which would otherwise match "search" as an id. Cookie-auth via the requireAuth mounted above.
registerSearchRoutes(app, () => db);
registerProjectMutationRoutes(app, () => db, nodeHub, { sessions: sessionManager });
registerProjectBrowseRoutes(app, { getDb: () => db, nodeHub, dataDir });
registerRulePresetRoutes(app, () => db);
// FW-18: one deps object, two registrars. Bulk is registered FIRST so the exact
// path /conversations/bulk can never be shadowed by a future POST /conversations/:id
// — same discipline as registerSearchRoutes above.
const conversationRouteDeps: ConversationRouteDeps = {
  getDb: () => db,
  dataDir,
  sessionManager,
  broadcast: (conversationId, frame) => sessionHub.broadcast(conversationId, frame),
  broadcastAll: (frame) => fanOpenClients(frame),
  notifyConversationUpdated: (conversationId) => {
    const updateFrame: ServerFrame = {
      type: 'conversation_updated',
      conversationId,
      ts: Date.now(),
    };
    fanOpenClients(updateFrame);
  },
};
registerConversationBulkRoutes(app, conversationRouteDeps);
registerConversationMutationRoutes(app, conversationRouteDeps);
registerCatalogueRoutes(
  app,
  () => db,
  () => {
    catalogue.load(db);
    grokSupervisor.refresh();
    fanOpenClients({ type: 'catalogue_updated' });
  },
  { getActiveSessions: () => sessionManager.activeSessions() },
);
registerFileRoutes(app, () => db, {
  dataDir,
  nodeHub: { link: (id) => nodeHub.link(id) },
  getActiveSessions: () => sessionManager.activeSessions(),
});
registerGitWorkingTreeRoutes(app, {
  getDb: () => db,
  getActiveSessions: () => sessionManager.activeSessions(),
  broadcastAll: (frame) => sessionHub.broadcastAll(frame),
  nodeHub: { link: (id) => nodeHub.link(id) },
});
registerTranscribeRoutes(
  app,
  () => db,
  (conversationId, frame) => sessionHub.broadcast(conversationId, frame),
  sessionManager,
);
registerTtsRoutes(app, () => db);
registerEnhanceRoutes(
  app,
  () => db,
  (conversationId, frame) => sessionHub.broadcast(conversationId, frame),
);
registerDirectLlmRoutes(app, () => db);
// Operator shell — cookie-auth only. MUST stay after requireAuth (line ~302).
// Agents carry bearer tokens, not the operator cookie.
registerShellRoutes(app, { getDb: () => db, sessionManager });
registerSummaryRoutes(app, () => db);
registerHandoffRoutes(app, () => db);
const scheduleRouteDeps: ScheduleRouteDeps = {
  getDb: () => db,
  jobScheduler,
  sessionManager,
  broadcast: (projectId, jobId, detail) => {
    sessionHub.broadcastAll({ type: 'schedule_updated', projectId, jobId, ...detail });
  },
  remoteHostView: viewRemoteHost,
  nodeHub: { link: (id) => nodeHub.link(id) },
};
registerScheduleBulkRoutes(app, scheduleRouteDeps);
registerScheduleRoutes(app, scheduleRouteDeps as never);
registerSchedulePackRoutes(app, () => db);
registerBtwRoutes(app, {
  getDb: () => db,
  sessionManager,
  isAuthed: (req) => authConfig.disabled
    || (authConfig.configured && verifySessionCookieHeader(req.headers.cookie, authConfig.sessionSecret, undefined, { secure: authConfig.cookieSecure })),
});

// Per-conversation prompt timers (cookie auth via requireAuth above). The sweep
// that delivers them is wired into JobScheduler.sweepTimers, not here.
registerConversationTimerRoutes(app, { getDb: () => db });
registerGlobalTaskRoutes(app, globalTaskDeps);
registerOperatorMemoryRoutes(app, memoryRouteDeps);

app.get('/conversations/:id/transcript', (req, res) => {
  const { tailTurns: tailTurnsParam, before: beforeParam } = req.query;
  const isPaged = tailTurnsParam !== undefined || beforeParam !== undefined;

  let body: TranscriptResponse;

  if (isPaged) {
    let tailTurns = 20;
    if (tailTurnsParam !== undefined) {
      if (typeof tailTurnsParam !== 'string' || !/^\d+$/.test(tailTurnsParam)) {
        res.status(400).json({ error: 'tailTurns must be a positive integer' });
        return;
      }
      const parsed = parseInt(tailTurnsParam, 10);
      if (parsed < 1) {
        res.status(400).json({ error: 'tailTurns must be at least 1' });
        return;
      }
      tailTurns = Math.min(200, Math.max(1, parsed));
    }

    let before: string | undefined;
    if (beforeParam !== undefined) {
      if (typeof beforeParam !== 'string' || !/^\d+:\d+$/.test(beforeParam)) {
        res.status(400).json({ error: 'before must be formatted as <ts>:<seq>' });
        return;
      }
      before = beforeParam;
    }

    body = listEventsForConversationPage(db, req.params.id, { tailTurns, before });
  } else {
    body = { events: listEventsForConversation(db, req.params.id) };
  }

  const json = JSON.stringify(body);
  const acceptEncoding = req.headers['accept-encoding'];
  if (
    typeof acceptEncoding === 'string' &&
    acceptEncoding.includes('gzip') &&
    json.length > 64 * 1024
  ) {
    zlib.gzip(json, (err, compressed) => {
      if (err) {
        res.setHeader('Vary', 'Accept-Encoding');
        res.type('application/json').send(json);
        return;
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Type', 'application/json');
      res.send(compressed);
    });
    return;
  }

  res.setHeader('Vary', 'Accept-Encoding');
  res.type('application/json').send(json);
});

app.delete('/events/:id', (req, res) => {
  const ok = deleteEvent(db, req.params.id);
  if (!ok) { res.status(404).json({ error: 'no such event' }); return; }
  res.json({ ok: true });
});

app.get('/conversations/:id/active-agent', async (req, res) => {
  // When the client knows which adapter is selected it passes ?agentId= so the
  // "last session" lookup is scoped to that adapter only — otherwise switching
  // adapters would show the prior adapter's (now stale) native availability.
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  const last = lastSessionForConversation(db, req.params.id, agentId ? { agentId } : {});
  let nativeAvailable = false;
  // If there is a live in-flight session for this conversation, trust its
  // nativeSessionId directly — skip the file-existence check. The adapter
  // writes the session file only after the first successful API response, so
  // checking the file during a rate-limit retry would always return false
  // even though the session is alive.
  const liveSession = sessionManager.activeSessions().find((s) => s.conversationId === req.params.id);
  if (liveSession) {
    const liveNativeId = (liveSession.adapter as unknown as { nativeSessionId?: string }).nativeSessionId;
    if (liveNativeId && liveSession.adapter.isNativeSessionAvailable) {
      nativeAvailable = await liveSession.adapter.isNativeSessionAvailable(liveNativeId);
    }
  } else if (last?.nativeSessionId && last.agentId && registry.has(last.agentId)) {
    const adapter = createAdapterFor(db, last.agentId, { conversationId: req.params.id });
    nativeAvailable = adapter.isNativeSessionAvailable
      ? await adapter.isNativeSessionAvailable(last.nativeSessionId)
      : false;
  }
  const lastGlobal = lastSessionForConversation(db, req.params.id);
  const compactionSettings = getCompactionSettings(db);
  const contextResumable = Boolean(
    lastGlobal && (compactionSettings.compactionEnabled || compactionSettings.handoffMode === 'transcript')
  );
  const body: ActiveAgentResponse = { lastSession: last, nativeAvailable, contextResumable };
  res.json(body);
});

type StatusLinePayload = Record<string, unknown> | null;

function readJsonFile(path: string): StatusLinePayload {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; } catch { /* skip */ }
  return null;
}

/** Returns both statusLine sources for a conversation.
 *  - perSession: written by THIS Tierwyn SDK session's managedSettings.statusLine
 *    (~every 30s). Authoritative for BOTH context_window (session-scoped) and
 *    rate_limits (account-level) of the conversation we actually launched.
 *  - global: written by the TUI's ~/.claude/statusline-command.sh on every tick.
 *    Its rate_limits are account-wide and a safe fallback when no Tierwyn session
 *    is active, but its context_window belongs to a different session — never
 *    use it for a Tierwyn conversation. */
function readStatusLineFiles(conversationId: string): {
  perSession: StatusLinePayload;
  global: StatusLinePayload;
} {
  return {
    perSession: readJsonFile(join(runDir(), 'rl', `${conversationId}.json`)),
    global: readJsonFile(join(homedir(), '.claude', 'rate-limits.json')),
  };
}
app.get('/conversations/:id/usage', async (req, res) => {
  const lastForAgent = lastSessionForConversation(db, req.params.id);
  const agentType = lastForAgent?.agentId;
  const caps = usageCapabilitiesFor(agentType);

  // Resolve window size before aggregating usage so we can backfill context %
  // from the last session's token breakdown when the adapter omitted it.
  // FW-7: live listModels() first (freshest), then the catalogue-persisted
  // window, then the naming default. Before FW-7 an adapter that threw or
  // returned [] left contextWindowSize undefined and the UsagePanel showed no
  // percentage at all for any model outside the Anthropic naming regex.
  let contextWindowSize: number | undefined;
  if (caps.supportsContextWindow && lastForAgent?.agentModelId && lastForAgent.agentId && registry.has(lastForAgent.agentId)) {
    const agentId = lastForAgent.agentId;
    const profile = catalogue.getProfile(lastForAgent.agentModelId);
    if (profile) {
      contextWindowSize = await resolveContextWindowWithFallback({
        modelName: profile.model,
        storedContextWindow: profile.contextWindow,
        listModels: () => registry.create(agentId).listModels(),
      });
    }
  }

  const usage = getConversationUsage(db, req.params.id, {
    contextWindowSize,
    agentId: agentType,
  });
  if (agentType) {
    usage.agentType = agentType;
    // State what the usage is for: the reporting agent's display name.
    usage.usageSource = registry.labelFor(agentType) ?? agentType;
  }

  // Capability flags tell the UI which sections are meaningful for this agent.
  usage.supportsContextWindow = caps.supportsContextWindow;
  usage.supportsRateLimits = caps.supportsRateLimits;
  if (contextWindowSize !== undefined) usage.contextWindowSize = contextWindowSize;

  // Claude-only telemetry: rate limits, context-window %, and subscription type come
  // from ~/.claude. Reading them for non-Claude conversations would leak Claude data
  // into Pi/local usage, so skip entirely when the active agent isn't claude-code.
  if (usage.agentType === 'claude-code') {
    applyStatusLineUsage(usage, readStatusLineFiles(req.params.id));
    const subscriptionType = readSubscriptionType();
    if (subscriptionType) usage.subscriptionType = subscriptionType;
    // Freshness: when the global statusLine file stops updating (TUI closed,
    // Claude logged out elsewhere) the rate-limit numbers go stale without any
    // explicit signal. Surface the file mtime so the UI can show "stale" or
    // suppress the section after a long gap.
    const rlPath = join(homedir(), '.claude', 'rate-limits.json');
    if (existsSync(rlPath)) {
      try { usage.rateLimitsUpdatedAt = statSync(rlPath).mtimeMs; } catch { /* skip */ }
    }

    // Always pull live account rate limits via the SDK /usage probe (fresh,
    // free, ~700ms). Both the stored session value and the statusLine files go
    // stale between turns, and an "active" session can linger idle for hours —
    // gating on that hid live data from the exact conversations the user is
    // watching. The 20s cache + single-flight in probeClaudeRateLimits bound how
    // often this actually spawns a CLI; `fresh=1` (refresh button) bypasses the
    // cache. Overwrites the stored/file values because the probe is strictly newer.
    try {
      const live = await probeClaudeRateLimits({ cwd: process.cwd(), force: req.query.fresh === '1' });
      if (live.fiveHourPct !== undefined) usage.fiveHourPct = live.fiveHourPct;
      if (live.fiveHourResetsAt !== undefined) usage.fiveHourResetsAt = live.fiveHourResetsAt;
      if (live.sevenDayPct !== undefined) usage.sevenDayPct = live.sevenDayPct;
      if (live.sevenDayResetsAt !== undefined) usage.sevenDayResetsAt = live.sevenDayResetsAt;
      if (live.subscriptionType) usage.subscriptionType = live.subscriptionType;
      if (live.extraUsageUsed !== undefined) usage.extraUsageUsed = live.extraUsageUsed;
      if (live.extraUsageLimit !== undefined) usage.extraUsageLimit = live.extraUsageLimit;
      if (live.extraUsagePct !== undefined) usage.extraUsagePct = live.extraUsagePct;
      if (live.extraUsageCurrency !== undefined) usage.extraUsageCurrency = live.extraUsageCurrency;
      if (live.fiveHourPct !== undefined || live.sevenDayPct !== undefined || live.extraUsageUsed !== undefined) {
        usage.rateLimitsUpdatedAt = Date.now();
      }
    } catch { /* keep stored/file values on probe failure */ }
  }

  // Grok Build: overlay durable session signals.json (same numbers /session-info
  // shows). Works for resumable native sessions without running a slash turn.
  // Prefer live adapter native id when a session is held open; else last row.
  if (usage.agentType === 'grok-build') {
    // Grok billing is weekly credits only — never a 5h window. Drop any seed
    // that survived from an earlier agent in this conversation.
    delete usage.fiveHourPct;
    delete usage.fiveHourResetsAt;
    usage.longWindowLabel = 'weekly window used';

    let nativeId = lastForAgent?.nativeSessionId;
    const liveSession = sessionManager.activeSessions().find((s) => s.conversationId === req.params.id);
    if (liveSession) {
      const liveNative = (liveSession.adapter as { nativeSessionId?: string }).nativeSessionId;
      if (liveNative) nativeId = liveNative;
    }
    if (nativeId) {
      const conv = getConversation(db, req.params.id);
      const project = conv ? getProject(db, conv.projectId) : undefined;
      // Worktree children run under spawnWorkdir path; shared uses project root.
      const cwd = conv?.workdirPath ?? project?.rootPath;
      const signals = readGrokSessionSignals(nativeId, { cwd });
      applyGrokSignalsUsage(usage, signals);
      if (signals?.mtimeMs !== undefined) {
        // Reuse rateLimitsUpdatedAt as a generic "telemetry file freshness"
        // stamp until the billing probe below overwrites it.
        usage.rateLimitsUpdatedAt = signals.mtimeMs;
      }
    }
    // Account weekly credits via throwaway `grok agent --no-leader stdio` +
    // `_x.ai/billing` (same payload /usage uses). 20s cache + single-flight;
    // `fresh=1` (refresh button) bypasses the cache. Probe failure keeps
    // context-window numbers from signals.json.
    try {
      const live = await probeGrokRateLimits({ force: req.query.fresh === '1' });
      if (live.sevenDayPct !== undefined) usage.sevenDayPct = live.sevenDayPct;
      if (live.sevenDayResetsAt !== undefined) usage.sevenDayResetsAt = live.sevenDayResetsAt;
      if (live.subscriptionType) usage.subscriptionType = live.subscriptionType;
      if (live.prepaidBalance !== undefined) usage.prepaidBalance = live.prepaidBalance;
      if (live.onDemandUsed !== undefined) usage.onDemandUsed = live.onDemandUsed;
      if (live.onDemandCap !== undefined) usage.onDemandCap = live.onDemandCap;
      if (
        live.sevenDayPct !== undefined
        || live.sevenDayResetsAt !== undefined
        || live.prepaidBalance !== undefined
        || live.onDemandUsed !== undefined
        || live.onDemandCap !== undefined
      ) {
        usage.rateLimitsUpdatedAt = Date.now();
      }
    } catch { /* keep signals overlay on probe failure */ }
  }

  // Antigravity: overlay live account rate limits from the free print-mode
  // `agy --print "/usage" --output-format json` probe (zero tokens, zero
  // turns). Stored values come from the in-band turn-end overlay and go stale
  // between turns; the probe's 20s cache + single-flight bound how often this
  // actually spawns the CLI; `fresh=1` (refresh button) bypasses the cache.
  // Group selection keys off the conversation's last model (Gemini vs
  // Claude/GPT buckets). Probe failure keeps the stored values.
  if (usage.agentType === 'antigravity') {
    const agyProfile = lastForAgent?.agentModelId ? catalogue.getProfile(lastForAgent.agentModelId) : undefined;
    const model = agyProfile?.model ?? '';
    try {
      const live = await probeAgyRateLimits({ model, force: req.query.fresh === '1' });
      if (live.fiveHourPct !== undefined) usage.fiveHourPct = live.fiveHourPct;
      if (live.fiveHourResetsAt !== undefined) usage.fiveHourResetsAt = live.fiveHourResetsAt;
      if (live.sevenDayPct !== undefined) usage.sevenDayPct = live.sevenDayPct;
      if (live.sevenDayResetsAt !== undefined) usage.sevenDayResetsAt = live.sevenDayResetsAt;
      if (live.subscriptionType) usage.subscriptionType = live.subscriptionType;
      if (live.fiveHourPct !== undefined || live.sevenDayPct !== undefined) {
        usage.rateLimitsUpdatedAt = Date.now();
      }
    } catch { /* keep stored values on probe failure */ }
  }

  // Codex: overlay live account rate limits from a throwaway `codex app-server`
  // probe (initialize + account/rateLimits/read — zero tokens, no thread).
  // (same cache/single-flight/fresh=1 contract as the grok/antigravity probes)
  if (usage.agentType === 'codex') {
    // A live session's account/rateLimits/updated pushes are fresher than any
    // probe and free — overlay them last, on top of the probe result.
    try {
      const live = await probeCodexRateLimits({ force: req.query.fresh === '1' });
      if (live.fiveHourPct !== undefined) usage.fiveHourPct = live.fiveHourPct;
      if (live.fiveHourResetsAt !== undefined) usage.fiveHourResetsAt = live.fiveHourResetsAt;
      if (live.sevenDayPct !== undefined) usage.sevenDayPct = live.sevenDayPct;
      if (live.sevenDayResetsAt !== undefined) usage.sevenDayResetsAt = live.sevenDayResetsAt;
      if (live.subscriptionType) usage.subscriptionType = live.subscriptionType;
      if (live.manualResetsAvailable !== undefined) usage.manualResetsAvailable = live.manualResetsAvailable;
      if (live.creditsBalance !== undefined) usage.creditsBalance = live.creditsBalance;
      if (live.hasCredits !== undefined) usage.hasCredits = live.hasCredits;
      if (live.unlimitedCredits !== undefined) usage.unlimitedCredits = live.unlimitedCredits;
      if (live.longWindowLabel !== undefined) usage.longWindowLabel = live.longWindowLabel;
      if (live.fiveHourPct !== undefined || live.sevenDayPct !== undefined) {
        usage.rateLimitsUpdatedAt = Date.now();
      }
    } catch { /* keep stored values on probe failure */ }
    const liveSession = sessionManager.activeSessionForConversation(req.params.id);
    const liveLimits = (liveSession?.adapter as { getLiveRateLimits?: () => ProbedRateLimits | undefined } | undefined)?.getLiveRateLimits?.();
    if (liveLimits) {
      if (liveLimits.fiveHourPct !== undefined) usage.fiveHourPct = liveLimits.fiveHourPct;
      if (liveLimits.fiveHourResetsAt !== undefined) usage.fiveHourResetsAt = liveLimits.fiveHourResetsAt;
      if (liveLimits.sevenDayPct !== undefined) usage.sevenDayPct = liveLimits.sevenDayPct;
      if (liveLimits.sevenDayResetsAt !== undefined) usage.sevenDayResetsAt = liveLimits.sevenDayResetsAt;
      if (liveLimits.subscriptionType) usage.subscriptionType = liveLimits.subscriptionType;
      if (liveLimits.manualResetsAvailable !== undefined) usage.manualResetsAvailable = liveLimits.manualResetsAvailable;
      if (liveLimits.creditsBalance !== undefined) usage.creditsBalance = liveLimits.creditsBalance;
      if (liveLimits.hasCredits !== undefined) usage.hasCredits = liveLimits.hasCredits;
      if (liveLimits.unlimitedCredits !== undefined) usage.unlimitedCredits = liveLimits.unlimitedCredits;
      if (liveLimits.longWindowLabel !== undefined) usage.longWindowLabel = liveLimits.longWindowLabel;
      if (liveLimits.fiveHourPct !== undefined || liveLimits.sevenDayPct !== undefined) {
        usage.rateLimitsUpdatedAt = Date.now();
      }
    }
  }

  // Copilot: monthly premium requests from api.github.com/copilot_internal/user.
  if (usage.agentType === 'copilot') {
    try {
      const live = await probeCopilotRateLimits({ force: req.query.fresh === '1' });
      if (live.monthlyPct !== undefined) usage.monthlyPct = live.monthlyPct;
      if (live.monthlyResetsAt !== undefined) usage.monthlyResetsAt = live.monthlyResetsAt;
      if (live.creditsUsed !== undefined) usage.creditsUsed = live.creditsUsed;
      if (live.creditsLimit !== undefined) usage.creditsLimit = live.creditsLimit;
      if (live.unlimitedCredits !== undefined) usage.unlimitedCredits = live.unlimitedCredits;
      if (live.subscriptionType) usage.subscriptionType = live.subscriptionType;
      usage.rateLimitsUpdatedAt = Date.now();
    } catch { /* keep stored values on probe failure */ }
  }

  // Kiro: overlay account monthly credits from `kiro-cli chat --no-interactive
  // /usage` (zero model burn; stderr on older CLIs, stdout on newer). Stored sessions have no monthly columns;
  // the probe is the only source. `fresh=1` bypasses the 20s cache.
  // Optional `/context` breakdown is best-effort: skip when no native session
  // id; failure must not break the route. Overall context % prefers live ACP
  // (applied below), then the last persisted ACP snapshot, then /context.
  if (usage.agentType === 'kiro') {
    try {
      const live = await probeKiroRateLimits({ force: req.query.fresh === '1' });
      if (live.monthlyPct !== undefined) usage.monthlyPct = live.monthlyPct;
      if (live.monthlyResetsAt !== undefined) usage.monthlyResetsAt = live.monthlyResetsAt;
      if (live.creditsUsed !== undefined) usage.creditsUsed = live.creditsUsed;
      if (live.creditsLimit !== undefined) usage.creditsLimit = live.creditsLimit;
      if (live.subscriptionType) usage.subscriptionType = live.subscriptionType;
      if (live.monthlyPct !== undefined || live.creditsUsed !== undefined || live.monthlyResetsAt !== undefined) {
        usage.rateLimitsUpdatedAt = Date.now();
      }
    } catch { /* keep stored values on probe failure */ }

    let nativeId = lastForAgent?.nativeSessionId;
    const liveKiroSession = sessionManager.activeSessions().find((s) => s.conversationId === req.params.id);
    if (liveKiroSession) {
      const liveNative = (liveKiroSession.adapter as { nativeSessionId?: string }).nativeSessionId;
      if (liveNative) nativeId = liveNative;
    }
    if (nativeId) {
      try {
        const conv = getConversation(db, req.params.id);
        const project = conv ? getProject(db, conv.projectId) : undefined;
        const cwd = conv?.workdirPath ?? project?.rootPath;
        const ctx = await probeKiroContext({
          resumeId: nativeId,
          cwd,
          force: req.query.fresh === '1',
        });
        if (ctx.contextWindowPct !== undefined && usage.contextWindowPct === undefined) {
          usage.contextWindowPct = ctx.contextWindowPct;
        }
        if (ctx.contextBreakdown) usage.contextBreakdown = ctx.contextBreakdown;
      } catch { /* best-effort; ACP % still renders */ }
    }
  }

  // Mid-turn context %: while a session is running, adapters that track per-step
  // occupancy expose fresher numbers than the last persisted turn-end snapshot.
  if (caps.supportsContextWindow) {
    const liveSession = sessionManager.activeSessionForConversation(req.params.id);
    const liveCtx = liveSession?.adapter.getLiveContextWindowUsage?.();
    if (liveCtx) applyLiveAdapterContextUsage(usage, liveCtx);
  }

  // Dynamic Plugin Usage Providers: if the conversation's agent or model matches
  // a plugin usageProvider pattern (e.g. Cursor or Z.AI), pull live rate limits / quota.
  if (pluginHost && usage.agentType) {
    const profile = lastForAgent?.agentModelId ? catalogue.getProfile(lastForAgent.agentModelId) : undefined;
    const modelName = profile?.model;
    const providerMatch = pluginHost.findUsageProviderForAgent(usage.agentType, modelName);
    if (providerMatch) {
      // The allowance comes from this provider, not the agent CLI — label it.
      usage.usageProvider = providerMatch.label;
      try {
        const res = await pluginHost.invoke(providerMatch.pluginId, providerMatch.capability, {
          agentType: usage.agentType,
          model: modelName,
        }, {
          kind: 'operator',
          conversationId: req.params.id,
        });
        if (res.ok && res.data && typeof res.data === 'object') {
          const d = res.data as Record<string, unknown>;
          delete usage.fiveHourPct;
          delete usage.fiveHourResetsAt;
          delete usage.sevenDayPct;
          delete usage.sevenDayResetsAt;
          delete usage.monthlyPct;
          delete usage.monthlyResetsAt;
          delete usage.creditsUsed;
          delete usage.creditsLimit;
          delete usage.onDemandUsed;
          delete usage.onDemandCap;
          delete usage.monthlyWindowLabel;
          delete usage.longWindowLabel;
          delete usage.prepaidBalance;
          delete usage.hasCredits;

          if (typeof d.fiveHourPct === 'number') usage.fiveHourPct = d.fiveHourPct;
          if (typeof d.fiveHourResetsAt === 'number') usage.fiveHourResetsAt = d.fiveHourResetsAt;
          if (typeof d.sevenDayPct === 'number') usage.sevenDayPct = d.sevenDayPct;
          if (typeof d.sevenDayResetsAt === 'number') usage.sevenDayResetsAt = d.sevenDayResetsAt;
          if (typeof d.monthlyPct === 'number') usage.monthlyPct = d.monthlyPct;
          if (typeof d.monthlyResetsAt === 'number') usage.monthlyResetsAt = d.monthlyResetsAt;
          if (typeof d.creditsUsed === 'number') usage.creditsUsed = d.creditsUsed;
          if (typeof d.creditsLimit === 'number') usage.creditsLimit = d.creditsLimit;
          if (typeof d.onDemandUsed === 'number') usage.onDemandUsed = d.onDemandUsed;
          if (typeof d.onDemandCap === 'number') usage.onDemandCap = d.onDemandCap;
          if (typeof d.monthlyWindowLabel === 'string') usage.monthlyWindowLabel = d.monthlyWindowLabel;
          if (typeof d.longWindowLabel === 'string') usage.longWindowLabel = d.longWindowLabel;
          if (typeof d.prepaidBalance === 'number') usage.prepaidBalance = d.prepaidBalance;
          if (typeof d.hasCredits === 'boolean') usage.hasCredits = d.hasCredits;
          const providerSub = typeof d.plan === 'string' ? d.plan
            : typeof d.subscriptionType === 'string' ? d.subscriptionType
            : undefined;
          if (providerSub) usage.providerSubscriptionType = providerSub;
          usage.supportsRateLimits = true;
          usage.rateLimitsUpdatedAt = typeof d.fetchedAt === 'number' ? d.fetchedAt : Date.now();
        }
      } catch { /* plugin fetch failed; keep stored telemetry */ }
    }
  }

  res.json({ usage });
});

app.get('/conversations/:id/subtree-time', async (req, res) => {
  if (!getConversation(db, req.params.id)) return res.status(404).json({ error: 'not_found' });
  try {
    res.json(await computeSubtreeTime(db, req.params.id));
  } catch (err) {
    console.error('[subtreeTime] failed to compute subtree time for', req.params.id, err);
    res.status(500).json({ error: 'internal' });
  }
});

// NOTE: not idempotent — on the 'compacted' path buildResumePlan() calls compact(),
// which burns an LLM call AND persists a summary row. Safe today (no client calls this),
// but do NOT wire it up as a cheap "preview" without a dry-run flag through compact().
app.get('/conversations/:id/resume-plan', async (req, res) => {
  const runner = makeAdapterRunner({
    // ponytail: compaction summariser stays on the hub; the preferred agent must be installed locally
    createAdapter: (t, opts) => registry.create(t, opts),
    resolveModel: (pid) => catalogue.getProfile(pid)?.model ?? '',
    cwd: process.cwd(),
  });
  const last = lastSessionForConversation(db, req.params.id);
  const plan = await buildResumePlan(db, req.params.id, {
    runner,
    estimate: (t) => estimateTokens(t),
    isNativeAvailable: async (nativeId) => {
      if (!last?.agentId || !registry.has(last.agentId)) return false;
      const adapter = createAdapterFor(db, last.agentId, { conversationId: req.params.id });
      return adapter.isNativeSessionAvailable ? adapter.isNativeSessionAvailable(nativeId) : false;
    },
    // Resolve the target adapter/model's context window from its live
    // listModels(). override is not available here (no prompt context) so the
    // global handoffMode is honoured.
    getTargetContextWindow: async () => {
      try {
        if (!last?.agentId || !last?.agentModelId || !registry.has(last.agentId)) return Infinity;
        const adapter = createAdapterFor(db, last.agentId, { conversationId: req.params.id });
        const models = await adapter.listModels();
        const profile = catalogue.getProfile(last.agentModelId);
        const targetName = profile?.model;
        if (!targetName) return Infinity;
        const hit = models.find((m) => m.name === targetName);
        return hit?.contextWindow ?? Infinity;
      } catch {
        return Infinity;
      }
    },
  });
  res.json({ plan });
});

app.get('/settings/compaction', (_req, res) => {
  const body: CompactionSettingsResponse = { settings: getCompactionSettings(db) };
  res.json(body);
});

app.post('/settings/compaction', (req, res) => {
  const body: CompactionSettingsResponse = { settings: updateCompactionSettings(db, req.body) };
  res.json(body);
});

registerGeneralSettingsRoutes(app, () => db, () => grokSupervisor.refresh());
registerNotificationSettingsRoutes(app, () => db);
registerDecisionSettingsRoutes(app, () => db);
registerAgentUsageRoutes(app, agentUsageDeps);
registerPluginOperatorRoutes(app, { host: pluginHost, getDb: () => db });
registerNotificationRoutes(app, () => db);
registerRetentionPurgeRoute(app, {
  getRetentionDays: () => getGeneralSettings(db).conversationRetentionDays,
  runNow: () => retentionCtl.runNow(),
  getDb: () => db,
  dataDir,
  dbPath: DB_PATH,
  isPurgeRunning: () => retentionCtl.isRunning(),
});
registerRetentionArchiveRoutes(app, { getDb: () => db, dataDir });
// FW-17: on-disk database backups (cookie auth, same as the other /settings routes).
registerBackupRoutes(app, { getDb: () => db, dbPath: DB_PATH, dataDir });
registerSystemRoutes(app, { dataDir });

app.get('/settings/btw', (_req, res) => {
  res.json({ settings: getBtwSettings(db), availability: btwAvailability(db) });
});

app.post('/settings/btw', (req, res) => {
  res.json({ settings: updateBtwSettings(db, req.body) });
});

// Voice / STT cleanup config — server-side (the LLM endpoint is a property of
// the server environment, not the per-device browser). Mirrors /settings/compaction.
app.get('/settings/voice', (_req, res) => {
  res.json({ settings: getVoiceSettings(db) });
});

app.post('/settings/voice', async (req, res) => {
  const body = (req.body ?? {}) as { tts?: { piperUrl?: unknown; kokoroUrl?: unknown }; cleanup?: { baseUrl?: unknown } };
  try {
    await assertOperatorEndpointIfPresent(body.tts?.piperUrl);
    await assertOperatorEndpointIfPresent(body.tts?.kokoroUrl);
    await assertOperatorEndpointIfPresent(body.cleanup?.baseUrl);
  } catch (e) {
    if (e instanceof OutboundUrlError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
  res.json({ settings: updateVoiceSettings(db, req.body) });
});

// Prompt enhancer — own LLM config (sibling to voice cleanup).
app.get('/settings/enhance', (_req, res) => {
  res.json(enhanceConfigPayload(db));
});

app.post('/settings/enhance', async (req, res) => {
  const body = (req.body ?? {}) as { baseUrl?: unknown };
  try {
    await assertOperatorEndpointIfPresent(body.baseUrl);
  } catch (e) {
    if (e instanceof OutboundUrlError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
  res.json({ settings: updateEnhanceSettings(db, req.body) });
});

app.get('/settings/sidecar-llm', (_req, res) => {
  res.json({
    settings: getSidecarLlmSettings(db),
    capableAdapters: listOneShotCapableAdapters(),
  });
});

app.post('/settings/sidecar-llm', (req, res) => {
  try {
    const capable = listOneShotCapableAdapters();
    res.json({
      settings: updateSidecarLlmSettings(db, req.body, capable),
      capableAdapters: capable,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'invalid sidecar llm settings' });
  }
});

// Spawn delegation templates (named role rosters stored as a settings blob).
app.get('/settings/templates', (_req, res) => res.json({ templates: listTemplates(db) }));
app.post('/settings/templates', (req, res) => {
  const bad = invalidTemplateProfile(req.body);
  if (bad) { res.status(400).json({ error: `template role points at unknown or disabled profile: ${bad}` }); return; }
  const badDes = invalidTemplateDesignation(req.body, listCustomDesignations(db));
  if (badDes) { res.status(400).json({ error: `unknown designation: ${badDes}` }); return; }
  const badMcp = invalidTemplateMcp(req.body);
  if (badMcp) { res.status(400).json({ error: badMcp }); return; }
  const badEffort = invalidTemplateEffort(req.body);
  if (badEffort) { res.status(400).json({ error: `invalid effort: ${badEffort}` }); return; }
  res.json({ templates: saveTemplate(db, req.body) });
});
app.delete('/settings/templates/:name', (req, res) => res.json({ templates: deleteTemplate(db, req.params.name) }));

// Reusable "used when" presets for template roles (settings blob, no SQL table).
app.get('/settings/role-presets', (_req, res) => res.json({ presets: listRoleWhenPresets(db) }));
app.post('/settings/role-presets', (req, res) => {
  const body = req.body as { id?: string; name?: string; when?: string };
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  // Client mints id via crypto.randomUUID(); server trusts it when present.
  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID();
  const when = typeof body.when === 'string' ? body.when : '';
  res.json({ presets: saveRoleWhenPreset(db, { id, name, when }) });
});
app.delete('/settings/role-presets/:id', (req, res) =>
  res.json({ presets: deleteRoleWhenPreset(db, req.params.id) }));

app.get('/settings/designations', (_req, res) => {
  res.json({
    builtins: [...BUILTIN_DESIGNATIONS],
    custom: listCustomDesignations(db),
    catalogue: listDesignationCatalogue(db),
  });
});
app.post('/settings/designations', (req, res) => {
  const result = addCustomDesignation(db, (req.body as { token?: unknown })?.token);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  res.json({
    builtins: [...BUILTIN_DESIGNATIONS],
    custom: result.custom,
    catalogue: listDesignationCatalogue(db),
  });
});
app.delete('/settings/designations/:token', (req, res) => {
  const result = deleteCustomDesignation(db, req.params.token);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  res.json({
    builtins: [...BUILTIN_DESIGNATIONS],
    custom: result.custom,
    catalogue: listDesignationCatalogue(db),
  });
});

app.use(apiErrorHandler);

// ── HTTP + WS servers ────────────────────────────────────────────────────────
const httpServer = createServer(app);
// noServer + manual upgrade handling so the session cookie is verified during
// the HTTP upgrade and unauthenticated sockets are rejected before any
// WebSocket/subscription is created.
const socketServer = new WebSocketServer({ noServer: true, maxPayload: WS_OPERATOR_MAX_PAYLOAD });
wss = socketServer;
attachAuthenticatedWss(httpServer, socketServer, authConfig, {
  onNodeUpgrade: (req, socket, head) => nodeHub.handleUpgrade(req, socket, head),
});

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

socketServer.on('connection', (ws: WebSocket) => {
  send(ws, { type: 'heartbeat', ts: Date.now(), connected: true });
  // Hydrate in-flight session dots on refresh/reconnect without re-firing
  // session_started (which always pins 'running' and would mis-tint parked sessions).
  const snapshotSessions = sessionManager.activeSessions().flatMap((s) => {
    const status = liveAgentStatusForSession(s);
    const helpersRunning = s.runningHelpers?.size ?? 0;
    // Parked sessions with running helpers carry their terminal status so the
    // sidebar can show the helpers-active ring after refresh.
    if (!status && helpersRunning === 0) return [];
    return [{
      conversationId: s.conversationId,
      sessionId: s.id,
      profileId: s.profileId,
      model: s.model,
      status: status ?? s.lastStatus ?? 'done',
      ...(helpersRunning > 0 ? { helpersRunning } : {}),
    }];
  });
  if (snapshotSessions.length > 0) {
    send(ws, { type: 'active_sessions', sessions: snapshotSessions });
  }
  const heartbeat = setInterval(
    () => send(ws, { type: 'heartbeat', ts: Date.now(), connected: true }), 30_000
  );
  const sendable = { send: (f: ServerFrame) => send(ws, f) };
  // Register the socket for operator-global broadcasts (e.g. spawn-request
  // approval signals) so they reach the operator regardless of which
  // conversation (if any) is currently subscribed. Dropped in the close/error handlers below.
  sessionHub.register(sendable);

  ws.on('message', async (raw) => {
    let frame: ClientFrame;
    try { frame = JSON.parse(raw.toString()) as ClientFrame; } catch { return; }

    // Latency probe: echo immediately. Must stay the first branch so RTT
    // measures the socket, not whatever DB work a later branch would do.
    if (frame.type === 'ping') {
      send(ws, { type: 'pong', id: frame.id, clientTs: frame.clientTs, serverTs: Date.now() });
      return;
    }

    if (frame.type === 'subscribe') {
      sessionHub.subscribe(frame.conversationId, sendable);
      // Subscribe is the canonical "user opened this conversation" signal —
      // it fires on conversation switch and on WS reconnect (ws.ts re-sends
      // the subscribe on open). Marking viewed here drops the sticky 'error'
      // or 'done' from the sidebar dot once the user has seen it. Idempotent;
      // wrapped so a DB hiccup doesn't kill the subscribe itself.
      try { markConversationViewed(db, frame.conversationId); } catch { /* non-fatal */ }
      try {
        const active = sessionManager.activeSessions().find((s) => s.conversationId === frame.conversationId);
        if (active) {
          // Re-advertise the live session id so the client restores
          // currentSessionId after a reconnect/conversation-switch. Without
          // this, a session blocked on a pending interaction_request
          // (AskUserQuestion / permission gate) can't be answered or stopped:
          // ws.ts clears currentSessionId on disconnect and only ever sets it
          // from a session_started frame, which the server otherwise never
          // re-sends. The client's session_started handler is idempotent.
          send(ws, {
            type: 'session_started',
            conversationId: frame.conversationId,
            sessionId: active.id,
            profileId: active.profileId,
            model: active.model,
          });
          send(ws, {
            type: 'steer_queue',
            conversationId: frame.conversationId,
            queue: active.steerQueue,
          });
          // ponytail: session_started makes the client pin wsStatus='running'.
          // For adapters that keep the subprocess alive between turns
          // (hold-open steer loop), the session record is still in the map
          // even though lastStatus='done'. Re-publish the terminal status so
          // the UI doesn't stay stuck on orange with a dead Stop button.
          const terminalStatus = active.lastStatus;
          if (terminalStatus === 'done' || terminalStatus === 'error') {
            send(ws, {
              type: 'conversation_updated',
              conversationId: frame.conversationId,
              ts: Date.now(),
              status: terminalStatus,
            });
          }
        }
      } catch { /* non-fatal */ }
      return;
    }
    if (frame.type === 'stop') {
      // Reply only to the requester. The side-effect (session_ended) is
      // broadcast separately via the SessionManager.deps.broadcast fan-out.
      const result = await sessionManager.stopSession(frame.sessionId, { initiatedBy: 'operator' });
      send(ws, {
        type: 'stop_result',
        sessionId: frame.sessionId,
        success: result.stopped,
        reason: result.reason,
        message: result.message,
      });
      return;
    }
    if (frame.type === 'steer') {
      // A steer that carries a resume override consumes the staged + menu action.
      // A plain steer into a live turn keeps it for the next send.
      if (frame.handoffOverride) consumePendingHandoff(frame.conversationId);
      // Reply only to the requester. The queued-indicator side-effect
      // (steer_queued) is broadcast separately to subscribers from inside
      // steerSession via the SessionManager.deps.broadcast fan-out.
      // Clients may steer in the pre-session_started window with a missing
      // id — resolve to the conversation's in-flight session so queue/force
      // intent survives (plain prompt-adopt would silently auto-queue).
      const sessionId = resolveSteerTargetSessionId(
        frame.sessionId,
        frame.conversationId,
        (id) => sessionManager.getSession(id),
        (cid) => sessionManager.inFlightSessionForConversation(cid),
      );
      const result = await sessionManager.steerSession(
        sessionId,
        frame.text,
        frame.attachments,
        {
          intent: frame.intent,
          ...(frame.commandName ? { commandName: frame.commandName } : {}),
          ...(frame.commandArgs !== undefined ? { commandArgs: frame.commandArgs } : {}),
          ...(frame.handoffOverride === 'fresh' || frame.handoffOverride === 'summary' || frame.handoffOverride === 'transcript'
            ? { handoffOverride: frame.handoffOverride } : {}),
          recall: !frame.commandName,
        },
      );
      send(ws, {
        type: 'steer_result',
        sessionId,
        mode: result.mode,
        queueLength: result.queueLength,
        message: result.message,
      });
      return;
    }
    if (frame.type === 'cancel_steer') {
      await sessionManager.cancelSteerMessage(frame.conversationId, frame.sessionId, frame.messageId);
      return;
    }
    if (frame.type === 'stop_helper') {
      if (typeof frame.conversationId === 'string' && typeof frame.taskId === 'string' && frame.taskId.length <= 200) {
        await sessionManager.stopHelper(frame.conversationId, frame.taskId);
      }
      return;
    }
    if (frame.type === 'edit_steer') {
      await sessionManager.editSteerMessage(
        frame.conversationId,
        frame.sessionId,
        frame.messageId,
        frame.text,
        frame.attachments,
        {
          ...(frame.commandName ? { commandName: frame.commandName } : {}),
          ...(frame.commandArgs !== undefined ? { commandArgs: frame.commandArgs } : {}),
        },
      );
      return;
    }
    if (frame.type === 'interaction_response') {
      let result = sessionManager.respondToInteraction(
        frame.sessionId, frame.requestId,
        { selection: frame.selection, text: frame.text, answers: frame.answers },
      );
      if (!result.accepted && result.reason === 'not_found') {
        result = await grokWatcher.answerIdleInteraction(
          frame.sessionId, frame.requestId,
          { selection: frame.selection, text: frame.text },
        );
      }
      send(ws, {
        type: 'interaction_result',
        sessionId: frame.sessionId,
        requestId: frame.requestId,
        accepted: result.accepted,
        reason: result.reason,
        message: result.message,
      });
      return;
    }
    if (frame.type === 'prompt') {
      sessionHub.subscribe(frame.conversationId, sendable);
      consumePendingHandoff(frame.conversationId);
      try {
        // session_started is broadcast synchronously inside handlePrompt
        // (right after the session is registered), so we don't need to send
        // it again here. The fan-out to non-subscribers happens via the
        // broadcast wrapper above.
        await sessionManager.handlePrompt(frame);
      } catch (err) {
        sendPreSessionFailure(ws, frame.conversationId, err);
      }
    }
    if (frame.type === 'command') {
      sessionHub.subscribe(frame.conversationId, sendable);
      consumePendingHandoff(frame.conversationId);
      try {
        await sessionManager.handleCommand(frame);
      } catch (err) {
        sendPreSessionFailure(ws, frame.conversationId, err);
      }
      return;
    }
  });

  ws.on('close', () => { clearInterval(heartbeat); sessionHub.drop(sendable); });
  ws.on('error', () => { clearInterval(heartbeat); sessionHub.drop(sendable); });
});

/** Prompt/command rejected before any session exists (e.g. remote host down).
 *  The client already flipped the conversation to `running` optimistically, so
 *  follow the error with `status: error` — otherwise RUNNING + Stop stick forever. */
function sendPreSessionFailure(ws: WebSocket, conversationId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const ts = Date.now();
  send(ws, {
    type: 'event', conversationId,
    event: { type: 'error', sessionId: 'unknown', seq: 0, ts, sender: 'system', payload: { message } },
  });
  // A live turn (e.g. bad options sent mid-turn) owns the status — don't flip it to error.
  if (sessionManager.hasLiveSession(conversationId)) return;
  send(ws, {
    type: 'event', conversationId,
    event: { type: 'status', sessionId: 'unknown', seq: 1, ts, sender: 'system', payload: { status: 'error' } },
  });
}

httpServer.listen(PORT, HOST, () => {
  console.log(`[Tierwyn] Server running at http://${HOST}:${PORT}`);
  console.log(`[Tierwyn] WebSocket ready at ws://${HOST}:${PORT}`);
  // Bind first: a second process against the same DB must not close live
  // sessions / spawn edges if listen fails (EADDRINUSE).
  closeStaleSessions(db);
  const orphaned = reconcileSpawnEdges(db, sessionManager);
  if (orphaned > 0) console.log(`[spawn] reconciled ${orphaned} orphaned spawn edge(s) from previous run`);
  const orphanShell = sessionManager.reconcileOrphanShellResults(db);
  if (orphanShell > 0) console.log(`[shell] reconciled ${orphanShell} orphaned shell result(s) from previous run`);
  grokSupervisor.start();
  // Drop PORT/HOST from the process env AFTER bind so every agent subprocess
  // (and its MCP children, e.g. react-grab-mcp) inherits a clean env and cannot
  // listen on our port. When they do, tierwyn-prod crash-loops with EADDRINUSE
  // and the web UI proxies /auth to the wrong process → "password not working".
  delete process.env.PORT;
  delete process.env.HOST;
});

function shutdown() {
  // Guard against double-shutdown (SIGINT during SIGTERM window) — otherwise
  // the forced-exit timer below fires twice and we never get to clean up.
  if ((shutdown as unknown as { _fired?: boolean })._fired) return;
  (shutdown as unknown as { _fired?: boolean })._fired = true;
  stopDiscovery();
  disposeCatalogueLogin();
  pluginHost.deactivateAll();
  jobScheduler.stop();
  grokWatcher.stop();
  grokSupervisor.stop();
  retentionCtl.stop();
  // Kill bridged MCP upstreams (stdio children, sse sockets) spawned for remote sessions.
  void closeAllHubPipes();
  // Settle live operator-shell children synchronously before the force-exit
  // timer / async adapter-stop path — process.exit drops the DB handle.
  sessionManager.settleShellChildrenForShutdown();
  // Hard exit after 2s no matter what — we'd rather drop in-flight cleanups
  // than hang the watcher. Armed first so a hung stop cannot exceed this budget.
  const force = setTimeout(() => process.exit(0), 2000);
  force.unref();

  // Stop all in-flight agent sessions so their child processes are killed
  // before we close the HTTP server. Without this, a running opencode/claude
  // child keeps the event loop alive past tsx's 5-second SIGTERM window and
  // tsx force-kills then immediately restarts into an EADDRINUSE loop.
  //
  // Await stop (with a short budget) BEFORE terminating WebSocket clients so
  // status:idle / session_ended can be broadcast while sockets are still open.
  // Fire-and-forget stop + immediate terminate left clients stuck "running"
  // after self-restarts (e.g. agent runs systemctl restart tierwyn-prod).
  const STOP_BUDGET_MS = 1200;
  const stops = sessionManager.activeSessions().map((session) =>
    sessionManager.stopSession(session.id, { initiatedBy: 'system' }),
  );
  void (async () => {
    await awaitStopsWithBudget(stops, STOP_BUDGET_MS);
    // Forcefully terminate all WebSocket connections. httpServer.close() only
    // fires its callback once every connection (including WS) drains — browsers
    // hold WS open indefinitely, so without this the callback never fires and
    // tsx watch force-kills us, then EADDRINUSE-loops on restart.
    for (const client of socketServer.clients) {
      try { client.terminate(); } catch { /* already gone */ }
    }
    httpServer.close(() => process.exit(0));
  })();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
