import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue } from '../db/seed.js';
import { createProject } from './projects.js';
import { createConversation } from './conversations.js';
import { createSession } from './sessions.js';
import {
  appendEvent,
  listEventsForConversation,
  listEventsForConversationPage,
} from './events.js';
import zlib from 'node:zlib';
import type { TranscriptResponse } from '@tierwyn/shared';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedCatalogue(db);
  const p = createProject(db, { name: 'P', rootPath: '/p' });
  const c = createConversation(db, { projectId: p.id, title: 'C' });
  createSession(db, { id: 's1', conversationId: c.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
  createSession(db, { id: 's2', conversationId: c.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
  createSession(db, { id: 's3', conversationId: c.id, agentId: 'claude-code', agentModelId: 'claude-code:opus-4.8' });
  return { db, conversationId: c.id };
}

describe('listEventsForConversationPage', () => {
  it('returns all events and hasMore: false when tailTurns exceeds prompt count', () => {
    const { db, conversationId } = setup();
    appendEvent(db, { sessionId: 's1', type: 'system', payload: { init: true }, sender: 'system', ts: 10, seq: 0 });
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'p1' }, sender: 'user', ts: 20, seq: 0 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'm1' }, sender: 'agent', ts: 30, seq: 0 });

    const full = listEventsForConversation(db, conversationId);
    const paged = listEventsForConversationPage(db, conversationId, { tailTurns: 10 });
    expect(paged.hasMore).toBe(false);
    expect(paged.events).toEqual(full);
  });

  it('handles empty conversation correctly', () => {
    const { db, conversationId } = setup();
    const paged = listEventsForConversationPage(db, conversationId, { tailTurns: 5 });
    expect(paged.hasMore).toBe(false);
    expect(paged.events).toEqual([]);
    expect(paged.cursor).toBeUndefined();
  });

  it('walks pages with before=cursor reproducing listEventsForConversation exactly with ties and pre-prompt events', () => {
    const { db, conversationId } = setup();

    // 1. Orphan pre-prompt events in s1
    appendEvent(db, { sessionId: 's1', type: 'system', payload: { note: 'pre1' }, sender: 'system', ts: 100, seq: 0 });
    appendEvent(db, { sessionId: 's1', type: 'system', payload: { note: 'pre2' }, sender: 'system', ts: 105, seq: 1 });

    // Turn 1 in s1
    appendEvent(db, { sessionId: 's1', type: 'prompt', payload: { text: 'p1' }, sender: 'user', ts: 200, seq: 0 });
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'm1' }, sender: 'agent', ts: 210, seq: 1 });

    // Turn 2 in s2 with cross-session tie on ts and seq
    // In s1 and s2: identical ts=300 and seq=0
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: 'tie-s1' }, sender: 'agent', ts: 300, seq: 0 });
    appendEvent(db, { sessionId: 's2', type: 'prompt', payload: { text: 'p2-tie-s2' }, sender: 'user', ts: 300, seq: 0 });
    appendEvent(db, { sessionId: 's2', type: 'message', payload: { chunk: 'm2' }, sender: 'agent', ts: 310, seq: 1 });

    // Turn 3 in s2
    appendEvent(db, { sessionId: 's2', type: 'prompt', payload: { text: 'p3' }, sender: 'user', ts: 400, seq: 0 });
    appendEvent(db, { sessionId: 's2', type: 'message', payload: { chunk: 'm3' }, sender: 'agent', ts: 410, seq: 1 });

    // Turn 4 in s3
    appendEvent(db, { sessionId: 's3', type: 'prompt', payload: { text: 'p4' }, sender: 'user', ts: 500, seq: 0 });
    appendEvent(db, { sessionId: 's3', type: 'message', payload: { chunk: 'm4' }, sender: 'agent', ts: 510, seq: 1 });

    // Turn 5 in s3
    appendEvent(db, { sessionId: 's3', type: 'prompt', payload: { text: 'p5' }, sender: 'user', ts: 600, seq: 0 });
    appendEvent(db, { sessionId: 's3', type: 'message', payload: { chunk: 'm5' }, sender: 'agent', ts: 610, seq: 1 });

    const fullEvents = listEventsForConversation(db, conversationId);
    expect(fullEvents.length).toBe(13);

    // Walk pages with tailTurns=2
    const collectedReversePages: any[][] = [];
    let before: string | undefined = undefined;
    let pageCount = 0;

    while (true) {
      pageCount++;
      if (pageCount > 10) throw new Error('Too many pages, possible infinite loop');
      const page = listEventsForConversationPage(db, conversationId, { tailTurns: 2, before });
      collectedReversePages.push(page.events);
      if (!page.hasMore) {
        break;
      }
      expect(page.cursor).toBeDefined();
      before = page.cursor;
    }

    // Since we walk from latest to oldest, unrolling pages in chronological order:
    // page 0 (latest), page 1 (middle), page 2 (oldest)
    // Concat in chronological order: oldest to newest
    const walkedEvents: any[] = [];
    for (let i = collectedReversePages.length - 1; i >= 0; i--) {
      walkedEvents.push(...collectedReversePages[i]);
    }

    expect(walkedEvents.map(e => e.id)).toEqual(fullEvents.map(e => e.id));
    expect(walkedEvents).toEqual(fullEvents);
  });
});

describe('GET /conversations/:id/transcript endpoint', () => {
  function makeApp(db: Database) {
    const app = express();
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
    return app;
  }

  function fetchRoute(app: express.Express, path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; buffer: Buffer }>((resolve, reject) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as { port: number };
        import('node:http').then(({ request }) => {
          const req = request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'GET',
            headers,
          }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(Buffer.from(c)));
            res.on('end', () => {
              server.close();
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                buffer: Buffer.concat(chunks),
              });
            });
          });
          req.on('error', (e) => {
            server.close();
            reject(e);
          });
          req.end();
        });
      });
    });
  }

  it('validates tailTurns and before returning 400 on malformed input', async () => {
    const { db, conversationId } = setup();
    const app = makeApp(db);

    const r1 = await fetchRoute(app, `/conversations/${conversationId}/transcript?tailTurns=abc`);
    expect(r1.status).toBe(400);

    const r2 = await fetchRoute(app, `/conversations/${conversationId}/transcript?tailTurns=0`);
    expect(r2.status).toBe(400);

    const r3 = await fetchRoute(app, `/conversations/${conversationId}/transcript?tailTurns=-5`);
    expect(r3.status).toBe(400);

    const r4 = await fetchRoute(app, `/conversations/${conversationId}/transcript?tailTurns=5&before=bogus`);
    expect(r4.status).toBe(400);
  });

  it('gzips body when Accept-Encoding contains gzip and body > 64KB', async () => {
    const { db, conversationId } = setup();
    // Add large payload to exceed 64KB
    const largeChunk = 'x'.repeat(70 * 1024);
    appendEvent(db, { sessionId: 's1', type: 'message', payload: { chunk: largeChunk }, sender: 'agent', ts: 10, seq: 0 });

    const app = makeApp(db);

    // Without gzip header
    const rNoGzip = await fetchRoute(app, `/conversations/${conversationId}/transcript`);
    expect(rNoGzip.status).toBe(200);
    expect(rNoGzip.headers['content-encoding']).toBeUndefined();
    expect(rNoGzip.headers['vary']).toBe('Accept-Encoding');
    const json = JSON.parse(rNoGzip.buffer.toString('utf-8'));
    expect(json.events).toHaveLength(1);

    // With gzip header
    const rGzip = await fetchRoute(app, `/conversations/${conversationId}/transcript`, {
      'Accept-Encoding': 'gzip, deflate',
    });
    expect(rGzip.status).toBe(200);
    expect(rGzip.headers['content-encoding']).toBe('gzip');
    expect(rGzip.headers['vary']).toBe('Accept-Encoding');
    expect(rGzip.headers['content-type']).toContain('application/json');

    // Decompress and verify content
    const decompressed = zlib.gunzipSync(rGzip.buffer);
    const parsed = JSON.parse(decompressed.toString('utf-8'));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].payload.chunk).toBe(largeChunk);
  });
});
