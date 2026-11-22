import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from './sessionManager.js';
import { catalogue } from './catalogue.js';
import { openDb, setDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedDefaultSettings, seedCatalogue, enableAllAgents } from './db/seed.js';
import { createProject } from './repositories/projects.js';
import { createConversation, getConversation } from './repositories/conversations.js';
import { createSession } from './repositories/sessions.js';
import { saveTemplate, updateCompactionSettings } from './repositories/settings.js';
import { MAX_SPAWN_DEPTH } from './spawn/config.js';
import {
  getLiveTokenForConversation, peekSpawnToken, issueSpawnToken, revokeSpawnTokensForSession,
  SPAWN_CAPABILITIES, SPAWN_TOKEN_TTL_MS, validateSpawnToken,
} from './spawn/tokens.js';

describe('SessionManager spawn token refresh', () => {
  let db: any;
  let convId: string;
  let profileId: string;
  let mgr: SessionManager;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    seedCatalogue(db);
    enableAllAgents(db);
    db.prepare('UPDATE agent_models SET max_concurrent_spawns = 1, max_grandchild_spawns = 1').run();
    setDb(db);
    catalogue.load(db);
    profileId = catalogue.listProfiles()[0]!.id;
    saveTemplate(db, { name: 'default-team', roles: [] });
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'root' });
    convId = conv.id;
    mgr = new SessionManager({
      db,
      broadcast: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reissueSpawnToken mints a fresh token and injects into active session', async () => {
    const steerCalls: any[] = [];
    const fakeSession = {
      sessionId: 'sess-active',
      conversationId: convId,
      abortController: new AbortController(),
      started: true,
      steerQueue: [],
    };
    (mgr as any).sessions.set('sess-active', fakeSession);
    (mgr as any).steerSession = vi.fn(async (sId, text, atts, meta) => {
      steerCalls.push({ sId, text, meta });
      return { mode: 'injected', queueLength: 0 };
    });

    const result = await mgr.reissueSpawnToken(convId);
    expect(result).not.toBeNull();
    expect(result!.token).toBeDefined();
    expect(result!.injected).toBe(true);
    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0].text).toContain(result!.token);
    expect(steerCalls[0].meta.source).toBe('user');

    const live = getLiveTokenForConversation(convId);
    expect(live?.token).toBe(result!.token);
  });

  it('pullNextSteer touches live token when user message arrives', async () => {
    createSession(db, { id: 'sess-holdopen', conversationId: convId });
    const fakeSession: any = {
      sessionId: 'sess-holdopen',
      conversationId: convId,
      profileId: undefined,
      abortController: new AbortController(),
      attachmentTempFiles: [],
      steerQueue: [
        {
          id: 'msg-1',
          type: 'queue',
          text: 'continue debugging',
          source: 'user',
          ts: Date.now(),
        },
      ],
    };
    (mgr as any).sessions.set('sess-holdopen', fakeSession);

    // Reissue so a live token exists
    const { token } = (await mgr.reissueSpawnToken(convId))!;
    const before = peekSpawnToken(token)!.expiresAt;

    // Pull next steer
    const pulled = await (mgr as any).pullNextSteer('sess-holdopen');
    expect(pulled).toBeDefined();
    expect(pulled.text).toContain('continue debugging');

    const after = peekSpawnToken(token)!.expiresAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('pullNextSteer mints a schedule-only stub when token was expired and profile is unresolvable', async () => {
    createSession(db, { id: 'sess-expired', conversationId: convId });
    const fakeSession: any = {
      sessionId: 'sess-expired',
      conversationId: convId,
      profileId: undefined,
      abortController: new AbortController(),
      attachmentTempFiles: [],
      steerQueue: [
        {
          id: 'msg-2',
          type: 'queue',
          text: 'try again',
          source: 'user',
          ts: Date.now(),
        },
      ],
    };
    (mgr as any).sessions.set('sess-expired', fakeSession);

    // Template is attached but profileId is missing, so tokenEntitlement
    // cannot inject the delegation preamble and falls through to schedule-only.
    db.prepare('UPDATE conversations SET template_name = ? WHERE id = ?').run('default-team', convId);

    expect(getLiveTokenForConversation(convId)).toBeUndefined();

    const pulled = await (mgr as any).pullNextSteer('sess-expired');
    expect(pulled).toBeDefined();
    expect(pulled.text.startsWith('## Scheduler')).toBe(true);
    expect(pulled.text).toContain('New Bearer — every earlier token is dead, use only this one');
    expect(pulled.text).toContain('Never reuse a Bearer or Authorization header copied from an earlier tool call');
    expect(pulled.text).toContain('try again');

    const live = getLiveTokenForConversation(convId);
    expect(live).toBeDefined();
    expect(live!.scope).toEqual(new Set(['schedule', 'plugin', 'tasks']));
    expect(live!.scope.has('spawn')).toBe(false);
    expect(pulled.text).toContain(live!.token);
  });

  it.each(['subagent_notify', 'parent_message', 'peer_message'] as const)(
    'wake reissue from %s mints spawn stub when no live token',
    async (source) => {
      db.prepare('UPDATE conversations SET template_name = ? WHERE id = ?').run('default-team', convId);
      createSession(db, { id: `sess-${source}`, conversationId: convId });
      const fakeSession: any = {
        id: `sess-${source}`,
        conversationId: convId,
        agentType: 'claude-code',
        profileId,
        abortController: new AbortController(),
        attachmentTempFiles: [],
        steerQueue: [
          { id: 'msg-wake', type: 'queue', text: 'child finished', source, ts: Date.now() },
        ],
      };
      (mgr as any).sessions.set(`sess-${source}`, fakeSession);
      expect(getLiveTokenForConversation(convId)).toBeUndefined();

      const pulled = await (mgr as any).pullNextSteer(`sess-${source}`);
      expect(pulled.text.startsWith('## Delegation + scheduler')).toBe(true);
      const live = getLiveTokenForConversation(convId);
      expect(live).toBeDefined();
      expect(pulled.text).toContain(live!.token);
      for (const cap of SPAWN_CAPABILITIES) {
        expect(peekSpawnToken(live!.token)!.scope.has(cap)).toBe(true);
      }
    },
  );

  it('live token on subagent_notify wake at minute 29 slides expiry and prepends no stub', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const token = issueSpawnToken(convId, 'sess-slide', 'spawn');
    createSession(db, { id: 'sess-slide', conversationId: convId });
    const fakeSession: any = {
      id: 'sess-slide',
      conversationId: convId,
      agentType: 'claude-code',
      profileId,
      abortController: new AbortController(),
      attachmentTempFiles: [],
      steerQueue: [
        { id: 'msg-n', type: 'queue', text: 'kid done', source: 'subagent_notify', ts: t0 },
      ],
    };
    (mgr as any).sessions.set('sess-slide', fakeSession);

    vi.setSystemTime(t0 + 29 * 60_000);
    const pulled = await (mgr as any).pullNextSteer('sess-slide');
    expect(pulled.text).toBe('kid done');
    const after = peekSpawnToken(token)!;
    expect(after.expiresAt).toBe(Date.now() + SPAWN_TOKEN_TTL_MS);
  });

  it('template-less wake mints exactly {schedule} (plus mesh when on) and a scheduler stub', async () => {
    createSession(db, { id: 'sess-sched', conversationId: convId });
    const fakeSession: any = {
      id: 'sess-sched',
      conversationId: convId,
      agentType: 'claude-code',
      profileId,
      abortController: new AbortController(),
      attachmentTempFiles: [],
      steerQueue: [
        { id: 'msg-s', type: 'queue', text: 'go', source: 'subagent_notify', ts: Date.now() },
      ],
    };
    (mgr as any).sessions.set('sess-sched', fakeSession);

    const pulled = await (mgr as any).pullNextSteer('sess-sched');
    expect(pulled.text.startsWith('## Scheduler')).toBe(true);
    const live = getLiveTokenForConversation(convId)!;
    expect(live.scope).toEqual(new Set(['schedule', 'plugin', 'tasks']));
    expect(live.scope.has('spawn')).toBe(false);

    revokeSpawnTokensForSession('sess-sched');
    updateCompactionSettings(db, { meshMessaging: 'tree' });
    createSession(db, { id: 'sess-sched-mesh', conversationId: convId });
    const fake2: any = {
      ...fakeSession,
      id: 'sess-sched-mesh',
      steerQueue: [
        { id: 'msg-m', type: 'queue', text: 'go', source: 'subagent_notify', ts: Date.now() },
      ],
    };
    (mgr as any).sessions.set('sess-sched-mesh', fake2);
    const pulledMesh = await (mgr as any).pullNextSteer('sess-sched-mesh');
    const meshTok = pulledMesh.text.match(/`([0-9a-f-]{36})`/)?.[1];
    expect(meshTok).toBeDefined();
    const meshScope = peekSpawnToken(meshTok)!.scope;
    expect(meshScope.has('schedule')).toBe(true);
    expect(meshScope.has('mesh')).toBe(true);
    expect(meshScope.has('spawn')).toBe(false);
  });

  it('wake at MAX_SPAWN_DEPTH mints a token without spawn capability', async () => {
    const projectId = getConversation(db, convId)!.projectId;
    let ancestorId = convId;
    for (let d = 0; d < MAX_SPAWN_DEPTH; d++) {
      ancestorId = createConversation(db, {
        projectId, title: `d${d + 1}`, parentConversationId: ancestorId, templateName: 'default-team',
      }).id;
    }
    createSession(db, { id: 'sess-deep', conversationId: ancestorId });
    const fakeSession: any = {
      id: 'sess-deep',
      conversationId: ancestorId,
      agentType: 'claude-code',
      profileId,
      abortController: new AbortController(),
      attachmentTempFiles: [],
      steerQueue: [
        { id: 'msg-d', type: 'queue', text: 'deep', source: 'subagent_notify', ts: Date.now() },
      ],
    };
    (mgr as any).sessions.set('sess-deep', fakeSession);

    const pulled = await (mgr as any).pullNextSteer('sess-deep');
    const live = getLiveTokenForConversation(ancestorId)!;
    expect(live.scope.has('spawn')).toBe(false);
    expect(pulled.text).toContain(live.token);
  });

  it('grok-bot wake mints no stub and no token', async () => {
    createSession(db, { id: 'sess-bot', conversationId: convId });
    const fakeSession: any = {
      id: 'sess-bot',
      conversationId: convId,
      agentType: 'grok-bot',
      profileId,
      abortController: new AbortController(),
      attachmentTempFiles: [],
      steerQueue: [
        { id: 'msg-b', type: 'queue', text: 'hello from bot', source: 'subagent_notify', ts: Date.now() },
      ],
    };
    (mgr as any).sessions.set('sess-bot', fakeSession);

    const pulled = await (mgr as any).pullNextSteer('sess-bot');
    expect(pulled.text).toBe('hello from bot');
    expect(getLiveTokenForConversation(convId)).toBeUndefined();
  });

  it('touchActivity slides the session token for 60 min; a silent token dies at 31 min', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const active = issueSpawnToken(convId, 'sess-x', 'spawn');
    const silent = issueSpawnToken(convId, 'sess-silent', 'spawn');
    const record: any = { steerQueue: [], lastActivityAt: t0 };

    for (let m = 10; m <= 60; m += 10) {
      vi.setSystemTime(t0 + m * 60_000);
      (mgr as any).touchActivity(record, 'sess-x');
    }
    expect(peekSpawnToken(active)).toBeDefined();
    expect(peekSpawnToken(silent)).toBeUndefined();
  });

  it('reissueSpawnToken on a template-less conv mints {schedule, plugin} with a scheduler stub', async () => {
    const steerCalls: any[] = [];
    (mgr as any).sessions.set('sess-re-sched', {
      id: 'sess-re-sched',
      conversationId: convId,
      abortController: new AbortController(),
      steerQueue: [],
    });
    (mgr as any).steerSession = vi.fn(async (_sId: string, text: string, _a: unknown, meta: unknown) => {
      steerCalls.push({ text, meta });
      return { mode: 'injected', queueLength: 0 };
    });

    const result = await mgr.reissueSpawnToken(convId);
    expect(result).not.toBeNull();
    expect(result!.injected).toBe(true);
    expect(steerCalls[0].text.startsWith('## Scheduler')).toBe(true);
    expect(peekSpawnToken(result!.token)!.scope).toEqual(new Set(['schedule', 'plugin', 'tasks']));
  });

  it('reissueSpawnToken on a templated spawn-capable profile mints spawn scope', async () => {
    db.prepare('UPDATE conversations SET template_name = ? WHERE id = ?').run('default-team', convId);
    (mgr as any).sessions.set('sess-re-spawn', {
      id: 'sess-re-spawn',
      conversationId: convId,
      agentType: 'claude-code',
      profileId,
      abortController: new AbortController(),
      steerQueue: [],
    });
    (mgr as any).steerSession = vi.fn(async () => ({ mode: 'injected', queueLength: 0 }));

    const result = await mgr.reissueSpawnToken(convId);
    expect(result).not.toBeNull();
    const scope = peekSpawnToken(result!.token)!.scope;
    for (const cap of SPAWN_CAPABILITIES) expect(scope.has(cap)).toBe(true);
  });

  it('reissueSpawnToken returns null for a bare-prompt (grok-bot) conversation', async () => {
    (mgr as any).sessions.set('sess-re-bot', {
      id: 'sess-re-bot',
      conversationId: convId,
      agentType: 'grok-bot',
      profileId,
      abortController: new AbortController(),
      steerQueue: [],
    });
    const steer = vi.fn();
    (mgr as any).steerSession = steer;

    expect(await mgr.reissueSpawnToken(convId)).toBeNull();
    expect(steer).not.toHaveBeenCalled();
    expect(getLiveTokenForConversation(convId)).toBeUndefined();
  });

  it('pullNextSteer abort splices the parked resolver and leaves the queue', async () => {
    createSession(db, { id: 'sess-abort', conversationId: convId });
    const fakeSession: any = {
      sessionId: 'sess-abort',
      conversationId: convId,
      profileId: undefined,
      abortController: new AbortController(),
      attachmentTempFiles: [],
      steerQueue: [],
    };
    (mgr as any).sessions.set('sess-abort', fakeSession);
    const ac = new AbortController();
    const parked = (mgr as any).pullNextSteer('sess-abort', ac.signal);
    ac.abort();
    await expect(parked).resolves.toBeNull();
    fakeSession.steerQueue.push({
      id: 'msg-kept',
      type: 'steer',
      text: 'kept',
      source: 'user',
      ts: Date.now(),
    });
    const pulled = await (mgr as any).pullNextSteer('sess-abort');
    expect(pulled.text).toContain('kept');
  });

  it('reissueSpawnToken twice with no live session revokes the first orphan', async () => {
    const first = await mgr.reissueSpawnToken(convId);
    expect(first).not.toBeNull();
    expect(first!.injected).toBe(false);
    const second = await mgr.reissueSpawnToken(convId);
    expect(second).not.toBeNull();
    expect(peekSpawnToken(first!.token)).toBeUndefined();
    expect(peekSpawnToken(second!.token)).toBeDefined();
    expect(validateSpawnToken(first!.token, convId)).toBe(false);
  });

  it('starting a session revokes the orphan token', async () => {
    const orphan = await mgr.reissueSpawnToken(convId);
    expect(orphan).not.toBeNull();
    (mgr as any).consumeOrphanToken(convId);
    expect(peekSpawnToken(orphan!.token)).toBeUndefined();
  });
});
