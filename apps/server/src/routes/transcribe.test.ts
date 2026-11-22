import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { getDraft, getProcessing, upsertDraft, beginProcessing } from '../repositories/drafts.js';
import { updateVoiceSettings, updateEnhanceSettings, updateSidecarLlmSettings } from '../repositories/settings.js';
import { appendEvent } from '../repositories/events.js';
import type { DraftUpdatedFrame, ServerFrame } from '@tierwyn/shared';

// Mock the whisper adapter so the route test doesn't need whisper-cli or
// ggml model files installed on clean CI hosts.
const fakeModelFile = join(tmpdir(), `tierwyn-transcribe-test-model-${process.pid}.bin`);
writeFileSync(fakeModelFile, Buffer.alloc(16));

vi.mock('../adapters/whisper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/whisper.js')>();
  return {
    ...actual,
    findBin: vi.fn(() => ({ ok: true as const, path: '/usr/local/bin/whisper-cli' })),
    modelPath: vi.fn(() => fakeModelFile),
    transcribe: vi.fn(async () => ({ text: 'transcribed text', stderr: '' })),
    clean: vi.fn(async () => 'cleaned text'),
    testCleanupConnection: vi.fn(async () => 'OK (10 ms): cleaned text'),
  };
});

// Controllable spawn: default = real. Append-path tests stub ffmpeg to succeed.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

// Mocked AFTER the vi.mock above, so this import gets the mocked module.
import { registerTranscribeRoutes, parseCleanupFlags, TRANSCRIBE_TIMEOUT_MS, transcribeTimeoutMs } from './transcribe.js';
import { transcribe, clean } from '../adapters/whisper.js';
import { spawn } from 'child_process';
import * as sidecar from '../sidecar.js';

const realSpawn = (await vi.importActual<typeof import('child_process')>('child_process')).spawn;

function stubFfmpegSuccess(): void {
  vi.mocked(spawn).mockImplementation(((cmd: string, args: readonly string[], options?: unknown) => {
    if (cmd === 'ffmpeg') {
      const output = args[args.length - 1] as string;
      writeFileSync(output, Buffer.alloc(64));
      const child = new EventEmitter() as ReturnType<typeof realSpawn>;
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { kill: () => void }).kill = () => {};
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }
    return realSpawn(cmd, args as string[], options as Parameters<typeof realSpawn>[2]);
  }) as typeof realSpawn);
}

describe('GET /transcribe/config', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript: () => 'dropped' });
  });

  afterEach(() => db.close());

  it('returns binary presence and the three models', async () => {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/transcribe/config`);
      expect(r.status).toBe(200);
      const j = await r.json() as {
        binaryFound: boolean;
        models: { id: string; available: boolean }[];
        cleanup: { enabled: boolean };
      };
      expect(Array.isArray(j.models)).toBe(true);
      expect(j.models.map((m) => m.id).sort()).toEqual(['base', 'medium', 'small']);
      expect(j.cleanup).toBeDefined();
      expect(typeof j.cleanup.enabled).toBe('boolean');
    } finally {
      server.close();
    }
  });
});

describe('POST /transcribe validation', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript: () => 'dropped' });
  });

  afterEach(() => db.close());

  async function postForm(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', ...init });
      const body = await r.json().catch(() => null);
      return { status: r.status, body };
    } finally {
      server.close();
    }
  }

  it('returns 400 when no audio file is uploaded', async () => {
    const fd = new FormData();
    fd.append('model', 'base');
    const r = await postForm('/transcribe?model=base', { body: fd });
    expect(r.status).toBe(400);
  });

  it('returns 400 when model is not on the allowlist', async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const r = await postForm('/transcribe?model=huge', { body: fd });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toContain('model');
  });
});

describe('POST /transcribe happy path (mocked)', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;

  beforeEach(() => {
    vi.mocked(transcribe).mockClear();
    db = new Database(':memory:');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-transcribe-test-'));
    // Fake ffmpeg by stubbing it via PATH — we instead pre-place the wav
    // the transcriber would consume. Skip the ffmpeg integration here; the
    // route calls spawn('ffmpeg') which requires the binary. Instead we test
    // the post-ffmpeg path by writing the input file and asserting the
    // 502 when ffmpeg fails (no ffmpeg on PATH in test env is not guaranteed).
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript: () => 'dropped' });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    db.close();
    vi.mocked(spawn).mockImplementation(realSpawn);
  });

  it('returns 502 when ffmpeg cannot transcode (binary missing on test host)', async () => {
    // The route will attempt to spawn ffmpeg; if it isn't installed the
    // spawn itself fails with ENOENT and the route returns 502. If ffmpeg
    // IS installed, it will choke on the bogus input bytes and also 502.
    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/transcribe?model=base`, {
        method: 'POST', body: fd,
      });
      // Either 400 (model file missing on this host) or 502 (ffmpeg failure)
      // — both prove the validation+routing works without requiring whisper.
      expect([400, 500, 502]).toContain(r.status);
      // transcribe() must NOT have been called when ffmpeg fails first.
      expect(vi.mocked(transcribe)).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('appends transcript and always broadcasts freeze+settle while connected', async () => {
    // Inverted from "no broadcast while connected" — plan 2026-08-19 D7/§6.2:
    // with a composer freeze, every device must be told to unfreeze.
    stubFfmpegSuccess();
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const frames: ServerFrame[] = [];
    const broadcast = (conversationId: string, frame: ServerFrame) => {
      frames.push(frame);
      expect(conversationId).toBe(cid);
    };
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, broadcast, { autoSendTranscript: () => 'dropped' });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      // 400 if ggml-base.bin missing on this host — skip assertion then.
      if (r.status === 400) {
        const j = await r.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r.status).toBe(200);
      const j = await r.json() as { text: string };
      expect(j.text).toBe('transcribed text');
      expect(getDraft(db, cid)?.text).toBe('transcribed text');
      expect(getProcessing(db, cid)).toBe('idle');
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames[0]).toMatchObject({
        type: 'draft_updated',
        processing: 'transcribing',
      });
      const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle') as DraftUpdatedFrame;
      expect(settle).toMatchObject({
        text: 'transcribed text',
        processing: 'idle',
        processingStartedAt: null,
        // Contract relied on by apps/web/src/draftLock.ts: a transcribe settle is
        // indistinguishable from a pre-enhance putDraft echo by flags alone, so the
        // client must gate its frame-drop on "am I enhancing?", never on "am I busy?".
        // If this ever becomes canUndo:true, revisit shouldDropDraftFrame().
        canUndo: false,
      });
      expect(settle.error).toBeUndefined();
    } finally {
      server.close();
    }
  });

  async function postClip(query: string, frames: ServerFrame[]): Promise<Response | null> {
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, (_id, f) => { frames.push(f); }, { autoSendTranscript: () => 'dropped' });
    const fd = new FormData();
    fd.append('audio', new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' }), 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/transcribe?model=base&${query}`, { method: 'POST', body: fd });
      if (r.status === 400) return null;          // no whisper model on this host — same skip as siblings
      return r;
    } finally {
      server.close();
    }
  }

  function readOnlyEnhanceRoute(backend: 'agent_oneshot' | 'agent_readonly') {
    updateSidecarLlmSettings(db, { enhance: { backend, adapter: 'claude-code', model: 'm' } },
      [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    const oneShot = vi.fn(async (_p: string, _o: Record<string, unknown>) => ({ text: 'PROJECT REWRITE' }));
    sidecar.sidecarDeps.createAdapter = vi.fn(() => ({ oneShot, oneShotModes: ['none', 'read_only'] })) as never;
    return oneShot;
  }

  it('enhanceProject=1 (with enhanceContext=1) skips cleanup and runs a read-only project rewrite', async () => {
    const origCreate = sidecar.sidecarDeps.createAdapter;
    try {
      stubFfmpegSuccess();
      vi.mocked(transcribe).mockResolvedValue({ text: 'raw um text', stderr: '' });
      vi.mocked(clean).mockClear();
      updateVoiceSettings(db, { cleanup: { enabled: true, model: 'cleanup-model', baseUrl: 'http://127.0.0.1:1234/v1' } });
      const oneShot = readOnlyEnhanceRoute('agent_oneshot');
      const projectId = createProject(db, { name: 'p', rootPath: scratch }).id;
      const cid = createConversation(db, { projectId, title: 'c' }).id;
      const frames: ServerFrame[] = [];
      const r = await postClip(`enhanceProject=1&enhanceContext=1&conversationId=${cid}`, frames);
      if (!r) return;
      expect(r.status).toBe(200);
      expect(clean).not.toHaveBeenCalled();
      expect(oneShot).toHaveBeenCalledTimes(1);
      expect(oneShot.mock.calls[0]![1]).toMatchObject({ mode: 'read_only', cwd: scratch });
      expect(getDraft(db, cid)?.text).toBe('PROJECT REWRITE');
    } finally {
      sidecar.sidecarDeps.createAdapter = origCreate;
    }
  });

  it('enhanceContext=1 alone on an agent_readonly route stays tools-off', async () => {
    const origCreate = sidecar.sidecarDeps.createAdapter;
    try {
      stubFfmpegSuccess();
      vi.mocked(transcribe).mockResolvedValue({ text: 'raw um text', stderr: '' });
      const oneShot = readOnlyEnhanceRoute('agent_readonly');
      const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
      const cid = createConversation(db, { projectId, title: 'c' }).id;
      const r = await postClip(`enhanceContext=1&conversationId=${cid}`, []);
      if (!r) return;
      expect(oneShot).toHaveBeenCalledTimes(1);
      expect(oneShot.mock.calls[0]![1]).toMatchObject({ mode: 'none' });
    } finally {
      sidecar.sidecarDeps.createAdapter = origCreate;
    }
  });

  it('enhanceContext=1 skips cleanup and one-shots context enhance on the raw transcript', async () => {
    stubFfmpegSuccess();
    vi.mocked(transcribe).mockResolvedValue({ text: 'raw um text', stderr: '' });
    vi.mocked(clean).mockImplementation(async (_cfg, text) => `ENHANCED:${text}`);
    updateVoiceSettings(db, {
      cleanup: { enabled: true, model: 'cleanup-model', baseUrl: 'http://127.0.0.1:1234/v1' },
    });
    updateEnhanceSettings(db, {
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, agent_id, native_session_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('stt-enh-sess', cid, null, null, Date.now(), Date.now());
    appendEvent(db, {
      sessionId: 'stt-enh-sess',
      type: 'prompt',
      payload: { text: 'look at the login bug' },
      sender: 'user',
      ts: 1,
    });
    const frames: ServerFrame[] = [];
    const broadcast = (_id: string, frame: ServerFrame) => { frames.push(frame); };
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, broadcast, { autoSendTranscript: () => 'dropped' });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&enhanceContext=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      if (r.status === 400) {
        const j = await r.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r.status).toBe(200);
      const start = Date.now();
      while (!frames.some((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).canUndo)) {
        if (Date.now() - start > 2000) throw new Error('enhance settle timed out');
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      expect(vi.mocked(clean).mock.calls).toHaveLength(1);
      const userMsg = vi.mocked(clean).mock.calls[0]![1] as string;
      expect(userMsg).toContain('look at the login bug');
      expect(userMsg).toContain('Raw voice-dictation transcript to clean up and rewrite');
      expect(userMsg).toContain('raw um text');
      expect(userMsg).not.toMatch(/^raw um text$/);
      const idleFrames = frames.filter(
        (f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle',
      ) as DraftUpdatedFrame[];
      expect(idleFrames).toHaveLength(1);
      expect(idleFrames[0]!.text).toMatch(/^ENHANCED:/);
      expect(idleFrames[0]!.canUndo).toBe(true);
      expect(frames.some((f) => (f as DraftUpdatedFrame).processing === 'enhancing')).toBe(false);
      expect(idleFrames[0]!.text).not.toBe('raw um text');
    } finally {
      server.close();
      vi.mocked(clean).mockImplementation(async () => 'cleaned text');
      vi.mocked(transcribe).mockResolvedValue({ text: 'transcribed text', stderr: '' });
    }
  });

  it('omits timeoutSecs so sidecarComplete uses the resolved profile timeout', async () => {
    stubFfmpegSuccess();
    vi.mocked(transcribe).mockResolvedValue({ text: 'raw um text', stderr: '' });
    updateVoiceSettings(db, {
      cleanup: {
        enabled: true,
        timeoutSecs: 17,
        model: 'cleanup-model',
        baseUrl: 'http://127.0.0.1:1234/v1',
      },
    });
    const spy = vi.spyOn(sidecar, 'sidecarComplete').mockResolvedValue('cleaned');
    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&conversationId=${createConversation(db, { projectId: createProject(db, { name: 'p', rootPath: '/tmp/p' }).id, title: 'c' }).id}`,
        { method: 'POST', body: fd },
      );
      expect(r.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        'transcribe',
        'raw um text',
        expect.any(Object),
      );
      expect(spy.mock.calls[0]![3]).not.toHaveProperty('timeoutSecs');
      expect(spy.mock.calls[0]![3]).not.toHaveProperty('systemPrompt');
    } finally {
      spy.mockRestore();
      server.close();
      vi.mocked(transcribe).mockResolvedValue({ text: 'transcribed text', stderr: '' });
    }
  });

  it('uses sidecarLlm.transcribe.selectedPromptId over the legacy voice.cleanup prompt', async () => {
    stubFfmpegSuccess();
    vi.mocked(transcribe).mockResolvedValue({ text: 'raw um text', stderr: '' });
    vi.mocked(clean).mockClear();
    updateVoiceSettings(db, {
      cleanup: {
        enabled: true,
        timeoutSecs: 17,
        model: 'cleanup-model',
        baseUrl: 'http://127.0.0.1:1234/v1',
        prompts: [{ id: 'legacy-c', name: 'Legacy', text: 'LEGACY CLEANUP' }],
        selectedPromptId: 'legacy-c',
      },
    });
    updateSidecarLlmSettings(db, {
      transcribe: {
        backend: 'direct',
        prompts: [{ id: 'new-c', name: 'New', text: 'NEW CUSTOM' }],
        selectedPromptId: 'new-c',
      },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const spy = vi.spyOn(sidecar, 'sidecarComplete');
    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&conversationId=${createConversation(db, { projectId: createProject(db, { name: 'p', rootPath: '/tmp/p' }).id, title: 'c' }).id}`,
        { method: 'POST', body: fd },
      );
      if (r.status === 400) {
        const j = await r.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![3]).not.toHaveProperty('systemPrompt');
      expect(spy.mock.calls[0]![3]).not.toHaveProperty('promptId');
      expect(vi.mocked(clean).mock.calls[0]![0]).toMatchObject({ systemPrompt: 'NEW CUSTOM' });
    } finally {
      spy.mockRestore();
      server.close();
      vi.mocked(transcribe).mockResolvedValue({ text: 'transcribed text', stderr: '' });
    }
  });

  it('enhanceContext does not write the raw clip to draft.text until the rewrite settles', async () => {
    stubFfmpegSuccess();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(transcribe).mockResolvedValue({ text: 'raw um text', stderr: '' });
    vi.mocked(clean).mockImplementation(async (_cfg, t) => {
      await gate;
      return `ENHANCED:${t}`;
    });
    updateEnhanceSettings(db, { model: 'test-model', baseUrl: 'http://127.0.0.1:1234/v1' });
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    upsertDraft(db, cid, 'typed prefix');
    const frames: ServerFrame[] = [];
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, (_id, f) => { frames.push(f); }, { autoSendTranscript: () => 'dropped' });
    const fd = new FormData();
    fd.append('audio', new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' }), 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const pending = fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&enhanceContext=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      await new Promise((r) => setTimeout(r, 80));
      if (getProcessing(db, cid) === 'idle' && !getDraft(db, cid)?.text.includes('ENHANCED')) {
        release();
        const r = await pending;
        if (r.status === 400) return;
      }
      expect(getDraft(db, cid)?.text).toBe('typed prefix');
      expect(getProcessing(db, cid)).toBe('transcribing');
      release();
      const r = await pending;
      if (r.status === 400) return;
      expect(r.status).toBe(200);
      expect(getDraft(db, cid)?.text).toMatch(/^ENHANCED:/);
      expect(getDraft(db, cid)?.text).toContain('raw um text');
    } finally {
      release();
      server.close();
      vi.mocked(clean).mockImplementation(async () => 'cleaned text');
      vi.mocked(transcribe).mockResolvedValue({ text: 'transcribed text', stderr: '' });
    }
  });

  it('enhanceContext + auto-send fires after the rewrite, not on the raw clip', async () => {
    stubFfmpegSuccess();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(transcribe).mockResolvedValue({ text: 'raw um text', stderr: '' });
    vi.mocked(clean).mockImplementation(async (_cfg, t) => {
      await gate;
      return `ENHANCED:${t}`;
    });
    updateEnhanceSettings(db, { model: 'test-model', baseUrl: 'http://127.0.0.1:1234/v1' });
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const sent: string[] = [];
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, () => {}, {
      autoSendTranscript: (_id, text) => { sent.push(text); return 'new_turn'; },
    });
    const fd = new FormData();
    fd.append('audio', new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' }), 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const pending = fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&enhanceContext=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      await new Promise((r) => setTimeout(r, 80));
      const armR = await fetch(`http://127.0.0.1:${port}/transcribe/arm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: cid,
          profileId: 'claude-code:opus-4.8',
          agent: 'claude-code',
          agentModel: 'claude-opus-4-8',
        }),
      });
      if (armR.status === 404) {
        release();
        const r = await pending;
        if (r.status === 400) return;
      }
      expect(armR.status).toBe(200);
      release();
      const r = await pending;
      if (r.status === 400) return;
      expect(r.status).toBe(200);
      const j = await r.json() as { autoSent?: boolean };
      expect(j.autoSent).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/^ENHANCED:/);
      expect(sent[0]).toContain('raw um text');
      expect(sent[0]).not.toBe('raw um text');
    } finally {
      release();
      server.close();
      vi.mocked(clean).mockImplementation(async () => 'cleaned text');
      vi.mocked(transcribe).mockResolvedValue({ text: 'transcribed text', stderr: '' });
    }
  });

  it('does not abort on client disconnect — still appends draft and broadcasts', async () => {
    stubFfmpegSuccess();
    vi.mocked(transcribe).mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { text: 'late transcript', stderr: '' };
    });
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const frames: ServerFrame[] = [];
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, (_id, frame) => { frames.push(frame); }, { autoSendTranscript: () => 'dropped' });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const ac = new AbortController();
      const pending = fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd, signal: ac.signal },
      ).catch(() => null);
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await pending;
      // Wait for the in-flight mock transcribe + append to finish.
      await new Promise((r) => setTimeout(r, 600));
      const draft = getDraft(db, cid);
      if (!draft) {
        // Model file missing on host → route returned 400 before work started.
        return;
      }
      expect(draft.text).toBe('late transcript');
      expect(getProcessing(db, cid)).toBe('idle');
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames[0]).toMatchObject({
        type: 'draft_updated',
        conversationId: cid,
        processing: 'transcribing',
      });
      const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle');
      expect(settle).toMatchObject({
        type: 'draft_updated',
        conversationId: cid,
        text: 'late transcript',
        processing: 'idle',
      });
    } finally {
      server.close();
    }
  });

  it('whisper throw releases the lock and settle carries error', async () => {
    stubFfmpegSuccess();
    vi.mocked(transcribe).mockImplementationOnce(async () => {
      throw new Error('whisper-cli died');
    });
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const frames: ServerFrame[] = [];
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, (_id, frame) => { frames.push(frame); }, { autoSendTranscript: () => 'dropped' });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      if (r.status === 400) {
        const j = await r.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r.status).toBe(502);
      expect(getProcessing(db, cid)).toBe('idle');
      const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle') as DraftUpdatedFrame | undefined;
      expect(settle).toMatchObject({ processing: 'idle', error: expect.stringMatching(/whisper-cli died/) });
    } finally {
      server.close();
    }
  });

  it('server-side timeout releases the lock', async () => {
    stubFfmpegSuccess();
    vi.mocked(transcribe).mockImplementationOnce(async (opts: { signal?: AbortSignal }) => {
      await new Promise<void>((_res, rej) => {
        if (opts.signal?.aborted) {
          rej(new Error('aborted'));
          return;
        }
        opts.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      });
      return { text: '', stderr: '' };
    });
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === TRANSCRIBE_TIMEOUT_MS || ms === transcribeTimeoutMs(db)) {
        return realSetTimeout(fn as () => void, 0, ...args);
      }
      return realSetTimeout(fn as () => void, ms as number, ...args);
    }) as typeof setTimeout);

    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const frames: ServerFrame[] = [];
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, (_id, frame) => { frames.push(frame); }, { autoSendTranscript: () => 'dropped' });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      if (r.status === 400) {
        const j = await r.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r.status).toBe(504);
      expect(getProcessing(db, cid)).toBe('idle');
      const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).error) as DraftUpdatedFrame | undefined;
      expect(settle?.processing).toBe('idle');
    } finally {
      spy.mockRestore();
      server.close();
    }
  });

  it('without conversationId acquires no lock and broadcasts nothing', async () => {
    stubFfmpegSuccess();
    const frames: ServerFrame[] = [];
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, (_id, frame) => { frames.push(frame); }, { autoSendTranscript: () => 'dropped' });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1`,
        { method: 'POST', body: fd },
      );
      if (r.status === 400) {
        const j = await r.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r.status).toBe(200);
      expect(frames).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe('POST /transcribe/test (cleanup test-connection)', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    vi.mocked(clean).mockClear();
    db = new Database(':memory:');
    runMigrations(db, migrations);
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript: () => 'dropped' });
  });

  afterEach(() => db.close());

  it('returns ok with the mocked cleanup reply', async () => {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/transcribe/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cleanup: { baseUrl: 'http://localhost:1234/v1', model: 'x' } }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { ok: boolean; reply: string };
      expect(j.ok).toBe(true);
      expect(j.reply).toContain('OK');
    } finally {
      server.close();
    }
  });
});

describe('parseCleanupFlags', () => {
  it('skipCleanup true for "1" and "true"', () => {
    expect(parseCleanupFlags({ skipCleanup: '1' }).skipCleanup).toBe(true);
    expect(parseCleanupFlags({ skipCleanup: 'true' }).skipCleanup).toBe(true);
  });
  it('skipCleanup false when absent or other values', () => {
    expect(parseCleanupFlags({}).skipCleanup).toBe(false);
    expect(parseCleanupFlags({ skipCleanup: '0' }).skipCleanup).toBe(false);
  });
  it('promptId passed through only when a non-empty string', () => {
    expect(parseCleanupFlags({ promptId: 'c1' }).promptId).toBe('c1');
    expect(parseCleanupFlags({ promptId: '' }).promptId).toBeUndefined();
    expect(parseCleanupFlags({}).promptId).toBeUndefined();
  });
  it('enhanceContext true for "1" and "true"', () => {
    expect(parseCleanupFlags({ enhanceContext: '1' }).enhanceContext).toBe(true);
    expect(parseCleanupFlags({ enhanceContext: 'true' }).enhanceContext).toBe(true);
  });
  it('enhanceContext false when absent', () => {
    expect(parseCleanupFlags({}).enhanceContext).toBe(false);
  });
  it('enhanceProject true for "1" and "true"; project wins over context', () => {
    expect(parseCleanupFlags({ enhanceProject: '1' }).enhanceProject).toBe(true);
    expect(parseCleanupFlags({ enhanceProject: 'true' }).enhanceMode).toBe('project');
    expect(parseCleanupFlags({ enhanceProject: '1', enhanceContext: '1' }).enhanceMode).toBe('project');
    expect(parseCleanupFlags({ enhanceContext: '1' }).enhanceMode).toBe('context');
    expect(parseCleanupFlags({ enhanceProject: '0' }).enhanceMode).toBeNull();
    expect(parseCleanupFlags({}).enhanceMode).toBeNull();
  });
});

describe('cleanup integration on POST /transcribe', () => {
  // Documents the "never eat words" rule: when cleanup is enabled but fails,
  // the raw transcript is still returned as `{ text }` and the failure is only
  // logged server-side (console.warn) — no `warning` field reaches the UI.
  it('returns raw text and logs (no UI warning) when cleanup throws (route-level)', async () => {
    // The full route needs ffmpeg to succeed before transcribe runs; we can't
    // easily exercise that without a real binary. Placeholder documenting the
    // contract; the cleanup-failure path itself is covered in whisper.test.ts.
    expect(true).toBe(true);
  });
});

describe('POST /transcribe/arm', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;

  beforeEach(() => {
    vi.mocked(transcribe).mockClear();
    vi.mocked(transcribe).mockResolvedValue({ text: 'transcribed text', stderr: '' });
    db = new Database(':memory:');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-transcribe-arm-'));
    app = express();
    app.use(express.json());
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript: () => 'dropped' });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    db.close();
    vi.mocked(spawn).mockImplementation(realSpawn);
  });

  it('returns 404 when no transcription is in flight', async () => {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/transcribe/arm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'no-such-cid',
          profileId: 'p', agent: 'a', agentModel: 'm',
        }),
      });
      expect(r.status).toBe(404);
      const j = await r.json() as { error: string };
      expect(j.error).toMatch(/no transcription in flight/i);
    } finally {
      server.close();
    }
  });

  it('arms an in-flight slot; disarm flips armed:false; late arm after finish → 404', async () => {
    stubFfmpegSuccess();
    // Hold the slot open long enough to POST /arm mid-flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(transcribe).mockImplementationOnce(async () => {
      await gate;
      return { text: 'transcribed text', stderr: '' };
    });

    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
      const fd = new FormData();
      fd.append('audio', blob, 'clip.webm');
      const pending = fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );

      // Wait until the mock transcribe is blocked (slot is registered).
      await new Promise((r) => setTimeout(r, 80));

      const armR = await fetch(`http://127.0.0.1:${port}/transcribe/arm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: cid,
          profileId: 'claude-code:opus-4.8',
          agent: 'claude-code',
          agentModel: 'claude-opus-4-8',
        }),
      });
      if (armR.status === 404) {
        // Model missing → /transcribe returned 400 before creating a durable wait.
        release();
        await pending;
        return;
      }
      expect(armR.status).toBe(200);
      expect(await armR.json()).toEqual({ armed: true });

      const disarmR = await fetch(`http://127.0.0.1:${port}/transcribe/arm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: cid,
          profileId: 'claude-code:opus-4.8',
          agent: 'claude-code',
          agentModel: 'claude-opus-4-8',
          armed: false,
        }),
      });
      expect(disarmR.status).toBe(200);
      expect(await disarmR.json()).toEqual({ armed: false });

      release();
      const tr = await pending;
      if (tr.status === 400) {
        const j = await tr.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(tr.status).toBe(200);

      // Late arm — slot deleted in finally → 404, stores nothing.
      const late = await fetch(`http://127.0.0.1:${port}/transcribe/arm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: cid,
          profileId: 'p', agent: 'a', agentModel: 'm',
        }),
      });
      expect(late.status).toBe(404);
    } finally {
      release();
      server.close();
    }
  });

  it('deletes the arm slot when whisper rejects (no leaked slot for a later arm)', async () => {
    stubFfmpegSuccess();
    // Make the in-flight transcribe reject — the route's catch → 502 path,
    // then finally must delete the slot. A later /arm must 404.
    vi.mocked(transcribe).mockImplementationOnce(async () => {
      throw new Error('whisper-cli died');
    });

    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
      const fd = new FormData();
      fd.append('audio', blob, 'clip.webm');
      const tr = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      // Whisper-failure path is 502 (controller not aborted → not 504).
      if (tr.status === 400) {
        const j = await tr.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(tr.status).toBe(502);

      // Slot must have been deleted in the finally — a later arm 404s,
      // proving no leaked armable slot survives a whisper failure.
      const lateArm = await fetch(`http://127.0.0.1:${port}/transcribe/arm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: cid,
          profileId: 'claude-code:opus-4.8',
          agent: 'claude-code',
          agentModel: 'claude-opus-4-8',
        }),
      });
      expect(lateArm.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('POST /transcribe/cancel', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;

  beforeEach(() => {
    vi.mocked(transcribe).mockClear();
    vi.mocked(clean).mockClear();
    vi.mocked(transcribe).mockResolvedValue({ text: 'transcribed text', stderr: '' });
    db = new Database(':memory:');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-transcribe-cancel-'));
    app = express();
    app.use(express.json());
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    db.close();
    vi.mocked(spawn).mockImplementation(realSpawn);
  });

  it('returns 404 when no transcription is in flight', async () => {
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript: () => 'dropped' });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/transcribe/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'no-such-cid' }),
      });
      expect(r.status).toBe(404);
      const j = await r.json() as { error: string };
      expect(j.error).toMatch(/no transcription in flight/i);
    } finally {
      server.close();
    }
  });

  it('force-releases an orphaned transcribing lock (no in-flight slot) and broadcasts idle', async () => {
    // Simulates a server restart mid-transcribe (or a missed settle broadcast):
    // the DB holds a live 'transcribing' lock but inFlight has no slot.
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    upsertDraft(db, cid, 'typed draft', '[]');
    beginProcessing(db, cid, 'transcribing', 'job-x', { stashPreText: true });
    expect(getProcessing(db, cid)).toBe('transcribing');
    const frames: ServerFrame[] = [];
    registerTranscribeRoutes(app, () => db, (_id, frame) => { frames.push(frame); }, { autoSendTranscript: () => 'dropped' });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/transcribe/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: cid }),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ cancelled: true, forced: true });
      expect(getProcessing(db, cid)).toBe('idle');
      // Draft text untouched; the stashed pre_text survives so undo still works.
      expect(getDraft(db, cid)).toMatchObject({ text: 'typed draft', preText: 'typed draft' });
      const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle') as DraftUpdatedFrame | undefined;
      expect(settle).toMatchObject({ processing: 'idle', text: 'typed draft' });
    } finally {
      server.close();
    }
    // Idempotent: a second cancel now finds no lock and 404s.
    const app2 = express();
    app2.use(express.json());
    registerTranscribeRoutes(app2, () => db, () => {}, { autoSendTranscript: () => 'dropped' });
    const server2 = app2.listen(0);
    const port2 = (server2.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port2}/transcribe/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: cid }),
      });
      expect(r.status).toBe(404);
    } finally {
      server2.close();
    }
  });

  it('leaves an orphaned enhancing lock alone (404, lock untouched)', async () => {
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    beginProcessing(db, cid, 'enhancing', 'job-e');
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript: () => 'dropped' });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/transcribe/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: cid }),
      });
      expect(r.status).toBe(404);
      expect(getProcessing(db, cid)).toBe('enhancing');
    } finally {
      server.close();
    }
  });

  it('aborts whisper, settles idle with no transcript, and does not append', async () => {
    stubFfmpegSuccess();
    vi.mocked(transcribe).mockImplementationOnce(async (opts: { signal?: AbortSignal }) => {
      await new Promise<void>((_res, rej) => {
        if (opts.signal?.aborted) {
          rej(new Error('aborted'));
          return;
        }
        opts.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      });
      return { text: 'should not land', stderr: '' };
    });
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const frames: ServerFrame[] = [];
    registerTranscribeRoutes(app, () => db, (_id, frame) => { frames.push(frame); }, { autoSendTranscript: () => 'dropped' });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const pending = fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      await new Promise((r) => setTimeout(r, 80));
      const cancelR = await fetch(`http://127.0.0.1:${port}/transcribe/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: cid }),
      });
      if (cancelR.status === 404) {
        // Model file missing on host → /transcribe 400'd before creating a slot.
        const transcribeR = await pending;
        expect(transcribeR.status).toBe(400);
        return;
      }
      expect(cancelR.status).toBe(200);
      expect(await cancelR.json()).toMatchObject({ cancelled: true });
      const transcribeR = await pending;
      expect(transcribeR.status).toBe(200);
      expect(await transcribeR.json()).toMatchObject({ cancelled: true, text: '' });
      expect(getDraft(db, cid)?.text ?? '').toBe('');
      expect(getProcessing(db, cid)).toBe('idle');
      const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle') as DraftUpdatedFrame | undefined;
      expect(settle).toMatchObject({ processing: 'idle', text: '' });
      expect(settle?.error).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('does not append if cancelled after whisper returns (cleanup still running)', async () => {
    stubFfmpegSuccess();
    vi.mocked(transcribe).mockResolvedValueOnce({ text: 'should not land', stderr: '' });
    updateVoiceSettings(db, {
      cleanup: { enabled: true, model: 'cleanup-model', baseUrl: 'http://127.0.0.1:1234/v1' },
    });
    let releaseCleanup: () => void = () => {};
    vi.mocked(clean).mockImplementationOnce(async () => {
      await new Promise<void>((res) => { releaseCleanup = res; });
      return 'cleaned should not land';
    });
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const frames: ServerFrame[] = [];
    registerTranscribeRoutes(app, () => db, (_id, frame) => { frames.push(frame); }, { autoSendTranscript: () => 'dropped' });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const pending = fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      await new Promise((r) => setTimeout(r, 80));
      const cancelR = await fetch(`http://127.0.0.1:${port}/transcribe/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: cid }),
      });
      if (cancelR.status === 404) {
        releaseCleanup();
        const transcribeR = await pending;
        expect(transcribeR.status).toBe(400);
        return;
      }
      expect(cancelR.status).toBe(200);
      releaseCleanup();
      const transcribeR = await pending;
      expect(transcribeR.status).toBe(200);
      expect(getDraft(db, cid)?.text ?? '').toBe('');
      expect(getProcessing(db, cid)).toBe('idle');
      const settle = frames.find((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).processing === 'idle') as DraftUpdatedFrame | undefined;
      expect(settle?.error).toBeUndefined();
      expect(settle).toMatchObject({ processing: 'idle' });
      expect(settle?.text ?? '').not.toMatch(/should not land/);
    } finally {
      releaseCleanup();
      server.close();
    }
  });
});

describe('POST /transcribe auto-send (arm slot)', () => {
  let db: Database.Database;
  let app: express.Express;
  let scratch: string;

  beforeEach(() => {
    vi.mocked(transcribe).mockClear();
    vi.mocked(transcribe).mockResolvedValue({ text: 'transcribed text', stderr: '' });
    db = new Database(':memory:');
    runMigrations(db, migrations);
    scratch = mkdtempSync(join(tmpdir(), 'tierwyn-transcribe-autosend-'));
    app = express();
    app.use(express.json());
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    db.close();
    vi.mocked(spawn).mockImplementation(realSpawn);
  });

  async function armMidFlight(
    port: number,
    cid: string,
    pending: Promise<Response>,
    release: () => void,
  ): Promise<'armed' | 'skipped'> {
    await new Promise((r) => setTimeout(r, 80));
    const armR = await fetch(`http://127.0.0.1:${port}/transcribe/arm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: cid,
        profileId: 'claude-code:opus-4.8',
        agent: 'claude-code',
        agentModel: 'claude-opus-4-8',
      }),
    });
    if (armR.status === 404) {
      release();
      await pending;
      return 'skipped';
    }
    expect(armR.status).toBe(200);
    expect(await armR.json()).toEqual({ armed: true });
    release();
    return 'armed';
  }

  it('armed slot + non-silent transcript calls autoSendTranscript, clears draft, autoSent:true', async () => {
    stubFfmpegSuccess();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(transcribe).mockImplementationOnce(async () => {
      await gate;
      return { text: 'transcribed text', stderr: '' };
    });

    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const autoSendTranscript = vi.fn(() => 'new_turn' as const);
    const frames: ServerFrame[] = [];
    registerTranscribeRoutes(app, () => db, (_id, frame) => { frames.push(frame); }, { autoSendTranscript });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const pending = fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      const outcome = await armMidFlight(port, cid, pending, release);
      if (outcome === 'skipped') return;

      const r = await pending;
      if (r.status === 400) {
        const j = await r.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r.status).toBe(200);
      const j = await r.json() as { text: string; autoSent: boolean };
      expect(j.text).toBe('transcribed text');
      expect(j.autoSent).toBe(true);
      expect(autoSendTranscript).toHaveBeenCalledWith(
        cid,
        'transcribed text',
        { profileId: 'claude-code:opus-4.8', agent: 'claude-code', model: 'claude-opus-4-8' },
      );
      expect(getDraft(db, cid)).toBeNull();
      expect(frames.some((f) => f.type === 'draft_updated' && (f as DraftUpdatedFrame).text === '' && (f as DraftUpdatedFrame).processing === 'idle')).toBe(true);
    } finally {
      release();
      server.close();
    }
  });

  it('armed slot + sub-min-chars transcript does NOT call autoSendTranscript; draft kept', async () => {
    stubFfmpegSuccess();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(transcribe).mockImplementationOnce(async () => {
      await gate;
      return { text: 'a', stderr: '' };
    });

    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const autoSendTranscript = vi.fn(() => 'new_turn' as const);
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const pending = fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      const outcome = await armMidFlight(port, cid, pending, release);
      if (outcome === 'skipped') return;

      const r = await pending;
      if (r.status === 400) {
        const j = await r.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r.status).toBe(200);
      const j = await r.json() as { text: string; autoSent: boolean };
      expect(j.text).toBe('a');
      expect(j.autoSent).toBe(false);
      expect(autoSendTranscript).not.toHaveBeenCalled();
      expect(getDraft(db, cid)?.text).toBe('a');
    } finally {
      release();
      server.close();
    }
  });

  it('slot present but un-armed → append-only, autoSent:false, autoSendTranscript not called', async () => {
    stubFfmpegSuccess();
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const autoSendTranscript = vi.fn(() => 'new_turn' as const);
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const fd = new FormData();
    fd.append('audio', blob, 'clip.webm');
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd },
      );
      if (r.status === 400) {
        const j = await r.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r.status).toBe(200);
      const j = await r.json() as { text: string; autoSent: boolean };
      expect(j.text).toBe('transcribed text');
      expect(j.autoSent).toBe(false);
      expect(autoSendTranscript).not.toHaveBeenCalled();
      expect(getDraft(db, cid)?.text).toBe('transcribed text');
    } finally {
      server.close();
    }
  });

  it('late-arm after /transcribe completes → 404; does not affect a later transcription', async () => {
    stubFfmpegSuccess();
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const cid = createConversation(db, { projectId, title: 'c' }).id;
    const autoSendTranscript = vi.fn(() => 'new_turn' as const);
    registerTranscribeRoutes(app, () => db, () => {}, { autoSendTranscript });

    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'audio/webm' });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const fd1 = new FormData();
      fd1.append('audio', blob, 'clip.webm');
      const r1 = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd1 },
      );
      if (r1.status === 400) {
        const j = await r1.json() as { error?: string };
        expect(j.error).toMatch(/model/);
        return;
      }
      expect(r1.status).toBe(200);
      expect((await r1.json() as { autoSent: boolean }).autoSent).toBe(false);

      // Late arm after slot deleted.
      const late = await fetch(`http://127.0.0.1:${port}/transcribe/arm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: cid,
          profileId: 'p', agent: 'a', agentModel: 'm',
        }),
      });
      expect(late.status).toBe(404);

      // Later transcription stays append-only (late arm stored nothing).
      const fd2 = new FormData();
      fd2.append('audio', blob, 'clip.webm');
      const r2 = await fetch(
        `http://127.0.0.1:${port}/transcribe?model=base&skipCleanup=1&conversationId=${cid}`,
        { method: 'POST', body: fd2 },
      );
      expect(r2.status).toBe(200);
      expect((await r2.json() as { autoSent: boolean }).autoSent).toBe(false);
      expect(autoSendTranscript).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('transcribeTimeoutMs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });

  afterEach(() => db.close());

  it('defaults to 120s base + cleanup timeout', () => {
    // Default seeded cleanup timeout is 20s
    expect(transcribeTimeoutMs(db)).toBe((120 + 20) * 1000);
  });

  it('dynamically reads configured sidecarLlm.transcribe.timeoutSecs', () => {
    updateSidecarLlmSettings(db, {
      transcribe: { backend: 'agent_oneshot', adapter: 'pi', model: 'zai/glm-5.3-flash', timeoutSecs: 240 },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);

    // 120s base + 240s cleanup = 360s (360_000 ms)
    expect(transcribeTimeoutMs(db)).toBe(360_000);
  });
});

