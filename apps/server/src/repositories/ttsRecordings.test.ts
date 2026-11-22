import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue, seedDefaultSettings } from '../db/seed.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import {
  deleteTtsRecording,
  failTtsRecordingJob,
  finishTtsRecordingJob,
  getTtsRecording,
  insertTtsRecording,
  listTtsRecordings,
  listTtsRecordingsForProject,
  listTtsRecordingsForTree,
  readTtsRecordingAudio,
  reapEphemeralTtsRecordings,
  reconcileStaleTtsJobs,
  setTtsRecordingsRoot,
  startTtsRecordingJob,
} from './ttsRecordings.js';

function boot() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  seedDefaultSettings(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  const c2 = createConversation(db, { projectId: p.id, title: 'C2' });
  return { db, projectId: p.id, conversationId: c.id, otherId: c2.id };
}

describe('ttsRecordings repository', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tierwyn-tts-rec-'));
    setTtsRecordingsRoot(dir);
  });

  afterEach(() => {
    setTtsRecordingsRoot(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts row + wav and lists newest-first scoped to conversation', () => {
    const { db, conversationId, otherId } = boot();
    const a = insertTtsRecording(db, {
      conversationId,
      provider: 'piper',
      voice: 'en_US-lessac-medium',
      spokenText: 'first hello',
      source: 'message',
      mode: 'as-is',
      buf: Buffer.from('RIFF-wav-a'),
    });
    // ensure distinct created_at for ordering
    const b = insertTtsRecording(db, {
      conversationId,
      provider: 'kokoro',
      voice: 'af_heart',
      spokenText: 'second hello',
      source: 'file',
      mode: 'summarize',
      buf: Buffer.from('RIFF-wav-b'),
    });
    insertTtsRecording(db, {
      conversationId: otherId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'other conv',
      buf: Buffer.from('other'),
    });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.project_id).toBeTruthy();
    expect(a!.conversation_id).toBe(conversationId);
    const list = listTtsRecordings(db, conversationId);
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.id)).toEqual([b!.id, a!.id]);
    expect(list[0]!.provider).toBe('kokoro');
    expect(list[0]!.mode).toBe('summarize');
    expect(list[1]!.source).toBe('message');

    const wavPath = join(dir, `${a!.id}.wav`);
    expect(existsSync(wavPath)).toBe(true);
    expect(readFileSync(wavPath).toString()).toBe('RIFF-wav-a');
    expect(readTtsRecordingAudio(a!)?.toString()).toBe('RIFF-wav-a');
  });

  it('insert with projectId only → project_id set, conversation_id null', () => {
    const { db, projectId } = boot();
    const row = insertTtsRecording(db, {
      projectId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'schedule file',
      source: 'file',
      buf: Buffer.from('proj-only'),
    });
    expect(row).not.toBeNull();
    expect(row!.project_id).toBe(projectId);
    expect(row!.conversation_id).toBeNull();
    expect(existsSync(join(dir, `${row!.id}.wav`))).toBe(true);
  });

  it('insert with conversationId only → project_id resolved from conversation', () => {
    const { db, projectId, conversationId } = boot();
    const row = insertTtsRecording(db, {
      conversationId,
      provider: 'kokoro',
      voice: 'af_heart',
      spokenText: 'chat only',
      buf: Buffer.from('chat'),
    });
    expect(row).not.toBeNull();
    expect(row!.project_id).toBe(projectId);
    expect(row!.conversation_id).toBe(conversationId);
  });

  it('mismatched conversation/project pair → null, no file written', () => {
    const { db, conversationId } = boot();
    const other = createProject(db, { name: 'Other', rootPath: '/o' });
    const before = listTtsRecordingsForProject(db, other.id);
    const row = insertTtsRecording(db, {
      conversationId,
      projectId: other.id,
      provider: 'piper',
      voice: 'v',
      spokenText: 'mismatch',
      buf: Buffer.from('nope'),
    });
    expect(row).toBeNull();
    expect(listTtsRecordingsForProject(db, other.id)).toEqual(before);
  });

  it('returns null when conversation does not exist', () => {
    const { db } = boot();
    const row = insertTtsRecording(db, {
      conversationId: 'no-such-conv',
      provider: 'piper',
      voice: 'v',
      spokenText: 'x',
      buf: Buffer.from('x'),
    });
    expect(row).toBeNull();
  });

  it('returns null when project does not exist', () => {
    const { db } = boot();
    const row = insertTtsRecording(db, {
      projectId: 'no-such-project',
      provider: 'piper',
      voice: 'v',
      spokenText: 'x',
      buf: Buffer.from('x'),
    });
    expect(row).toBeNull();
  });

  it('listTtsRecordingsForProject returns chat + project-only, newest first', () => {
    const { db, projectId, conversationId } = boot();
    const chat = insertTtsRecording(db, {
      conversationId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'chat row',
      buf: Buffer.from('a'),
    })!;
    const projOnly = insertTtsRecording(db, {
      projectId,
      provider: 'kokoro',
      voice: 'af_heart',
      spokenText: 'project row',
      source: 'file',
      buf: Buffer.from('b'),
    })!;
    const list = listTtsRecordingsForProject(db, projectId);
    expect(list.map((r) => r.id)).toEqual([projOnly.id, chat.id]);
    expect(list.find((r) => r.id === projOnly.id)!.conversation_id).toBeNull();
  });

  it('listTtsRecordings(conversationId) excludes project-only rows', () => {
    const { db, projectId, conversationId } = boot();
    insertTtsRecording(db, {
      conversationId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'chat',
      buf: Buffer.from('a'),
    });
    insertTtsRecording(db, {
      projectId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'project only',
      buf: Buffer.from('b'),
    });
    const list = listTtsRecordings(db, conversationId);
    expect(list).toHaveLength(1);
    expect(list[0]!.spoken_text).toBe('chat');
  });

  it('delete removes row and file', () => {
    const { db, conversationId } = boot();
    const row = insertTtsRecording(db, {
      conversationId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'bye',
      buf: Buffer.from('wav'),
    })!;
    const abs = join(dir, `${row.id}.wav`);
    expect(existsSync(abs)).toBe(true);
    expect(deleteTtsRecording(db, row.id)).toBe(true);
    expect(getTtsRecording(db, row.id)).toBeUndefined();
    expect(existsSync(abs)).toBe(false);
    expect(deleteTtsRecording(db, row.id)).toBe(false);
  });

  it('start → finish job lifecycle writes wav and status done', () => {
    const { db, conversationId } = boot();
    const started = startTtsRecordingJob(db, {
      conversationId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'source text',
      mode: 'summarize',
      ephemeral: false,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.recording.status).toBe('running');
    expect(started.recording.path).toBe('');
    expect(existsSync(join(dir, `${started.recording.id}.wav`))).toBe(false);

    finishTtsRecordingJob(db, started.recording.id, Buffer.from('RIFF-done'), 'spoken final');
    const row = getTtsRecording(db, started.recording.id)!;
    expect(row.status).toBe('done');
    expect(row.spoken_text).toBe('spoken final');
    expect(row.bytes).toBeGreaterThan(0);
    expect(readTtsRecordingAudio(row)?.toString()).toBe('RIFF-done');
  });

  it('failTtsRecordingJob sets error terminal state', () => {
    const { db, conversationId } = boot();
    const started = startTtsRecordingJob(db, {
      conversationId,
      provider: 'kokoro',
      voice: 'af_heart',
      spokenText: 'x',
      ephemeral: false,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    failTtsRecordingJob(db, started.recording.id, 'sidecar returned 502');
    const row = getTtsRecording(db, started.recording.id)!;
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/502/);
    expect(existsSync(join(dir, `${row.id}.wav`))).toBe(false);
  });

  it('reconcileStaleTtsJobs flips running → error', () => {
    const { db, conversationId } = boot();
    const started = startTtsRecordingJob(db, {
      conversationId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'orphan',
      ephemeral: false,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(reconcileStaleTtsJobs(db)).toBe(1);
    const row = getTtsRecording(db, started.recording.id)!;
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/interrupted/i);
  });

  it('reapEphemeralTtsRecordings removes old ephemeral rows + files', () => {
    const { db, conversationId, projectId } = boot();
    const eph = insertTtsRecording(db, {
      conversationId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'ephemeral',
      buf: Buffer.from('eph'),
      ephemeral: true,
    })!;
    const keep = insertTtsRecording(db, {
      conversationId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'keep',
      buf: Buffer.from('keep'),
      ephemeral: false,
    })!;
    // Force updated_at into the past
    db.prepare('UPDATE tts_recordings SET updated_at = ? WHERE id = ?').run(Date.now() - 20 * 60_000, eph.id);

    expect(listTtsRecordings(db, conversationId).map((r) => r.id)).toEqual([keep.id]);
    expect(getTtsRecording(db, eph.id)).toBeTruthy();

    expect(reapEphemeralTtsRecordings(db, 10 * 60_000)).toBe(1);
    expect(getTtsRecording(db, eph.id)).toBeUndefined();
    expect(existsSync(join(dir, `${eph.id}.wav`))).toBe(false);
    expect(getTtsRecording(db, keep.id)).toBeTruthy();
    expect(listTtsRecordingsForProject(db, projectId).map((r) => r.id)).toEqual([keep.id]);
  });

  it('list queries exclude ephemeral but include running/error', () => {
    const { db, conversationId } = boot();
    const running = startTtsRecordingJob(db, {
      conversationId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'run',
      ephemeral: false,
    });
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    failTtsRecordingJob(db, running.recording.id, 'boom');
    insertTtsRecording(db, {
      conversationId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'hidden',
      buf: Buffer.from('h'),
      ephemeral: true,
    });
    const list = listTtsRecordings(db, conversationId);
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('error');
    expect(listTtsRecordingsForTree(db, conversationId)).toHaveLength(1);
  });

  it('concurrency cap at start', () => {
    const { db, projectId } = boot();
    for (let i = 0; i < 4; i++) {
      const r = startTtsRecordingJob(db, {
        projectId,
        provider: 'piper',
        voice: 'v',
        spokenText: `j${i}`,
        ephemeral: false,
      });
      expect(r.ok).toBe(true);
    }
    const fifth = startTtsRecordingJob(db, {
      projectId,
      provider: 'piper',
      voice: 'v',
      spokenText: 'j4',
      ephemeral: false,
    });
    expect(fifth).toEqual({ ok: false, error: 'concurrency' });
  });
});
