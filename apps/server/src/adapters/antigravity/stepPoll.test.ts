import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import {
  ConversationStepPoller,
  findNewestConversationSince,
  parseAgyToolStep,
} from './stepPoll.js';

describe('parseAgyToolStep', () => {
  it('extracts toolAction from a list_dir step payload', () => {
    const payload = Buffer.from(
      'list_dir {"DirectoryPath":"/tmp/proj","toolAction":"Listing project root directory","toolSummary":"List project root"}',
      'utf8',
    );
    expect(parseAgyToolStep(payload)).toBe('Listing project root directory\n');
  });

  it('extracts toolAction from a replace_file_content payload', () => {
    const payload = Buffer.from(
      'replace_file_content {"TargetFile":"/tmp/a.md","toolAction":"Adding test comment to README.md","toolSummary":"Edit README.md"}',
      'utf8',
    );
    expect(parseAgyToolStep(payload)).toBe('Adding test comment to README.md\n');
  });

  it('returns null when no tool JSON is present', () => {
    expect(parseAgyToolStep(Buffer.from('no tools here', 'utf8'))).toBeNull();
  });
});

function seedConversationDb(dir: string, id: string): string {
  const dbPath = path.join(dir, `${id}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY,
      step_type INTEGER,
      status INTEGER,
      has_subtrajectory INTEGER,
      metadata BLOB,
      error_details BLOB,
      permissions BLOB,
      task_details BLOB,
      render_info BLOB,
      step_payload BLOB,
      step_format INTEGER
    );
  `);
  db.close();
  return dbPath;
}

describe('findNewestConversationSince', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tierwyn-agy-find-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the newest db at/after spawnTime', () => {
    const since = Date.now();
    const oldId = '11111111-1111-1111-1111-111111111111';
    const newId = '22222222-2222-2222-2222-222222222222';
    seedConversationDb(dir, oldId);
    seedConversationDb(dir, newId);
    const oldTime = new Date(since - 60_000);
    utimesSync(path.join(dir, `${oldId}.db`), oldTime, oldTime);
    expect(findNewestConversationSince(dir, since)).toBe(newId);
  });
});

describe('ConversationStepPoller', () => {
  let dir: string;
  const convId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tierwyn-agy-poll-'));
    seedConversationDb(dir, convId);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits tool-action lines as new steps appear in the conversation db', async () => {
    const emitted: string[] = [];
    const poller = new ConversationStepPoller({
      conversationsDir: dir,
      conversationId: convId,
      spawnTime: Date.now(),
      resumeTurn: false,
      emit: (evt) => {
        if (evt.type === 'message') emitted.push(evt.payload.chunk);
      },
      pollMs: 50,
    });
    poller.start();

    const db = new Database(path.join(dir, `${convId}.db`));
    db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?,?,?)').run(
      0, 9,
      Buffer.from('list_dir {"toolAction":"Listing project root directory"}', 'utf8'),
    );
    db.close();

    await new Promise((r) => setTimeout(r, 120));
    poller.stop();

    expect(emitted).toEqual(['Listing project root directory\n']);
  });

  it('discovers a fresh conversation db by spawnTime when id is unknown', async () => {
    const spawnTime = Date.now();
    const emitted: string[] = [];
    const poller = new ConversationStepPoller({
      conversationsDir: dir,
      conversationId: null,
      spawnTime,
      resumeTurn: false,
      emit: (evt) => {
        if (evt.type === 'message') emitted.push(evt.payload.chunk);
      },
      pollMs: 50,
    });
    poller.start();

    const db = new Database(path.join(dir, `${convId}.db`));
    db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?,?,?)').run(
      0, 8,
      Buffer.from('view_file {"toolAction":"Viewing README.md"}', 'utf8'),
    );
    db.close();

    await new Promise((r) => setTimeout(r, 120));
    poller.stop();

    expect(emitted).toEqual(['Viewing README.md\n']);
  });

  it('skips steps that existed before this turn when resumeTurn is true', async () => {
    const db = new Database(path.join(dir, `${convId}.db`));
    db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?,?,?)').run(
      0, 9,
      Buffer.from('list_dir {"toolAction":"Old turn action"}', 'utf8'),
    );
    db.close();

    const emitted: string[] = [];
    const poller = new ConversationStepPoller({
      conversationsDir: dir,
      conversationId: convId,
      spawnTime: Date.now(),
      resumeTurn: true,
      resumeBaselineIdx: 0,
      emit: (evt) => {
        if (evt.type === 'message') emitted.push(evt.payload.chunk);
      },
      pollMs: 50,
    });
    poller.start();

    const db2 = new Database(path.join(dir, `${convId}.db`));
    db2.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?,?,?)').run(
      1, 8,
      Buffer.from('view_file {"toolAction":"Viewing README.md"}', 'utf8'),
    );
    db2.close();

    await new Promise((r) => setTimeout(r, 120));
    poller.stop();

    expect(emitted).toEqual(['Viewing README.md\n']);
  });
});
