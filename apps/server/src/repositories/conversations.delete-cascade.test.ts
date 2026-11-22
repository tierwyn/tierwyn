import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from './projects.js';
import { createConversation, getConversation, deleteConversation } from './conversations.js';
import { createJob, listRunsForJob, createRun, getJob, hardDeleteJob } from './schedules.js';
import { insertTtsRecording, listTtsRecordings, setTtsRecordingsRoot } from './ttsRecordings.js';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let db: Database;
let projectId: string;
let ttsDir: string;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, migrations);
  projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
  ttsDir = mkdtempSync(join(tmpdir(), 'tierwyn-tts-'));
  setTtsRecordingsDir(ttsDir);
});

// match export name
function setTtsRecordingsDir(dir: string) {
  setTtsRecordingsRoot(dir);
}

describe('deleteConversation cascade', () => {
  it('deletes spawn children and TTS rows/files; nulls schedule_runs.conversation_id', () => {
    const parent = createConversation(db, { projectId, title: 'run parent' });
    const child = createConversation(db, {
      projectId, title: 'spawn child', parentConversationId: parent.id,
    });
    const grand = createConversation(db, {
      projectId, title: 'grand', parentConversationId: child.id,
    });

    const rec = insertTtsRecording(db, {
      conversationId: child.id,
      source: 'message',
      mode: 'as-is',
      provider: 'piper',
      voice: 'en',
      title: 't',
      spokenText: 'hi',
      buf: Buffer.from('RIFF....WAVEfmt '),
    });
    expect(rec).not.toBeNull();
    const wavPath = join(ttsDir, `${rec!.id}.wav`);
    expect(existsSync(wavPath)).toBe(true);

    const home = createConversation(db, { projectId, title: 'home', kind: 'schedule_home' });
    const job = createJob(db, {
      projectId,
      name: 'j',
      timezone: 'UTC',
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8',
      homeConversationId: home.id,
      promptTemplate: 'x',
      nextFireAt: Date.now() + 99999,
    });
    createRun(db, {
      jobId: job.id,
      conversationId: parent.id,
      status: 'succeeded',
      firedAt: Date.now(),
    });

    const result = deleteConversation(db, parent.id);
    expect(result.ok).toBe(true);
    expect(result.deletedIds).toEqual(expect.arrayContaining([parent.id, child.id, grand.id]));
    expect(getConversation(db, parent.id)).toBeUndefined();
    expect(getConversation(db, child.id)).toBeUndefined();
    expect(getConversation(db, grand.id)).toBeUndefined();
    expect(listTtsRecordings(db, child.id)).toHaveLength(0);
    expect(listRunsForJob(db, job.id)[0]?.conversationId).toBeUndefined();

    // Caller unlinks WAVs after commit
    for (const p of result.ttsWavPaths) {
      try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ }
    }
    expect(existsSync(wavPath)).toBe(false);
  });

  it('drops a still-running schedule run whose conversation is deleted (no orphan error)', () => {
    const projectId = createProject(db, { name: 'p', rootPath: '/tmp/p' }).id;
    const home = createConversation(db, { projectId, title: 'home', kind: 'schedule_home' });
    const runConv = createConversation(db, { projectId, title: 'tick', parentConversationId: home.id });
    const job = createJob(db, {
      projectId, name: 'j', timezone: 'UTC', scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }), profileId: 'claude-code:opus-4.8',
      homeConversationId: home.id, promptTemplate: 'x', nextFireAt: Date.now() + 99999,
    });
    createRun(db, { jobId: job.id, conversationId: runConv.id, status: 'running', firedAt: Date.now() });

    deleteConversation(db, runConv.id);
    expect(listRunsForJob(db, job.id)).toHaveLength(0);
  });

  it('project-only recording survives conversation delete and WAV is not unlinked', () => {
    const chat = createConversation(db, { projectId, title: 'chat' });
    const projOnly = insertTtsRecording(db, {
      projectId,
      source: 'file',
      mode: 'as-is',
      provider: 'piper',
      voice: 'en',
      title: 'schedule speak',
      spokenText: 'from schedule',
      buf: Buffer.from('RIFF....WAVEfmt '),
    });
    expect(projOnly).not.toBeNull();
    expect(projOnly!.conversation_id).toBeNull();
    const wavPath = join(ttsDir, `${projOnly!.id}.wav`);
    expect(existsSync(wavPath)).toBe(true);

    const chatRec = insertTtsRecording(db, {
      conversationId: chat.id,
      source: 'message',
      mode: 'as-is',
      provider: 'piper',
      voice: 'en',
      spokenText: 'chat speak',
      buf: Buffer.from('RIFF....WAVEfmt '),
    })!;

    const result = deleteConversation(db, chat.id);
    expect(result.ok).toBe(true);
    expect(result.ttsWavPaths).toContain(join(ttsDir, `${chatRec.id}.wav`));
    expect(result.ttsWavPaths).not.toContain(wavPath);

    const still = db.prepare('SELECT id, conversation_id FROM tts_recordings WHERE id = ?')
      .get(projOnly!.id) as { id: string; conversation_id: string | null };
    expect(still).toBeDefined();
    expect(still.conversation_id).toBeNull();
    expect(existsSync(wavPath)).toBe(true);
  });
});

describe('hardDeleteJob', () => {
  it('removes job, home, and run conversation trees', () => {
    const home = createConversation(db, { projectId, title: '⏱ home', kind: 'schedule_home' });
    const job = createJob(db, {
      projectId,
      name: 'nightly',
      timezone: 'UTC',
      scheduleKind: 'interval',
      scheduleExpr: JSON.stringify({ everyMs: 60_000 }),
      profileId: 'claude-code:opus-4.8',
      homeConversationId: home.id,
      promptTemplate: 'x',
      nextFireAt: Date.now() + 99999,
      steps: [{ title: 'S1', body: 'do' }],
    });
    const runConv = createConversation(db, {
      projectId, title: 'tick', parentConversationId: home.id,
    });
    const child = createConversation(db, {
      projectId, title: 'kid', parentConversationId: runConv.id,
    });
    createRun(db, {
      jobId: job.id, conversationId: runConv.id, status: 'succeeded', firedAt: Date.now(),
    });

    const r = hardDeleteJob(db, job.id);
    expect(r.ok).toBe(true);
    expect(getJob(db, job.id)).toBeUndefined();
    expect(getConversation(db, home.id)).toBeUndefined();
    expect(getConversation(db, runConv.id)).toBeUndefined();
    expect(getConversation(db, child.id)).toBeUndefined();
  });
});
