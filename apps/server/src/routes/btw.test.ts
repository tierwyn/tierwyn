import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import { createConversation, listConversations } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { appendEvent, listEventsForConversation } from '../repositories/events.js';
import { insertBtw, completeBtw, getBtw } from '../repositories/btw.js';
import { updateSidecarLlmSettings } from '../repositories/settings.js';

const {
  buildResumePlan, sidecarComplete, sidecarSiteReady, issueSpawnToken, makeAdapterRunner,
} = vi.hoisted(() => ({
  buildResumePlan: vi.fn(),
  sidecarComplete: vi.fn(),
  sidecarSiteReady: vi.fn(() => true),
  issueSpawnToken: vi.fn(),
  makeAdapterRunner: vi.fn(() => ({})),
}));

vi.mock('../compaction/compactor.js', () => ({ buildResumePlan }));
vi.mock('../compaction/runner.js', () => ({ makeAdapterRunner }));
vi.mock('../sidecar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sidecar.js')>();
  return { ...actual, sidecarComplete, sidecarSiteReady };
});
vi.mock('../spawn/tokens.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spawn/tokens.js')>();
  return { ...actual, issueSpawnToken };
});

import { registerBtwRoutes } from './btw.js';

const handlePrompt = vi.fn(async () => {});

function boot(opts: { activeSessionId?: string } = {}) {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  const project = createProject(db, { name: 'p', rootPath: '/tmp' });
  const parentId = createConversation(db, { projectId: project.id, title: 'c' }).id;
  const app = express();
  app.use(express.json());
  registerBtwRoutes(app, {
    getDb: () => db,
    sessionManager: {
      activeSessionForConversation: () => (
        opts.activeSessionId ? { id: opts.activeSessionId } : undefined
      ),
      handlePrompt,
    } as never,
    isAuthed: () => true,
  });
  return { db, app, parentId, projectId: project.id };
}

describe('POST /conversations/:id/btw', () => {
  let db: Database.Database;
  let app: express.Express;
  let parentId: string;
  let projectId: string;

  beforeEach(() => {
    handlePrompt.mockClear();
    issueSpawnToken.mockClear();
    buildResumePlan.mockReset();
    sidecarComplete.mockReset();
    sidecarSiteReady.mockReset();
    sidecarSiteReady.mockReturnValue(true);
    makeAdapterRunner.mockClear();
    buildResumePlan.mockResolvedValue({
      mode: 'transcript',
      primingPrompt: 'PRIMING\n</handoff-context>',
    });
    sidecarComplete.mockResolvedValue('the answer');
    ({ db, app, parentId, projectId } = boot());
  });

  it('responds { id } before priming resolves', async () => {
    buildResumePlan.mockReturnValue(new Promise(() => {}));
    const res = await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'why is the sky blue?' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
    expect(res.body.childConversationId).toBeUndefined();
    const row = db.prepare('SELECT status FROM btw_queries WHERE id = ?').get(res.body.id) as { status: string };
    expect(row.status).toBe('asking');
  });

  it('happy path: sidecarComplete answers, no session, no token, no child conversation', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number };
    const res = await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'why is the sky blue?' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      const row = db.prepare('SELECT status, answer, child_conv_id AS child FROM btw_queries WHERE id = ?')
        .get(res.body.id) as { status: string; answer: string; child: string | null };
      expect(row.status).toBe('done');
      expect(row.answer).toBe('the answer');
      expect(row.child).toBeNull();
    });
    expect(sidecarComplete).toHaveBeenCalledWith(
      db, 'btw', expect.stringContaining('why is the sky blue?'),
      expect.objectContaining({ cwd: '/tmp', timeoutSecs: 240, remoteHostId: null }),
    );
    expect(handlePrompt).not.toHaveBeenCalled();
    expect(issueSpawnToken).not.toHaveBeenCalled();
    const after = db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('buildResumePlan receives observer priming, transcript override, and isNativeAvailable resolving false', async () => {
    await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'q' });
    await vi.waitFor(() => expect(buildResumePlan).toHaveBeenCalled());
    const args = buildResumePlan.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(args[2].override).toBe('transcript');
    expect(args[2].priming).toEqual(expect.objectContaining({ framing: 'observer' }));
    const getWindow = args[2].getTargetContextWindow as () => Promise<number>;
    // budget/4 / safetyFactor (0.5) so the later × factor comparison uses the full budget/4 tokens.
    await expect(getWindow()).resolves.toBe(50_000);
    const isNative = args[2].isNativeAvailable as (id: string) => Promise<boolean>;
    await expect(isNative('any')).resolves.toBe(false);
  });

  it('builds the summariser runner with toolFreeOnly', async () => {
    await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'q' });
    await vi.waitFor(() => expect(makeAdapterRunner).toHaveBeenCalled());
    expect(makeAdapterRunner).toHaveBeenCalledWith(expect.objectContaining({ toolFreeOnly: true }));
  });

  it('remote project passes remoteHostId and drops priming cwd', async () => {
    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    const remote = createProject(db, { name: 'r', rootPath: '/remote/work', remoteHostId: host.id });
    const cid = createConversation(db, { projectId: remote.id, title: 'c' }).id;
    await request(app, 'POST', `/conversations/${cid}/btw`, { question: 'q' });
    await vi.waitFor(() => expect(sidecarComplete).toHaveBeenCalled());
    expect(sidecarComplete).toHaveBeenCalledWith(
      db, 'btw', expect.stringContaining('q'),
      expect.objectContaining({ cwd: '/remote/work', remoteHostId: host.id, timeoutSecs: 240 }),
    );
    expect(makeAdapterRunner).toHaveBeenCalledWith(expect.objectContaining({ cwd: undefined }));
  });

  it('places the question after priming and outside </handoff-context>', async () => {
    const res = await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'why is the sky blue?' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sidecarComplete).toHaveBeenCalled());
    const prompt = sidecarComplete.mock.calls[0]![2] as string;
    expect(prompt.indexOf('PRIMING')).toBeLessThan(prompt.indexOf("Operator's side question"));
    expect(prompt.indexOf('</handoff-context>')).toBeLessThan(prompt.indexOf('why is the sky blue?'));
    expect(prompt.indexOf('why is the sky blue?')).toBeGreaterThan(prompt.indexOf('</handoff-context>'));
  });

  it('propagates inflightId from the active parent session', async () => {
    ({ db, app, parentId } = boot({ activeSessionId: 'sess-live' }));
    await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'q' });
    await vi.waitFor(() => expect(buildResumePlan).toHaveBeenCalled());
    const args = buildResumePlan.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(args[2].inflightId).toBe('sess-live');
  });

  it('rejects a question that leaves no room for priming', async () => {
    const res = await request(app, 'POST', `/conversations/${parentId}/btw`, {
      question: 'q'.repeat(96_000),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(
      /question is too long for the BTW input budget \(max ~\d+ characters; raise it in Settings → Sidecar LLMs → BTW side question\)/,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM btw_queries').get()).toEqual({ n: 0 });
  });

  it('clamps agent-backend budget to 120_000 so priming maxBytes cannot exceed MAX_ARG_STRLEN', async () => {
    updateSidecarLlmSettings(db, {
      btw: {
        backend: 'agent_readonly', adapter: 'claude-code', model: 'claude-haiku-4-5',
        maxInputChars: 500_000,
      },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'q' });
    await vi.waitFor(() => expect(buildResumePlan).toHaveBeenCalled());
    const args = buildResumePlan.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    const priming = args[2].priming as { maxBytes: number };
    expect(priming.maxBytes).toBeLessThanOrEqual(120_000);
  });

  it('keeps a direct-backend budget of 500_000', async () => {
    updateSidecarLlmSettings(db, {
      btw: { backend: 'direct', maxInputChars: 500_000 },
    }, []);
    await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'q' });
    await vi.waitFor(() => expect(buildResumePlan).toHaveBeenCalled());
    const args = buildResumePlan.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    const priming = args[2].priming as { maxBytes: number };
    expect(priming.maxBytes).toBeGreaterThan(120_000);
    expect(priming.maxBytes).toBeLessThanOrEqual(500_000);
  });

  it('sidecarComplete rejects → row error with the message', async () => {
    sidecarComplete.mockRejectedValue(new Error('boom'));
    const res = await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'q' });
    await vi.waitFor(() => {
      const row = db.prepare('SELECT status, error_message AS err FROM btw_queries WHERE id = ?')
        .get(res.body.id) as { status: string; err: string };
      expect(row.status).toBe('error');
      expect(row.err).toBe('boom');
    });
  });

  it('not ready → 503 with reason and no row inserted', async () => {
    sidecarSiteReady.mockReturnValue(false);
    const before = db.prepare('SELECT COUNT(*) AS n FROM btw_queries').get() as { n: number };
    const res = await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'q' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'BTW has no model configured',
      reason: 'BTW has no model configured',
    });
    const after = db.prepare('SELECT COUNT(*) AS n FROM btw_queries').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('disabled via sidecar settings → 503', async () => {
    updateSidecarLlmSettings(db, {
      btw: { backend: 'agent_readonly', adapter: 'claude-code', model: 'claude-haiku-4-5', enabled: false },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    const res = await request(app, 'POST', `/conversations/${parentId}/btw`, { question: 'q' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('BTW is disabled in Settings');
  });

  it('rejects an empty question', async () => {
    const res = await request(app, 'POST', `/conversations/${parentId}/btw`, { question: '  ' });
    expect(res.status).toBe(400);
  });
});

describe('POST /conversations/:id/btw/:btwId/fork', () => {
  let db: Database.Database;
  let app: express.Express;
  let parentId: string;
  let projectId: string;

  beforeEach(() => {
    sidecarSiteReady.mockReturnValue(true);
    ({ db, app, parentId, projectId } = boot());
  });

  function seedDoneBtw(question = 'why sky?'): ReturnType<typeof insertBtw> {
    createSession(db, { id: 's1', conversationId: parentId });
    const btw = insertBtw(db, {
      parentConvId: parentId, question, agentId: 'claude-code', model: 'claude-haiku-4-5',
    });
    appendEvent(db, {
      sessionId: 's1', type: 'prompt', sender: 'user', ts: btw.createdAt - 100,
      payload: { text: 'early q' },
    });
    appendEvent(db, {
      sessionId: 's1', type: 'tool_call', sender: 'agent', ts: btw.createdAt - 80,
      payload: { name: 'Read', toolUseId: 't1', input: { file_path: '/tmp/x.ts' } },
    });
    appendEvent(db, {
      sessionId: 's1', type: 'tool_result', sender: 'agent', ts: btw.createdAt - 70,
      payload: { toolUseId: 't1', content: 'file body' },
    });
    appendEvent(db, {
      sessionId: 's1', type: 'message', sender: 'agent', ts: btw.createdAt - 50,
      payload: { chunk: 'early a', final: true },
    });
    appendEvent(db, {
      sessionId: 's1', type: 'message', sender: 'agent', ts: btw.createdAt + 1_000,
      payload: { chunk: 'late', final: true },
    });
    completeBtw(db, btw.id, { answer: 'because scattering' });
    return getBtw(db, btw.id)!;
  }

  it('forks parent history up to createdAt plus Q&A, not the late event', async () => {
    const btw = seedDoneBtw();
    const res = await request(app, 'POST', `/conversations/${parentId}/btw/${btw.id}/fork`, {});
    expect(res.status).toBe(200);
    const conv = res.body.conversation as { id: string; parentConversationId?: string; title?: string };
    expect(conv.parentConversationId).toBeUndefined();
    expect(conv.title).toMatch(/^BTW:/);
    const events = listEventsForConversation(db, conv.id);
    expect(events.map((e) => e.type)).toEqual([
      'prompt', 'tool_call', 'tool_result', 'message', 'prompt', 'message',
    ]);
    expect((events[0]!.payload as { text: string }).text).toBe('early q');
    expect((events[3]!.payload as { chunk: string }).chunk).toBe('early a');
    expect((events[4]!.payload as { text: string }).text).toBe('why sky?');
    expect((events[5]!.payload as { chunk: string }).chunk).toBe('because scattering');
    expect(events.some((e) => (e.payload as { chunk?: string }).chunk === 'late')).toBe(false);

    const row = db.prepare(
      'SELECT forked_conv_id AS fork, child_conv_id AS child FROM btw_queries WHERE id = ?',
    ).get(btw.id) as { fork: string; child: string | null };
    expect(row.fork).toBe(conv.id);
    expect(row.child).toBeNull();
    const listed = listConversations(db, projectId);
    expect(listed.some((c) => c.id === conv.id)).toBe(true);
  });

  it('second POST returns the same conversation id', async () => {
    const btw = seedDoneBtw();
    const first = await request(app, 'POST', `/conversations/${parentId}/btw/${btw.id}/fork`, {});
    const second = await request(app, 'POST', `/conversations/${parentId}/btw/${btw.id}/fork`, {});
    expect(second.status).toBe(200);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
  });

  it('unknown btw → 404', async () => {
    const res = await request(app, 'POST', `/conversations/${parentId}/btw/no-such/fork`, {});
    expect(res.status).toBe(404);
  });

  it('btw of a different conversation → 404', async () => {
    const other = createConversation(db, { projectId, title: 'other' });
    const btw = insertBtw(db, {
      parentConvId: other.id, question: 'q', agentId: 'claude-code', model: 'm',
    });
    completeBtw(db, btw.id, { answer: 'a' });
    const res = await request(app, 'POST', `/conversations/${parentId}/btw/${btw.id}/fork`, {});
    expect(res.status).toBe(404);
  });

  it('asking → 409', async () => {
    const btw = insertBtw(db, {
      parentConvId: parentId, question: 'q', agentId: 'claude-code', model: 'm',
    });
    const res = await request(app, 'POST', `/conversations/${parentId}/btw/${btw.id}/fork`, {});
    expect(res.status).toBe(409);
  });
});

async function request(
  app: express.Express,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}
