import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { ServerFrame } from '@tierwyn/shared';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import {
  getDraft, upsertDraft,
  beginProcessing, endProcessing, PROCESSING_STALE_MS,
} from '../repositories/drafts.js';
import { ensureRemoteAgentsProject, seedCatalogue, REMOTE_AGENTS_PROJECT_ID } from '../db/seed.js';
import { createRemoteAgentConversation } from '../repositories/remoteAgents.js';
import { upsertDiscoveredModels } from '../repositories/models.js';
import { registerConversationMutationRoutes } from './conversations.js';

let server: Server;
let base: string;
let convId: string;
let frames: ServerFrame[];

beforeEach(async () => {
  frames = [];
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  setDb(db);
  const project = createProject(db, { name: 'p', rootPath: '/tmp' });
  convId = createConversation(db, { projectId: project.id, title: 'root' }).id;
  const app = express();
  app.use(express.json());
  registerConversationMutationRoutes(app, {
    getDb,
    broadcast: (_id, frame) => { frames.push(frame); },
  });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

const putDraft = (body: unknown) => fetch(`${base}/conversations/${convId}/draft`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const getDraftHttp = () => fetch(`${base}/conversations/${convId}/draft`);
const delDraft = () => fetch(`${base}/conversations/${convId}/draft`, { method: 'DELETE' });

describe('draft routes — attachments', () => {
  it('PUT round-trips attachments', async () => {
    const att = { base64: 'aGVsbG8=', mediaType: 'image/png', name: 't.png' };
    const put = await putDraft({ text: 'hi', attachments: [att] });
    expect(put.status).toBe(200);
    const putBody = await put.json() as { attachments: typeof att[] };
    expect(putBody.attachments).toEqual([att]);

    const get = await getDraftHttp();
    expect(get.status).toBe(200);
    const getBody = await get.json() as { text: string; attachments: typeof att[] };
    expect(getBody.text).toBe('hi');
    expect(getBody.attachments).toEqual([att]);
  });

  it('PUT over per-attachment cap returns 413', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024).toString('base64');
    const res = await putDraft({ text: 'x', attachments: [{ base64: big, mediaType: 'image/png' }] });
    expect(res.status).toBe(413);
  });

  it('PUT over total cap returns 413', async () => {
    const chunk = Buffer.alloc(5 * 1024 * 1024).toString('base64');
    const res = await putDraft({
      text: 'x',
      attachments: [
        { base64: chunk, mediaType: 'image/png' },
        { base64: chunk, mediaType: 'image/png' },
        { base64: chunk, mediaType: 'image/png' },
        { base64: chunk, mediaType: 'image/png' },
        { base64: chunk, mediaType: 'image/png' },
      ],
    });
    expect(res.status).toBe(413);
  });

  it('PUT over count cap returns 413', async () => {
    const tiny = Buffer.from('x').toString('base64');
    const attachments = Array.from({ length: 11 }, (_, i) => ({
      base64: tiny, mediaType: 'image/png', name: `f${i}.png`,
    }));
    const res = await putDraft({ text: 'x', attachments });
    expect(res.status).toBe(413);
  });

  it('GET on corrupt attachments JSON returns []', async () => {
    upsertDraft(getDb(), convId, 'bad', 'not-json');
    const res = await getDraftHttp();
    expect(res.status).toBe(200);
    const body = await res.json() as { attachments: unknown[] };
    expect(body.attachments).toEqual([]);
  });

  it('DELETE clears draft and broadcasts hasAttachments:false', async () => {
    await putDraft({ text: 'x', attachments: [{ base64: 'aQ==', mediaType: 'image/png' }] });
    frames.length = 0;
    const res = await delDraft();
    expect(res.status).toBe(204);
    expect(getDraft(getDb(), convId)).toBeNull();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'draft_updated',
      conversationId: convId,
      text: '',
      hasAttachments: false,
    });
    expect(JSON.stringify(frames[0])).not.toMatch(/base64/);
  });

  it('notifyDraft broadcast includes hasAttachments and no base64', async () => {
    frames.length = 0;
    await putDraft({ text: 'pic', attachments: [{ base64: 'aGVsbG8=', mediaType: 'image/png' }] });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'draft_updated',
      hasAttachments: true,
      text: 'pic',
    });
    expect(JSON.stringify(frames[0])).not.toMatch(/base64/);
  });

  it('PUT with attachments omitted preserves existing attachments', async () => {
    const att = { base64: 'aGVsbG8=', mediaType: 'image/png', name: 't.png' };
    await putDraft({ text: 'hi', attachments: [att] });

    frames.length = 0;
    const res = await putDraft({ text: 'updated text' });
    expect(res.status).toBe(200);
    const body = await res.json() as { text: string; attachments: typeof att[] };
    expect(body.text).toBe('updated text');
    expect(body.attachments).toEqual([att]);

    const get = await getDraftHttp();
    const getBody = await get.json() as { text: string; attachments: typeof att[] };
    expect(getBody.text).toBe('updated text');
    expect(getBody.attachments).toEqual([att]);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'draft_updated',
      hasAttachments: true,
      text: 'updated text',
    });
  });

  it('PUT with attachments:[] explicitly clears attachments', async () => {
    const att = { base64: 'aGVsbG8=', mediaType: 'image/png', name: 't.png' };
    await putDraft({ text: 'hi', attachments: [att] });

    frames.length = 0;
    const res = await putDraft({ text: 'cleared', attachments: [] });
    expect(res.status).toBe(200);
    const body = await res.json() as { text: string; attachments: unknown[] };
    expect(body.text).toBe('cleared');
    expect(body.attachments).toEqual([]);

    const get = await getDraftHttp();
    const getBody = await get.json() as { text: string; attachments: unknown[] };
    expect(getBody.attachments).toEqual([]);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'draft_updated',
      hasAttachments: false,
      text: 'cleared',
    });
  });

  it('PUT with profileId updates draft profile and broadcasts it', async () => {
    frames.length = 0;
    const res = await putDraft({ profileId: 'pi:glm-4.7' });
    expect(res.status).toBe(200);
    const body = await res.json() as { profileId: string };
    expect(body.profileId).toBe('pi:glm-4.7');

    const get = await getDraftHttp();
    expect(get.status).toBe(200);
    const getBody = await get.json() as { profileId: string; text: string };
    expect(getBody.profileId).toBe('pi:glm-4.7');
    expect(getBody.text).toBe('');

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'draft_updated',
      profileId: 'pi:glm-4.7',
    });
  });

  it('profile-only PUT preserves existing text', async () => {
    await putDraft({ text: 'hello' });
    frames.length = 0;
    const res = await putDraft({ profileId: 'pi:glm-4.7' });
    expect(res.status).toBe(200);
    const body = await res.json() as { text: string; profileId: string };
    expect(body.text).toBe('hello');
    expect(body.profileId).toBe('pi:glm-4.7');

    const get = await getDraftHttp();
    const getBody = await get.json() as { text: string; profileId: string };
    expect(getBody.text).toBe('hello');
    expect(getBody.profileId).toBe('pi:glm-4.7');
    expect(frames[0]).toMatchObject({
      type: 'draft_updated',
      text: 'hello',
      profileId: 'pi:glm-4.7',
    });
  });

  it('profile-only PUT raced with a text PUT does not clobber the text', async () => {
    const [textRes, profileRes] = await Promise.all([
      putDraft({ text: 'hello' }),
      putDraft({ profileId: 'pi:glm-4.7' }),
    ]);
    expect(textRes.status).toBe(200);
    expect(profileRes.status).toBe(200);
    const get = await getDraftHttp();
    const getBody = await get.json() as { text: string };
    expect(getBody.text).toBe('hello');
  });
});

describe('draft routes — processing lock', () => {
  const postDraft = (body: unknown) => fetch(`${base}/conversations/${convId}/draft`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const undoEnhance = () => fetch(`${base}/conversations/${convId}/draft/undo-enhance`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });

  it('GET /draft on an idle conversation returns idle processing fields', async () => {
    const res = await getDraftHttp();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      text: '',
      processing: 'idle',
      processingStartedAt: null,
      canUndo: false,
    });
  });

  it('GET /draft while a lock is held returns enhancing and canUndo false', async () => {
    upsertDraft(getDb(), convId, 'pre');
    const started = Date.now();
    expect(beginProcessing(getDb(), convId, 'enhancing', 'job-1', { stashPreText: true })).toBe(true);
    const res = await getDraftHttp();
    expect(res.status).toBe(200);
    const body = await res.json() as {
      text: string;
      processing: string;
      processingStartedAt: number | null;
      canUndo: boolean;
    };
    expect(body.text).toBe('pre');
    expect(body.processing).toBe('enhancing');
    // Undo is only offered after a successful enhance, never during the lock.
    expect(body.canUndo).toBe(false);
    expect(body.processingStartedAt).toEqual(expect.any(Number));
    expect(Math.abs((body.processingStartedAt ?? 0) - started)).toBeLessThan(2000);
  });

  it('GET /draft while a stale lock is held reports idle', async () => {
    upsertDraft(getDb(), convId, 'pre');
    beginProcessing(getDb(), convId, 'enhancing', 'job-1');
    getDb().prepare('UPDATE draft_prompts SET processing_started_at = ? WHERE conversation_id = ?')
      .run(Date.now() - PROCESSING_STALE_MS - 1, convId);
    const res = await getDraftHttp();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processing: 'idle', processingStartedAt: null });
  });

  it('PUT /draft while locked returns 409 and leaves text unchanged', async () => {
    upsertDraft(getDb(), convId, 'original');
    beginProcessing(getDb(), convId, 'enhancing', 'job-1');
    const res = await putDraft({ text: 'clobber' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'draft busy', processing: 'enhancing' });
    expect(getDraft(getDb(), convId)?.text).toBe('original');
  });

  it('POST /draft (beacon) while locked returns 409', async () => {
    upsertDraft(getDb(), convId, 'original');
    beginProcessing(getDb(), convId, 'enhancing', 'job-1');
    const res = await postDraft({ text: 'beacon' });
    expect(res.status).toBe(409);
    expect(getDraft(getDb(), convId)?.text).toBe('original');
  });

  it('DELETE /draft while locked returns 409', async () => {
    upsertDraft(getDb(), convId, 'original');
    beginProcessing(getDb(), convId, 'transcribing', 'job-1');
    const res = await delDraft();
    expect(res.status).toBe(409);
    expect(getDraft(getDb(), convId)?.text).toBe('original');
  });

  it('idle PUT broadcast carries processing idle', async () => {
    frames.length = 0;
    const res = await putDraft({ text: 'hello' });
    expect(res.status).toBe(200);
    expect(frames[0]).toMatchObject({
      type: 'draft_updated',
      processing: 'idle',
      processingStartedAt: null,
      canUndo: false,
      text: 'hello',
    });
  });

  it('POST /draft/undo-enhance with a stash restores text', async () => {
    upsertDraft(getDb(), convId, 'original');
    beginProcessing(getDb(), convId, 'enhancing', 'job-1', { stashPreText: true });
    endProcessing(getDb(), convId, 'job-1', { text: 'enhanced' });
    frames.length = 0;
    const res = await undoEnhance();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: 'original' });
    expect(getDraft(getDb(), convId)?.text).toBe('original');
    expect(getDraft(getDb(), convId)?.preText).toBeNull();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'draft_updated',
      text: 'original',
      processing: 'idle',
      canUndo: false,
    });
  });

  it('POST /draft/undo-enhance with no stash returns 409', async () => {
    upsertDraft(getDb(), convId, 'plain');
    const res = await undoEnhance();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'nothing to undo' });
  });

  it('POST /draft/undo-enhance while locked returns 409 draft busy', async () => {
    upsertDraft(getDb(), convId, 'original');
    beginProcessing(getDb(), convId, 'enhancing', 'job-1', { stashPreText: true });
    const res = await undoEnhance();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'draft busy', processing: 'enhancing' });
  });
});

describe('draft routes — Remote Agents profile lock', () => {
  const BOT_1 = '11111111-2222-4333-8444-555555555555';
  const BOT_2 = '99999999-8888-4777-8666-555555555555';
  let remoteConvId: string;

  beforeEach(() => {
    const db = getDb();
    seedCatalogue(db);
    ensureRemoteAgentsProject(db);
    upsertDiscoveredModels(db, 'grok-bot', [
      { name: BOT_1, label: 'Bot 1', provider: 'xai', vision: false, steer: true },
      { name: BOT_2, label: 'Bot 2', provider: 'xai', vision: false, steer: true },
    ]);
    remoteConvId = createRemoteAgentConversation(db, BOT_1, 'Bot 1 Conversation');
  });

  it('rejects grok-bot:default with 400', async () => {
    const res = await fetch(`${base}/conversations/${remoteConvId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'grok-bot:default' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('grok-bot:default');
  });

  it('rejects non-grok model with 400', async () => {
    const res = await fetch(`${base}/conversations/${remoteConvId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'claude-code:claude-opus-5' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('must be grok-bot:<botId>');
  });

  it('rejects mismatching botId with 400', async () => {
    const res = await fetch(`${base}/conversations/${remoteConvId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: `grok-bot:${BOT_2}` }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain(`permanently bound to grok-bot:${BOT_1}`);
  });

  it('accepts matching bot profile', async () => {
    const res = await fetch(`${base}/conversations/${remoteConvId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello bot', profileId: `grok-bot:${BOT_1}` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { profileId: string };
    expect(body.profileId).toBe(`grok-bot:${BOT_1}`);
  });
});

