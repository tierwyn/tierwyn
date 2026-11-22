import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import type { DraftUpdatedFrame, ServerFrame } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { DEFAULT_ENHANCE_PROJECT_PROMPT, ENHANCE_INSTRUCTION_MAX, resolveEnhancePrompt } from '@tierwyn/shared';
import { updateEnhanceSettings, getEnhanceSettings, updateSidecarLlmSettings } from '../repositories/settings.js';
import { sidecarDeps, sidecarComplete } from '../sidecar.js';
import { appendEvent } from '../repositories/events.js';
import { createConversation } from '../repositories/conversations.js';
import { createProject } from '../repositories/projects.js';
import { createPendingHost } from '../repositories/remoteHosts.js';
import {
  beginProcessing,
  getDraft,
  getProcessing,
  upsertDraft,
  PROCESSING_STALE_MS,
} from '../repositories/drafts.js';
import { registerEnhanceRoutes, continueEnhanceUnderLock, enhanceConfigPayload } from './enhance.js';

vi.mock('../adapters/whisper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/whisper.js')>();
  return {
    ...actual,
    clean: vi.fn(async (_cfg: unknown, text: string) => `ENHANCED:${text}`),
  };
});

vi.mock('../sidecar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sidecar.js')>();
  return {
    ...actual,
    sidecarComplete: vi.fn((...args: Parameters<typeof actual.sidecarComplete>) =>
      actual.sidecarComplete(...args)),
  };
});

import { clean } from '../adapters/whisper.js';

async function waitUntil(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('POST /enhance', () => {
  let db: Database.Database;
  let app: express.Express;
  let frames: ServerFrame[];
  let convId: string;
  const origCreate = sidecarDeps.createAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    convId = createConversation(db, { projectId: project.id, title: 'c' }).id;
    frames = [];
    app = express();
    app.use(express.json());
    registerEnhanceRoutes(app, () => db, (_id, frame) => { frames.push(frame); });
    app.get('/settings/enhance', (_req, res) => { res.json(enhanceConfigPayload(db)); });
    vi.mocked(clean).mockClear();
    vi.mocked(clean).mockImplementation(async (_cfg, text) => `ENHANCED:${text}`);
    vi.mocked(sidecarComplete).mockClear();
  });

  afterEach(() => {
    sidecarDeps.createAdapter = origCreate;
    db.close();
  });

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    } finally {
      server.close();
    }
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    return request('POST', path, body);
  }

  function configure(): void {
    updateEnhanceSettings(db, {
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
  }

  function agentRoute(backend: 'agent_oneshot' | 'agent_readonly', modes: string[] = ['none', 'read_only']) {
    updateSidecarLlmSettings(db, {
      enhance: { backend, adapter: 'claude-code', model: 'm' },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    const oneShot = vi.fn(async (_p: string, _o: Record<string, unknown>) => ({ text: 'REWRITTEN' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot, oneShotModes: modes })) as never;
    return oneShot;
  }

  function relativeConversation(): string {
    const rel = createProject(db, { name: 'rel', rootPath: 'relative/dir' });
    return createConversation(db, { projectId: rel.id, title: 'r' }).id;
  }

  it('rejects empty text with 400', async () => {
    expect((await post('/enhance', {})).status).toBe(400);
    expect((await post('/enhance', { text: '  ' })).status).toBe(400);
  });

  it('rejects missing conversationId with 400', async () => {
    configure();
    const { status, body } = await post('/enhance', { text: 'fix the bug' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'conversationId required' });
    expect(clean).not.toHaveBeenCalled();
  });

  it('rejects when enhance LLM is not configured and leaves no lock', async () => {
    const { status, body } = await post('/enhance', { text: 'fix the bug', conversationId: convId });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: expect.stringMatching(/not configured/i) });
    expect(clean).not.toHaveBeenCalled();
    expect(getProcessing(db, convId)).toBe('idle');
  });

  it('happy path returns 202, freeze frame, then settles with enhanced text', async () => {
    configure();
    upsertDraft(db, convId, 'fix it please');
    const { status, body } = await post('/enhance', {
      text: 'fix it please',
      mode: 'quick',
      conversationId: convId,
    });
    expect(status).toBe(202);
    expect(body).toMatchObject({ processing: 'enhancing' });
    expect((body as { jobId: string }).jobId).toEqual(expect.any(String));
    expect(frames[0]).toMatchObject({
      type: 'draft_updated',
      conversationId: convId,
      processing: 'enhancing',
      canUndo: false,
    });

    await waitUntil(() => frames.some((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle'));
    expect(getDraft(db, convId)?.text).toBe('ENHANCED:fix it please');
    const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle') as DraftUpdatedFrame;
    expect(settle).toMatchObject({
      text: 'ENHANCED:fix it please',
      processing: 'idle',
      processingStartedAt: null,
      canUndo: true,
    });
    expect(clean).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clean).mock.calls[0]![1]).toBe('fix it please');
  });

  it('disconnect during enhance still writes the draft and broadcasts settle', async () => {
    configure();
    upsertDraft(db, convId, 'fix teh speling');
    let resolveClean!: (v: string) => void;
    vi.mocked(clean).mockImplementationOnce(() => new Promise((r) => { resolveClean = (s) => r(s); }));

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/enhance',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }, (res) => {
          const code = res.statusCode ?? 0;
          res.resume();
          req.destroy();
          resolve(code);
        });
        req.on('error', (err) => {
          // destroy after headers can surface as an error; 202 already counted
          if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(202);
          else reject(err);
        });
        req.write(JSON.stringify({
          conversationId: convId,
          text: 'fix teh speling',
          mode: 'quick',
        }));
        req.end();
      });
      expect(status).toBe(202);
      expect(frames[0]).toMatchObject({ processing: 'enhancing' });

      resolveClean('ENHANCED:fix the spelling');
      await waitUntil(() => getDraft(db, convId)?.text === 'ENHANCED:fix the spelling');
      const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle') as DraftUpdatedFrame | undefined;
      expect(settle).toMatchObject({
        text: 'ENHANCED:fix the spelling',
        processing: 'idle',
        canUndo: true,
      });
    } finally {
      server.close();
    }
  });

  it('clean() reject releases the lock, leaves text, and settle carries error', async () => {
    configure();
    upsertDraft(db, convId, 'hello');
    vi.mocked(clean).mockRejectedValueOnce(new Error('cleanup HTTP 500'));
    const { status } = await post('/enhance', { text: 'hello', conversationId: convId });
    expect(status).toBe(202);
    await waitUntil(() => getProcessing(db, convId) === 'idle' && frames.some((f) => (f as DraftUpdatedFrame).error));
    expect(getDraft(db, convId)?.text).toBe('hello');
    const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).error) as DraftUpdatedFrame;
    expect(settle.processing).toBe('idle');
    expect(settle.error).toMatch(/HTTP 500|cleanup/i);
    expect(settle.canUndo).toBe(false);
    expect(getDraft(db, convId)?.preText).toBeNull();
  });

  it('second POST while the first holds the lock returns 409', async () => {
    configure();
    upsertDraft(db, convId, 'hello');
    let resolveClean!: (v: string) => void;
    vi.mocked(clean).mockImplementationOnce(() => new Promise((r) => { resolveClean = (s) => r(s); }));

    const first = await post('/enhance', { text: 'hello', conversationId: convId });
    expect(first.status).toBe(202);

    const second = await post('/enhance', { text: 'hello again', conversationId: convId });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'draft busy', processing: 'enhancing' });

    resolveClean('ENHANCED:hello');
    await waitUntil(() => getProcessing(db, convId) === 'idle');
  });

  it('clean() after a stale steal does not broadcast or overwrite text', async () => {
    configure();
    upsertDraft(db, convId, 'original');
    let resolveClean!: (v: string) => void;
    vi.mocked(clean).mockImplementationOnce(() => new Promise((r) => { resolveClean = (s) => r(s); }));

    const { status } = await post('/enhance', { text: 'original', conversationId: convId });
    expect(status).toBe(202);
    const freezeCount = frames.length;

    db.prepare('UPDATE draft_prompts SET processing_started_at = ? WHERE conversation_id = ?')
      .run(Date.now() - PROCESSING_STALE_MS - 1, convId);
    expect(beginProcessing(db, convId, 'enhancing', 'thief-job', { stashPreText: true })).toBe(true);
    const textBefore = getDraft(db, convId)!.text;

    resolveClean('ENHANCED:should-not-land');
    await new Promise((r) => setTimeout(r, 80));
    expect(getDraft(db, convId)!.text).toBe(textBefore);
    expect(frames.length).toBe(freezeCount);
    expect(getDraft(db, convId)!.processingId).toBe('thief-job');
  });

  it('context mode includes prose lines but not tool_result content', async () => {
    configure();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('enh-sess', convId, null, null, Date.now(), Date.now());
    appendEvent(db, {
      sessionId: 'enh-sess',
      type: 'prompt',
      payload: { text: 'look at the login bug' },
      sender: 'user',
      ts: 1,
    });
    appendEvent(db, {
      sessionId: 'enh-sess',
      type: 'message',
      payload: { chunk: 'I see the issue', final: true },
      sender: 'agent',
      ts: 2,
    });
    appendEvent(db, {
      sessionId: 'enh-sess',
      type: 'tool_result',
      payload: { toolUseId: 't1', content: 'SECRET_TOOL_BODY', isError: false },
      sender: 'agent',
      ts: 3,
    });

    const { status } = await post('/enhance', {
      text: 'fix it',
      mode: 'context',
      conversationId: convId,
    });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(clean).mock.calls.length >= 1);
    const userMsg = vi.mocked(clean).mock.calls[0]![1] as string;
    expect(userMsg).toContain('look at the login bug');
    expect(userMsg).toContain('I see the issue');
    expect(userMsg).toContain('Draft prompt to rewrite');
    expect(userMsg).toContain('fix it');
    expect(userMsg).not.toContain('SECRET_TOOL_BODY');
  });

  it('context mode with empty prose falls back to quick system prompt', async () => {
    configure();
    const { status } = await post('/enhance', {
      text: 'hello',
      mode: 'context',
      conversationId: convId,
    });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(clean).mock.calls.length >= 1);
    const transport = vi.mocked(clean).mock.calls[0]![0] as { systemPrompt: string };
    const cfg = getEnhanceSettings(db);
    expect(transport.systemPrompt).toBe(resolveEnhancePrompt(cfg, 'quick'));
  });

  it('instruction is appended to the user message', async () => {
    configure();
    const { status } = await post('/enhance', {
      text: 'fix it please',
      mode: 'quick',
      conversationId: convId,
      instruction: 'be terse',
    });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(clean).mock.calls.length >= 1);
    const userMsg = vi.mocked(clean).mock.calls[0]![1] as string;
    expect(userMsg).toContain('fix it please');
    expect(userMsg).toContain('be terse');
    expect(userMsg.indexOf('be terse')).toBeGreaterThan(userMsg.indexOf('fix it please'));
    expect(userMsg).toContain('Additional instructions for the rewrite');
  });

  it('instruction over the cap is rejected with 400 and takes no lock', async () => {
    configure();
    const { status, body } = await post('/enhance', {
      text: 'fix it please',
      mode: 'quick',
      conversationId: convId,
      instruction: 'x'.repeat(ENHANCE_INSTRUCTION_MAX + 1),
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: expect.stringMatching(/instruction must be/i) });
    expect(clean).not.toHaveBeenCalled();
    expect(getProcessing(db, convId)).toBe('idle');
  });

  it('context mode carries both transcript and instruction', async () => {
    configure();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('enh-sess-instr', convId, null, null, Date.now(), Date.now());
    appendEvent(db, {
      sessionId: 'enh-sess-instr',
      type: 'prompt',
      payload: { text: 'look at the login bug' },
      sender: 'user',
      ts: 1,
    });
    appendEvent(db, {
      sessionId: 'enh-sess-instr',
      type: 'message',
      payload: { chunk: 'I see the issue', final: true },
      sender: 'agent',
      ts: 2,
    });

    const { status } = await post('/enhance', {
      text: 'fix it',
      mode: 'context',
      conversationId: convId,
      instruction: 'focus on the auth middleware',
    });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(clean).mock.calls.length >= 1);
    const userMsg = vi.mocked(clean).mock.calls[0]![1] as string;
    expect(userMsg).toContain('look at the login bug');
    expect(userMsg).toContain('I see the issue');
    expect(userMsg).toContain('fix it');
    expect(userMsg).toContain('focus on the auth middleware');
    expect(userMsg).toContain('Additional instructions for the rewrite');
  });

  it('no instruction leaves the message byte-identical to today', async () => {
    configure();
    const { status } = await post('/enhance', {
      text: 'fix it please',
      mode: 'quick',
      conversationId: convId,
    });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(clean).mock.calls.length >= 1 && getProcessing(db, convId) === 'idle');
    expect(vi.mocked(clean).mock.calls[0]![1]).toBe('fix it please');

    vi.mocked(clean).mockClear();
    const empty = await post('/enhance', {
      text: 'fix it please',
      mode: 'quick',
      conversationId: convId,
      instruction: '   ',
    });
    expect(empty.status).toBe(202);
    await waitUntil(() => vi.mocked(clean).mock.calls.length >= 1);
    expect(vi.mocked(clean).mock.calls[0]![1]).toBe('fix it please');
  });

  it('GET /settings/enhance reports configured:true with an agent-only enhance row', async () => {
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    sidecarDeps.createAdapter = (() => ({ oneShot: async () => ({ text: 'x' }) })) as never;
    const { status, body } = await request('GET', '/settings/enhance');
    expect(status).toBe(200);
    expect(body).toMatchObject({ configured: true });
  });

  it('POST /enhance without body promptId uses sidecarLlm.enhance.selectedPromptId', async () => {
    configure();
    updateSidecarLlmSettings(db, {
      enhance: {
        backend: 'direct',
        prompts: [{ id: 'custom-q', name: 'Q', text: 'CUSTOM-QUICK' }],
        selectedPromptId: 'custom-q',
      },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const { status } = await post('/enhance', {
      text: 'hello',
      mode: 'quick',
      conversationId: convId,
    });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(sidecarComplete).mock.calls.length >= 1);
    expect(vi.mocked(sidecarComplete).mock.calls[0]![3]).toMatchObject({ promptId: undefined });
    await waitUntil(() => vi.mocked(clean).mock.calls.length >= 1);
    expect((vi.mocked(clean).mock.calls[0]![0] as { systemPrompt: string }).systemPrompt).toBe('CUSTOM-QUICK');
  });

  it('POST /enhance/test uses the sidecar resolver, not the legacy enhance blob', async () => {
    configure();
    updateSidecarLlmSettings(db, {
      enhance: {
        backend: 'direct',
        prompts: [{ id: 'custom-q', name: 'Q', text: 'CUSTOM-QUICK' }],
        selectedPromptId: 'custom-q',
      },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const { status } = await post('/enhance/test', {});
    expect(status).toBe(200);
    expect(clean).toHaveBeenCalledTimes(1);
    expect((vi.mocked(clean).mock.calls[0]![0] as { systemPrompt: string }).systemPrompt).toBe('CUSTOM-QUICK');
  });

  it('POST /enhance/test on agent backend does not fall back to gemini', async () => {
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    sidecarDeps.createAdapter = () => ({
      oneShot: async () => { throw new Error('agent boom'); },
    }) as never;
    const { status, body } = await post('/enhance/test', {
      enhance: { model: 'unsaved-model', baseUrl: 'http://probe.example/v1' },
    });
    expect(status).toBe(502);
    expect(body).toMatchObject({ ok: false, error: expect.stringMatching(/agent boom/) });
    expect(clean).not.toHaveBeenCalled();
  });

  it('POST /enhance/probe round-trips the enhancer blob via clean, not the site route', async () => {
    configure();
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    sidecarDeps.createAdapter = () => {
      throw new Error('probe must not create an adapter');
    };
    upsertDraft(db, convId, 'leave me alone');
    const { status, body } = await post('/enhance/probe', {
      enhance: { model: 'probe-model', baseUrl: 'http://probe.example/v1', timeoutSecs: 12 },
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, reply: expect.stringMatching(/^OK \(\d+ ms\): /) });
    expect(clean).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clean).mock.calls[0]![1]).toBe('hello this is a test of the connection');
    const cfg = vi.mocked(clean).mock.calls[0]![0] as {
      model: string; baseUrl: string; timeoutSecs: number; systemPrompt: string;
    };
    expect(cfg.model).toBe('probe-model');
    expect(cfg.baseUrl).toBe('http://probe.example/v1');
    expect(cfg.timeoutSecs).toBe(12);
    expect(cfg.systemPrompt).toBe(resolveEnhancePrompt(getEnhanceSettings(db), 'quick'));
    expect(getProcessing(db, convId)).toBe('idle');
    expect(getDraft(db, convId)?.text).toBe('leave me alone');
    expect(frames).toHaveLength(0);
  });

  it('POST /enhance/probe returns 400 when the enhancer transport is not configured', async () => {
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const { status, body } = await post('/enhance/probe', {});
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: expect.stringMatching(/not configured/i) });
    expect(clean).not.toHaveBeenCalled();
    expect(getProcessing(db, convId)).toBe('idle');
    expect(frames).toHaveLength(0);
  });

  it('POST /enhance/probe maps a clean() timeout/failure to 502', async () => {
    configure();
    vi.mocked(clean).mockRejectedValueOnce(
      new Error('cleanup timed out after 60s (endpoint slow or unreachable — check lmstudio baseUrl/model)'),
    );
    const { status, body } = await post('/enhance/probe', {});
    expect(status).toBe(502);
    expect(body).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/i) });
    expect(clean).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
    expect(getProcessing(db, convId)).toBe('idle');
  });

  it('POST /enhance passes project.rootPath as cwd', async () => {
    configure();
    upsertDraft(db, convId, 'fix it please');
    const { status } = await post('/enhance', {
      text: 'fix it please',
      mode: 'quick',
      conversationId: convId,
    });
    expect(status).toBe(202);
    await waitUntil(() => frames.some((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle'));
    expect(vi.mocked(sidecarComplete).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(sidecarComplete).mock.calls.at(-1)![3]).toMatchObject({ cwd: '/tmp' });
  });

  it('continueEnhanceUnderLock passes the same cwd as POST /enhance', async () => {
    configure();
    upsertDraft(db, convId, 'raw');
    const jobId = 'job-continue';
    expect(beginProcessing(db, convId, 'enhancing', jobId, { stashPreText: true })).toBe(true);
    await continueEnhanceUnderLock(
      () => db,
      (_id, frame) => { frames.push(frame); },
      convId,
      jobId,
      'raw',
      'quick',
      undefined,
    );
    expect(vi.mocked(sidecarComplete).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(sidecarComplete).mock.calls.at(-1)![3]).toMatchObject({ cwd: '/tmp' });
  });

  function seedProseHistory(sessionId: string, count: number): void {
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(sessionId, convId, null, null, Date.now(), Date.now());
    for (let i = 0; i < count; i++) {
      appendEvent(db, {
        sessionId,
        type: 'prompt',
        payload: { text: `MARKER-${i} ${'word '.repeat(40)}` },
        sender: 'user',
        ts: i + 1,
      });
    }
  }

  it('caps context transcript at floor(maxInputChars/4) tokens', async () => {
    configure();
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', maxInputChars: 500 },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    seedProseHistory('enh-sess-cap', 15);
    const { status } = await post('/enhance', {
      text: 'fix it',
      mode: 'context',
      conversationId: convId,
    });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(sidecarComplete).mock.calls.length >= 1);
    const userMsg = vi.mocked(sidecarComplete).mock.calls[0]![2] as string;
    expect(userMsg).toContain('Draft prompt to rewrite');
    expect(userMsg).toContain('MARKER-14');
    expect(userMsg).not.toContain('MARKER-0');
    expect(userMsg).toContain('[earlier history truncated]');
  });

  it('defaults to 2000 tokens when maxInputChars is unset (no behaviour change)', async () => {
    configure();
    seedProseHistory('enh-sess-default', 15);
    const { status } = await post('/enhance', {
      text: 'fix it',
      mode: 'context',
      conversationId: convId,
    });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(sidecarComplete).mock.calls.length >= 1);
    const userMsg = vi.mocked(sidecarComplete).mock.calls[0]![2] as string;
    expect(userMsg).toContain('Draft prompt to rewrite');
    expect(userMsg).toContain('MARKER-0');
    expect(userMsg).toContain('MARKER-14');
    expect(userMsg).not.toContain('[earlier history truncated]');
  });

  it('passes subMode=context only when prose context actually attached', async () => {
    configure();
    const empty = await post('/enhance', {
      text: 'hello',
      mode: 'context',
      conversationId: convId,
    });
    expect(empty.status).toBe(202);
    await waitUntil(() => vi.mocked(sidecarComplete).mock.calls.length >= 1);
    expect(vi.mocked(sidecarComplete).mock.calls[0]![3]).toMatchObject({ subMode: 'quick' });

    vi.mocked(sidecarComplete).mockClear();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('enh-sess-sub', convId, null, null, Date.now(), Date.now());
    appendEvent(db, {
      sessionId: 'enh-sess-sub',
      type: 'prompt',
      payload: { text: 'look at the login bug' },
      sender: 'user',
      ts: 1,
    });
    const withCtx = await post('/enhance', {
      text: 'fix it',
      mode: 'context',
      conversationId: convId,
    });
    expect(withCtx.status).toBe(202);
    await waitUntil(() => vi.mocked(sidecarComplete).mock.calls.length >= 1);
    expect(vi.mocked(sidecarComplete).mock.calls[0]![3]).toMatchObject({ subMode: 'context' });
  });

  it('passes the per-request promptId through to the dispatcher', async () => {
    configure();
    const { status } = await post('/enhance', {
      text: 'fix it please',
      mode: 'quick',
      conversationId: convId,
      promptId: 'enhance-quick-1',
    });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(sidecarComplete).mock.calls.length >= 1);
    expect(vi.mocked(sidecarComplete).mock.calls[0]![3]).toMatchObject({
      promptId: 'enhance-quick-1',
      subMode: 'quick',
    });
    expect(vi.mocked(sidecarComplete).mock.calls[0]![3]).not.toHaveProperty('systemPrompt');
  });

  it('omits cwd and does not throw when the conversation row is gone', async () => {
    configure();
    upsertDraft(db, convId, 'raw');
    const jobId = 'job-missing-conv';
    expect(beginProcessing(db, convId, 'enhancing', jobId, { stashPreText: true })).toBe(true);
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
    await continueEnhanceUnderLock(
      () => db,
      (_id, frame) => { frames.push(frame); },
      convId,
      jobId,
      'raw',
      'quick',
      undefined,
    );
    expect(vi.mocked(sidecarComplete).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(sidecarComplete).mock.calls.at(-1)![3]).not.toHaveProperty('cwd');
  });

  it('remote-host project mode keeps read_only, remote cwd, and remoteHostId', async () => {
    agentRoute('agent_oneshot');
    const host = createPendingHost(db, 'box', 'h', Date.now() + 60_000);
    const remote = createProject(db, { name: 'rh', rootPath: '/tmp', remoteHostId: host.id });
    const cid = createConversation(db, { projectId: remote.id, title: 'r' }).id;
    const { status } = await post('/enhance', { text: 'fix sidebar', mode: 'project', conversationId: cid });
    expect(status).toBe(202);
    await waitUntil(() => vi.mocked(sidecarComplete).mock.calls.length >= 1);
    expect(vi.mocked(sidecarComplete).mock.calls[0]![3]).toMatchObject({
      oneShotMode: 'read_only',
      cwd: '/tmp',
      remoteHostId: host.id,
    });
  });

  it('project mode runs a read-only one-shot with the project prompt and absolute cwd (no prose)', async () => {
    const oneShot = agentRoute('agent_oneshot');
    const { status } = await post('/enhance', { text: 'fix sidebar dot tsx', mode: 'project', conversationId: convId });
    expect(status).toBe(202);
    await waitUntil(() => oneShot.mock.calls.length >= 1);
    expect(oneShot.mock.calls[0]![0]).toBe('fix sidebar dot tsx');
    expect(oneShot.mock.calls[0]![1]).toMatchObject({
      mode: 'read_only', cwd: '/tmp', model: 'm', systemPrompt: DEFAULT_ENHANCE_PROJECT_PROMPT,
    });
    await waitUntil(() => getDraft(db, convId)?.text === 'REWRITTEN');
  });

  it('project mode attaches the prose transcript when present', async () => {
    const oneShot = agentRoute('agent_oneshot');
    seedProseHistory('proj-ctx', 1);
    await post('/enhance', { text: 'fix it', mode: 'project', conversationId: convId });
    await waitUntil(() => oneShot.mock.calls.length >= 1);
    const msg = oneShot.mock.calls[0]![0];
    expect(msg).toContain('MARKER-0');
    expect(msg).toContain('Draft prompt to rewrite:\nfix it');
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ systemPrompt: DEFAULT_ENHANCE_PROJECT_PROMPT });
  });

  it('project mode on a direct route uses projectAdapter/projectModel, not clean', async () => {
    configure();
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', projectAdapter: 'claude-code', projectModel: 'pm' },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    const oneShot = vi.fn(async () => ({ text: 'REWRITTEN' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot, oneShotModes: ['none', 'read_only'] })) as never;
    expect((await post('/enhance', { text: 'x', mode: 'project', conversationId: convId })).status).toBe(202);
    await waitUntil(() => oneShot.mock.calls.length >= 1);
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ mode: 'read_only', model: 'pm' });
    expect(clean).not.toHaveBeenCalled();
  });

  it.each(['quick', 'context'] as const)('%s on an agent_readonly route runs tools-off', async (mode) => {
    const oneShot = agentRoute('agent_readonly');
    seedProseHistory(`ro-${mode}`, 1);
    expect((await post('/enhance', { text: 'fix it', mode, conversationId: convId })).status).toBe(202);
    await waitUntil(() => oneShot.mock.calls.length >= 1);
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ mode: 'none' });
  });

  it('project mode with a relative cwd fails before oneShot (typed draft unchanged)', async () => {
    const oneShot = agentRoute('agent_oneshot');
    const cid = relativeConversation();
    upsertDraft(db, cid, 'keep me');
    expect((await post('/enhance', { text: 'keep me', mode: 'project', conversationId: cid })).status).toBe(202);
    await waitUntil(() => frames.some((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle'));
    const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle') as DraftUpdatedFrame;
    expect(settle.error).toBe('Enhance with the project: this conversation has no absolute working directory');
    expect(settle.canUndo).toBe(false);
    expect(oneShot).not.toHaveBeenCalled();
    expect(getDraft(db, cid)?.text).toBe('keep me');
  });

  it('dictation project with a relative cwd lands the raw transcript', async () => {
    const oneShot = agentRoute('agent_oneshot');
    const cid = relativeConversation();
    upsertDraft(db, cid, 'x');
    const jobId = 'job-rel';
    expect(beginProcessing(db, cid, 'transcribing', jobId)).toBe(true);
    const ok = await continueEnhanceUnderLock(
      () => db, (_id, f) => { frames.push(f); }, cid, jobId, 'raw words here', 'project', undefined, { dictation: true },
    );
    expect(ok).toBe(true);
    expect(oneShot).not.toHaveBeenCalled();
    expect(getDraft(db, cid)?.text).toBe('raw words here');
    expect(getProcessing(db, cid)).toBe('idle');
  });

  it('project mode without project config returns 400 and takes no lock', async () => {
    configure();
    const { status, body } = await post('/enhance', { text: 'x', mode: 'project', conversationId: convId });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'enhance project reads not configured' });
    expect(getProcessing(db, convId)).toBe('idle');
  });

  it('adapter without read_only: projectConfigured false and project POST fails closed', async () => {
    agentRoute('agent_oneshot', ['none']);
    const { body } = await request('GET', '/settings/enhance');
    expect(body).toMatchObject({
      configured: true,
      projectConfigured: false,
      projectUnavailableReason: 'This adapter cannot do a read-only one-shot',
    });
    expect((await post('/enhance', { text: 'x', mode: 'project', conversationId: convId })).status).toBe(400);
  });

  it('config payload reports projectConfigured true for a read-only-capable agent row', async () => {
    agentRoute('agent_oneshot');
    const { body } = await request('GET', '/settings/enhance');
    expect(body).toMatchObject({ configured: true, projectConfigured: true });
    expect(body).not.toHaveProperty('projectUnavailableReason');
  });

  it('unknown mode stays quick', async () => {
    configure();
    await post('/enhance', { text: 'x', mode: 'bogus', conversationId: convId });
    await waitUntil(() => vi.mocked(sidecarComplete).mock.calls.length >= 1);
    expect(vi.mocked(sidecarComplete).mock.calls[0]![3]).toMatchObject({ subMode: 'quick', oneShotMode: 'none' });
  });
});
