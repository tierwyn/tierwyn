import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject, deleteProject, getProject } from './projects.js';
import { createConversation, getConversation } from './conversations.js';
import {
  insertTtsRecording,
  listTtsRecordingsForProject,
  setTtsRecordingsRoot,
  unlinkTtsWavPaths,
} from './ttsRecordings.js';

describe('deleteProject TTS cleanup', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tierwyn-proj-del-'));
    setTtsRecordingsRoot(dir);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    seedCatalogue(db);
    seedDefaultSettings(db);
  });

  afterEach(() => {
    setTtsRecordingsRoot(null);
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  it('removes chat-scoped and project-only recordings and returns WAV paths', () => {
    const proj = createProject(db, { name: 'Del', rootPath: '/del' });
    const chat = createConversation(db, { projectId: proj.id, title: 'c1' });

    const chatRec = insertTtsRecording(db, {
      conversationId: chat.id,
      provider: 'piper',
      voice: 'v',
      spokenText: 'chat',
      buf: Buffer.from('chat-wav'),
    })!;
    const projRec = insertTtsRecording(db, {
      projectId: proj.id,
      provider: 'kokoro',
      voice: 'af_heart',
      spokenText: 'project only',
      source: 'file',
      buf: Buffer.from('proj-wav'),
    })!;

    const chatWav = join(dir, `${chatRec.id}.wav`);
    const projWav = join(dir, `${projRec.id}.wav`);
    expect(existsSync(chatWav)).toBe(true);
    expect(existsSync(projWav)).toBe(true);
    expect(listTtsRecordingsForProject(db, proj.id)).toHaveLength(2);

    const result = deleteProject(db, proj.id);
    expect(result.ok).toBe(true);
    expect(result.ttsWavPaths).toEqual(expect.arrayContaining([chatWav, projWav]));
    expect(getProject(db, proj.id)).toBeUndefined();
    expect(getConversation(db, chat.id)).toBeUndefined();
    expect(listTtsRecordingsForProject(db, proj.id)).toHaveLength(0);

    unlinkTtsWavPaths(result.ttsWavPaths);
    expect(existsSync(chatWav)).toBe(false);
    expect(existsSync(projWav)).toBe(false);
  });
});

describe('deleteProject with schedules', () => {
  it('removes jobs, runs, steps, spawn edges and every conversation without an FK throw', async () => {
    const { createJob, createRun, getJob } = await import('./schedules.js');
    const { createSpawnEdge } = await import('./spawnEdges.js');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const proj = createProject(db, { name: 'S', rootPath: '/s' });
    const home = createConversation(db, { projectId: proj.id, title: 'home', kind: 'schedule_home' });
    const bound = createConversation(db, { projectId: proj.id, title: 'bound' });
    const run = createConversation(db, { projectId: proj.id, title: 'run', parentConversationId: home.id });
    createSpawnEdge(db, { parentConversationId: home.id, childConversationId: run.id, notifyParent: true });
    const job = createJob(db, {
      projectId: proj.id, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 3_600_000 }), profileId: 'claude-code:x',
      homeConversationId: home.id, boundConversationId: bound.id, promptTemplate: 'x', nextFireAt: 0,
      steps: [{ title: 's', body: 'b' }],
    });
    createRun(db, { jobId: job.id, conversationId: run.id, status: 'succeeded', firedAt: 1 });

    expect(() => deleteProject(db, proj.id)).not.toThrow();
    expect(getProject(db, proj.id)).toBeUndefined();
    expect(getJob(db, job.id)).toBeUndefined();
    for (const c of [home, bound, run]) expect(getConversation(db, c.id)).toBeUndefined();
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([n('schedule_runs'), n('schedule_steps'), n('spawn_edges')]).toEqual([0, 0, 0]);
    db.close();
  });
});
