import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { createProject, updateProject } from '../repositories/projects.js';
import { createConversation } from '../repositories/conversations.js';
import { createSession } from '../repositories/sessions.js';
import { appendEvent } from '../repositories/events.js';
import { updateGeneralSettings } from '../repositories/settings.js';
import { issueSpawnToken, CONVERSATION_CAPABILITIES, type TokenCapability } from '../spawn/tokens.js';
import { registerAgentSearchRoutes } from './agentSearch.js';

function memoryScope(): Set<TokenCapability> {
  return new Set<TokenCapability>([...CONVERSATION_CAPABILITIES, 'memory']);
}

const NOW = 1_800_000_000_000;
const PROFILE_ID = 'claude-code:test-model';

let db: Database.Database;
let app: express.Express;
let convA: string;
let convB: string;
let convA2: string;
let projectA: string;
let projectB: string;
let sessA: string;
let sessB: string;
let sessA2: string;
let now = NOW;
let liveToken: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  now = NOW;

  db.prepare(`INSERT INTO agents (id, type, label, created_at) VALUES ('claude-code', 'claude-code', 'Claude Code', ?)`).run(NOW);
  db.prepare(
    `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, 'claude-code', 'test-model', 'Test', 1, ?)`,
  ).run(PROFILE_ID, NOW);

  const pA = createProject(db, { name: 'Alpha', rootPath: '/tmp/a' });
  const pB = createProject(db, { name: 'Beta', rootPath: '/tmp/b' });
  projectA = pA.id;
  projectB = pB.id;
  convA = createConversation(db, { projectId: pA.id, title: 'Alpha chat' }).id;
  convA2 = createConversation(db, { projectId: pA.id, title: 'Alpha other' }).id;
  convB = createConversation(db, { projectId: pB.id, title: 'Beta chat' }).id;
  sessA = createSession(db, { id: 'sess-a', conversationId: convA, agentId: 'claude-code', agentModelId: PROFILE_ID }).id;
  sessA2 = createSession(db, { id: 'sess-a2', conversationId: convA2, agentId: 'claude-code', agentModelId: PROFILE_ID }).id;
  sessB = createSession(db, { id: 'sess-b', conversationId: convB, agentId: 'claude-code', agentModelId: PROFILE_ID }).id;

  app = express();
  app.use(express.json());
  registerAgentSearchRoutes(app, { getDb: () => db, now: () => now });
  liveToken = issueSpawnToken(convA, sessA, memoryScope());
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function get(path: string, token = liveToken): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: auth(token) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

function seedPrompt(sessionId: string, text: string, ts = NOW) {
  return appendEvent(db, { sessionId, type: 'prompt', payload: { text }, sender: 'user', ts, seq: 1 });
}

function seedMessage(sessionId: string, chunk: string, ts = NOW, seq = 2) {
  return appendEvent(db, { sessionId, type: 'message', payload: { chunk }, sender: 'agent', ts, seq });
}

describe('GET /agent/search auth and policy', () => {
  it('401 without a live bearer', async () => {
    const res = await get('/agent/search?q=marmalade', '');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/bearer/i);
  });

  it('400 when q is missing or empty', async () => {
    expect((await get('/agent/search')).status).toBe(400);
    expect((await get('/agent/search?q=')).body.error).toBe('q required');
    expect((await get('/agent/search?q=***')).body.error).toBe('q required');
  });

  it('403 agent_search_off when the setting is off', async () => {
    seedPrompt(sessA, 'marmalade parser');
    updateGeneralSettings(db, { agentSearchScope: 'off' });
    const search = await get('/agent/search?q=marmalade');
    expect(search.status).toBe(403);
    expect(search.body.error).toBe('agent_search_off');
    const ctx = await get(`/agent/conversations/${convA}/context?eventId=x`);
    expect(ctx.status).toBe(403);
    expect(ctx.body.error).toBe('agent_search_off');
  });
});

describe('GET /agent/search scoping', () => {
  beforeEach(() => {
    seedPrompt(sessA, 'marmalade in alpha');
    seedPrompt(sessA2, 'marmalade also in alpha other');
    seedPrompt(sessB, 'marmalade in beta');
  });

  it('default project scope returns only the caller project', async () => {
    const res = await get('/agent/search?q=marmalade');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('project');
    expect(res.body.hits.map((h: { conversationId: string }) => h.conversationId).sort())
      .toEqual([convA, convA2].sort());
    expect(res.body.note).toMatch(/historical transcript excerpts/);
  });

  it('scope=all is 403 when agentSearchScope is project', async () => {
    const res = await get('/agent/search?q=marmalade&scope=all');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_project_search_disabled');
  });

  it('foreign projectIds is 403 when agentSearchScope is project', async () => {
    const other = await get(`/agent/search?q=marmalade&projectIds=${projectB}`);
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('cross_project_search_disabled');
    const mixed = await get(`/agent/search?q=marmalade&projectIds=${projectA},${projectB}`);
    expect(mixed.status).toBe(403);
  });

  it('scope=all with agentSearchScope=all returns hits across projects', async () => {
    updateGeneralSettings(db, { agentSearchScope: 'all' });
    const def = await get('/agent/search?q=marmalade');
    expect(def.status).toBe(200);
    expect(def.body.scope).toBe('project');
    expect(def.body.hits.every((h: { projectId: string }) => h.projectId === projectA)).toBe(true);

    const all = await get('/agent/search?q=marmalade&scope=all');
    expect(all.status).toBe(200);
    expect(all.body.scope).toBe('all');
    expect(all.body.hits).toHaveLength(3);

    const filtered = await get(`/agent/search?q=marmalade&projectIds=${projectB}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.scope).toBe('projects');
    expect(filtered.body.hits.map((h: { conversationId: string }) => h.conversationId)).toEqual([convB]);
  });

  it('cannot combine scope=all with projectIds', async () => {
    updateGeneralSettings(db, { agentSearchScope: 'all' });
    const res = await get(`/agent/search?q=marmalade&scope=all&projectIds=${projectA}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot combine scope=all with projectIds');
  });

  it('excludeSelf drops the caller conversation', async () => {
    const res = await get('/agent/search?q=marmalade&excludeSelf=1');
    expect(res.status).toBe(200);
    expect(res.body.hits.map((h: { conversationId: string }) => h.conversationId)).toEqual([convA2]);
  });

  it('excludes schedule_home conversations', async () => {
    const home = createConversation(db, { projectId: projectA, title: '⏱ job', kind: 'schedule_home' });
    const homeSess = createSession(db, {
      id: 'sess-home', conversationId: home.id, agentId: 'claude-code', agentModelId: PROFILE_ID,
    }).id;
    seedPrompt(homeSess, 'marmalade schedule home');
    const res = await get('/agent/search?q=marmalade');
    expect(res.body.hits.some((h: { conversationId: string }) => h.conversationId === home.id)).toBe(false);
  });
});

describe('GET /agent/search snippets', () => {
  it('reconstructs a streaming turn whose final row has an empty chunk', async () => {
    appendEvent(db, { sessionId: sessA, type: 'message', payload: { chunk: 'the marma', final: false }, sender: 'agent', seq: 1, ts: NOW });
    appendEvent(db, { sessionId: sessA, type: 'message', payload: { chunk: 'lade parser is ready', final: false }, sender: 'agent', seq: 2, ts: NOW });
    const fin = appendEvent(db, { sessionId: sessA, type: 'message', payload: { chunk: '', final: true }, sender: 'agent', seq: 3, ts: NOW });
    const res = await get('/agent/search?q=marmalade');
    expect(res.status).toBe(200);
    expect(res.body.hits).toHaveLength(1);
    const match = res.body.hits[0].matches[0];
    expect(match.eventId).toBe(fin.id);
    expect(match.snippet.toLowerCase()).toContain('marmalade');
    expect(match.snippet).not.toBe('');
  });

  it('redacts a live spawn token in snippets', async () => {
    db.prepare(
      `INSERT INTO events (id, session_id, type, payload, sender, seq, ts)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('e-secret', sessA, 'prompt', JSON.stringify({ text: `secret token is ${liveToken}` }), 'user', 1, NOW);
    const rowid = (db.prepare('SELECT rowid FROM events WHERE id = ?').get('e-secret') as { rowid: number }).rowid;
    db.prepare('INSERT INTO event_fts(rowid, body) VALUES (?,?)').run(rowid, `secret token is ${liveToken}`);
    const res = await get('/agent/search?q=secret');
    expect(res.status).toBe(200);
    const snippet: string = res.body.hits[0].matches[0].snippet;
    expect(snippet).not.toContain(liveToken);
    expect(snippet).toContain('[REDACTED]');
  });

  it('redacts a live token that straddles the 240-char snippet boundary', async () => {
    // Token starts at offset 230 so slice(0, 240) would keep a cleartext prefix.
    const text = `needle ${'z'.repeat(223)}${liveToken}`;
    db.prepare(
      `INSERT INTO events (id, session_id, type, payload, sender, seq, ts)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('e-snip-bound', sessA, 'prompt', JSON.stringify({ text }), 'user', 1, NOW);
    const rowid = (db.prepare('SELECT rowid FROM events WHERE id = ?').get('e-snip-bound') as { rowid: number }).rowid;
    db.prepare('INSERT INTO event_fts(rowid, body) VALUES (?,?)').run(rowid, text);
    const res = await get('/agent/search?q=needle');
    expect(res.status).toBe(200);
    const snippet: string = res.body.hits[0].matches[0].snippet;
    expect(snippet).not.toContain(liveToken);
    expect(snippet).not.toContain(liveToken.slice(0, 8));
    expect(snippet).toContain('[REDACTED]');
  });

  it('does not return subagent_notify, recalledMemories, or heartbeat spawn markers', async () => {
    const real = seedPrompt(sessA, 'marmalade parser', NOW);
    const notify = appendEvent(db, {
      sessionId: sessA, type: 'prompt', sender: 'user', seq: 2, ts: NOW + 1,
      payload: { text: 'marmalade notify', source: 'subagent_notify' },
    });
    const recalled = appendEvent(db, {
      sessionId: sessA, type: 'message', sender: 'agent', seq: 3, ts: NOW + 2,
      payload: { chunk: 'marmalade memories', recalledMemories: ['m_1'] },
    });
    const heartbeat = appendEvent(db, {
      sessionId: sessA, type: 'message', sender: 'agent', seq: 4, ts: NOW + 3,
      payload: { chunk: 'marmalade heartbeat', spawnMarker: { kind: 'heartbeat' } },
    });
    const res = await get('/agent/search?q=marmalade');
    expect(res.status).toBe(200);
    const ids = (res.body.hits as Array<{ matches: Array<{ eventId: string }> }>)
      .flatMap((h) => h.matches.map((m) => m.eventId));
    expect(ids).toContain(real.id);
    expect(ids).not.toContain(notify.id);
    expect(ids).not.toContain(recalled.id);
    expect(ids).not.toContain(heartbeat.id);

    // Newer excluded rows must not consume matchesPerConversation slots.
    const ctxNotify = await get(`/agent/conversations/${convA}/context?eventId=${notify.id}`);
    expect(ctxNotify.status).toBe(404);
  });

  it('does not reconstruct streaming text across spawnMarker or recalledMemories', async () => {
    appendEvent(db, {
      sessionId: sessA, type: 'message', sender: 'agent', seq: 1, ts: NOW,
      payload: { chunk: 'bleedprefix ' },
    });
    appendEvent(db, {
      sessionId: sessA, type: 'message', sender: 'agent', seq: 2, ts: NOW + 1,
      payload: { chunk: 'shouldnotbleed', spawnMarker: { kind: 'spawned', text: 'child' } },
    });
    const fin = appendEvent(db, {
      sessionId: sessA, type: 'message', sender: 'agent', seq: 3, ts: NOW + 2,
      payload: { chunk: 'marmalade done', final: true },
    });
    const res = await get('/agent/search?q=marmalade');
    expect(res.status).toBe(200);
    const match = res.body.hits[0].matches.find((m: { eventId: string }) => m.eventId === fin.id)
      ?? res.body.hits[0].matches[0];
    expect(match.snippet.toLowerCase()).toContain('marmalade');
    expect(match.snippet).not.toContain('bleedprefix');
    expect(match.snippet).not.toContain('shouldnotbleed');
  });
});

describe('GET /agent/conversations/:id/context', () => {
  it('400 without eventId', async () => {
    const res = await get(`/agent/conversations/${convA}/context`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('eventId required');
  });

  it('404 for unknown conversation and schedule_home', async () => {
    expect((await get('/agent/conversations/nope/context?eventId=e1')).status).toBe(404);
    const home = createConversation(db, { projectId: projectA, title: '⏱ job', kind: 'schedule_home' });
    expect((await get(`/agent/conversations/${home.id}/context?eventId=e1`)).status).toBe(404);
  });

  it('403 cross_project_search_disabled for a foreign conversation when scope is project', async () => {
    const ev = seedPrompt(sessB, 'hello from beta');
    const res = await get(`/agent/conversations/${convB}/context?eventId=${ev.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_project_search_disabled');
  });

  it('succeeds for a foreign conversation when agentSearchScope is all', async () => {
    updateGeneralSettings(db, { agentSearchScope: 'all' });
    const ev = seedPrompt(sessB, 'hello from beta');
    const res = await get(`/agent/conversations/${convB}/context?eventId=${ev.id}`);
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe(convB);
    expect(res.body.items.some((i: { isAnchor: boolean }) => i.isAnchor)).toBe(true);
  });

  it('404 when eventId belongs to a different conversation', async () => {
    const ev = seedPrompt(sessA2, 'elsewhere');
    const res = await get(`/agent/conversations/${convA}/context?eventId=${ev.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('event not found in conversation');
  });

  it('windows around the anchor, coalesces streaming messages, and skips noise', async () => {
    const p1 = appendEvent(db, { sessionId: sessA, type: 'prompt', payload: { text: 'first' }, sender: 'user', seq: 1, ts: NOW });
    appendEvent(db, { sessionId: sessA, type: 'status', payload: { status: 'running' }, sender: 'agent', seq: 2, ts: NOW + 1 });
    appendEvent(db, { sessionId: sessA, type: 'message', payload: { chunk: 'hello ', final: false }, sender: 'agent', seq: 3, ts: NOW + 2 });
    const fin = appendEvent(db, { sessionId: sessA, type: 'message', payload: { chunk: 'world', final: true }, sender: 'agent', seq: 4, ts: NOW + 3 });
    appendEvent(db, { sessionId: sessA, type: 'prompt', payload: { text: 'notify', source: 'subagent_notify' }, sender: 'user', seq: 5, ts: NOW + 4 });
    appendEvent(db, { sessionId: sessA, type: 'message', payload: { chunk: '', recalledMemories: ['m_1'] }, sender: 'agent', seq: 6, ts: NOW + 5 });
    const p2 = appendEvent(db, { sessionId: sessA, type: 'prompt', payload: { text: 'second' }, sender: 'user', seq: 7, ts: NOW + 6 });
    appendEvent(db, {
      sessionId: sessA, type: 'tool_call', sender: 'agent', seq: 8, ts: NOW + 7,
      payload: { name: 'Bash', input: { command: 'curl -s http://127.0.0.1:8788/spawn/raw' } },
    });

    const res = await get(`/agent/conversations/${convA}/context?eventId=${fin.id}&before=2&after=2`);
    expect(res.status).toBe(200);
    expect(res.body.anchorEventId).toBe(fin.id);
    const texts = res.body.items.map((i: { text: string }) => i.text);
    expect(texts).toContain('hello world');
    expect(texts).toContain('first');
    expect(texts).toContain('second');
    expect(texts.some((t: string) => t === 'notify')).toBe(false);
    expect(res.body.items.some((i: { type: string }) => i.type === 'tool_call')).toBe(false);
    expect(res.body.items.find((i: { isAnchor: boolean }) => i.isAnchor).eventId).toBe(fin.id);
    expect(res.body.items.some((i: { eventId: string }) => i.eventId === p1.id)).toBe(true);
    expect(res.body.items.some((i: { eventId: string }) => i.eventId === p2.id)).toBe(true);
  });

  it('truncates to maxChars without dropping the anchor', async () => {
    const big = 'marmalade '.repeat(400);
    const p = appendEvent(db, { sessionId: sessA, type: 'prompt', payload: { text: big }, sender: 'user', seq: 1, ts: NOW });
    appendEvent(db, { sessionId: sessA, type: 'message', payload: { chunk: big }, sender: 'agent', seq: 2, ts: NOW + 1 });
    const res = await get(`/agent/conversations/${convA}/context?eventId=${p.id}&before=0&after=1&maxChars=500`);
    expect(res.status).toBe(200);
    const anchor = res.body.items.find((i: { isAnchor: boolean }) => i.isAnchor);
    expect(anchor).toBeTruthy();
    expect(anchor.text.length).toBeGreaterThan(0);
    expect(res.body.items.some((i: { truncated?: boolean }) => i.truncated)).toBe(true);
    const total = res.body.items.reduce((n: number, i: { text: string }) => n + i.text.length, 0);
    expect(total).toBeLessThanOrEqual(500 + '… [truncated]'.length * res.body.items.length);
  });

  it('includeTools=1 returns ordinary tools but still omits spawn-curl tool_calls', async () => {
    const p = appendEvent(db, { sessionId: sessA, type: 'prompt', payload: { text: 'read it' }, sender: 'user', seq: 1, ts: NOW });
    appendEvent(db, {
      sessionId: sessA, type: 'tool_call', sender: 'agent', seq: 2, ts: NOW + 1,
      payload: { name: 'Read', input: { file_path: '/tmp/a.ts' } },
    });
    appendEvent(db, {
      sessionId: sessA, type: 'tool_result', sender: 'agent', seq: 3, ts: NOW + 2,
      payload: { content: 'export const marmalade = 1;' },
    });
    appendEvent(db, {
      sessionId: sessA, type: 'tool_call', sender: 'agent', seq: 4, ts: NOW + 3,
      payload: { name: 'Bash', input: { command: 'curl -s http://127.0.0.1:8788/spawn/raw' } },
    });
    const res = await get(
      `/agent/conversations/${convA}/context?eventId=${p.id}&before=0&after=5&includeTools=1`,
    );
    expect(res.status).toBe(200);
    const types = res.body.items.map((i: { type: string }) => i.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(res.body.items.some((i: { text: string }) => i.text.includes('/tmp/a.ts'))).toBe(true);
    expect(res.body.items.some((i: { text: string }) => i.text.includes('export const marmalade'))).toBe(true);
    expect(res.body.items.some((i: { text: string }) => i.text.includes('/spawn'))).toBe(false);
    expect(res.body.items.some((i: { text: string }) => /\bcurl\b/.test(i.text))).toBe(false);
  });

  it('redacts a live token in /context, including across a maxChars truncation boundary', async () => {
    db.prepare(
      `INSERT INTO events (id, session_id, type, payload, sender, seq, ts)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('e-ctx-anchor', sessA, 'prompt', JSON.stringify({ text: 'needle' }), 'user', 1, NOW);
    const long = `${'z'.repeat(480)}${liveToken} tail`;
    db.prepare(
      `INSERT INTO events (id, session_id, type, payload, sender, seq, ts)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('e-ctx-bound', sessA, 'message', JSON.stringify({ chunk: long }), 'agent', 2, NOW + 1);
    const res = await get(
      `/agent/conversations/${convA}/context?eventId=e-ctx-anchor&before=0&after=1&maxChars=500`,
    );
    expect(res.status).toBe(200);
    const blob = res.body.items.map((i: { text: string }) => i.text).join('\n');
    expect(blob).not.toContain(liveToken);
    expect(blob).not.toContain(liveToken.slice(0, 8));
    expect(blob).toContain('[REDACTED]');
    expect(res.body.items.some((i: { truncated?: boolean }) => i.truncated)).toBe(true);
  });

  it('does not coalesce streaming messages across sessionId boundaries', async () => {
    appendEvent(db, {
      sessionId: sessA, type: 'message', sender: 'agent', seq: 1, ts: NOW,
      payload: { chunk: 'from-session-one', final: false },
    });
    const later = createSession(db, {
      id: 'sess-a-later', conversationId: convA, agentId: 'claude-code', agentModelId: PROFILE_ID,
    }).id;
    const fin = appendEvent(db, {
      sessionId: later, type: 'message', sender: 'agent', seq: 1, ts: NOW + 1,
      payload: { chunk: 'from-session-two', final: true },
    });
    const res = await get(`/agent/conversations/${convA}/context?eventId=${fin.id}&before=1&after=0`);
    expect(res.status).toBe(200);
    const texts = res.body.items.map((i: { text: string }) => i.text);
    expect(texts.some((t: string) => t.includes('from-session-one') && t.includes('from-session-two'))).toBe(false);
    expect(texts).toContain('from-session-one');
    expect(texts).toContain('from-session-two');
  });
});

describe('GET /agent/search memory capability', () => {
  it('403 no_memory_capability when token scope lacks memory', async () => {
    const tok = issueSpawnToken(convA, sessA, CONVERSATION_CAPABILITIES);
    seedPrompt(sessA, 'marmalade');
    const search = await get('/agent/search?q=marmalade', tok);
    expect(search.status).toBe(403);
    expect(search.body.error).toBe('no_memory_capability');
    const ctx = await get(`/agent/conversations/${convA}/context?eventId=x`, tok);
    expect(ctx.status).toBe(403);
    expect(ctx.body.error).toBe('no_memory_capability');
  });

  it('403 no_memory_capability when capability profile has memory: false', async () => {
    const tok = issueSpawnToken(convA, sessA, memoryScope(), {
      id: 'minimal', plugins: [], usage: false, memory: false,
    });
    seedPrompt(sessA, 'marmalade');
    const search = await get('/agent/search?q=marmalade', tok);
    expect(search.status).toBe(403);
    expect(search.body.error).toBe('no_memory_capability');
    const ctx = await get(`/agent/conversations/${convA}/context?eventId=x`, tok);
    expect(ctx.status).toBe(403);
    expect(ctx.body.error).toBe('no_memory_capability');
  });
});

describe('GET /agent/search project override', () => {
  it('global project + project off → 403 agent_search_off', async () => {
    updateProject(db, projectA, { agentSearchScope: 'off' });
    seedPrompt(sessA, 'marmalade');
    const res = await get('/agent/search?q=marmalade');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_search_off');
  });

  it('global off + project project → 200 own-project hits', async () => {
    updateGeneralSettings(db, { agentSearchScope: 'off' });
    updateProject(db, projectA, { agentSearchScope: 'project' });
    seedPrompt(sessA, 'marmalade alpha');
    seedPrompt(sessB, 'marmalade beta');
    const res = await get('/agent/search?q=marmalade');
    expect(res.status).toBe(200);
    expect(res.body.hits.map((h: { conversationId: string }) => h.conversationId)).toEqual([convA]);
  });

  it('global project + project all → scope=all 200 cross-project', async () => {
    updateProject(db, projectA, { agentSearchScope: 'all' });
    seedPrompt(sessA, 'marmalade alpha');
    seedPrompt(sessB, 'marmalade beta');
    const res = await get('/agent/search?q=marmalade&scope=all');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
    expect(res.body.hits).toHaveLength(2);
  });

  it('global all + project project → scope=all 403 cross_project_search_disabled', async () => {
    updateGeneralSettings(db, { agentSearchScope: 'all' });
    updateProject(db, projectA, { agentSearchScope: 'project' });
    seedPrompt(sessA, 'marmalade');
    const res = await get('/agent/search?q=marmalade&scope=all');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_project_search_disabled');
  });

  it('project all + sandbox on → scope=all 403', async () => {
    updateProject(db, projectA, { agentSearchScope: 'all', sandbox: 'on' });
    seedPrompt(sessA, 'marmalade');
    const res = await get('/agent/search?q=marmalade&scope=all');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_project_search_disabled');
  });
});

describe('GET /agent/search sandbox cap', () => {
  it('caps sandboxed conversations to project scope even when global agentSearchScope is all', async () => {
    updateGeneralSettings(db, { agentSearchScope: 'all' });
    db.prepare(`UPDATE conversations SET sandbox = 'on' WHERE id = ?`).run(convA);
    seedPrompt(sessA, 'marmalade alpha');
    const foreignEv = seedPrompt(sessB, 'marmalade beta');

    // Own project still works
    const own = await get('/agent/search?q=marmalade');
    expect(own.status).toBe(200);
    expect(own.body.hits.map((h: { conversationId: string }) => h.conversationId)).toEqual([convA]);

    // scope=all is blocked
    const allRes = await get('/agent/search?q=marmalade&scope=all');
    expect(allRes.status).toBe(403);
    expect(allRes.body.error).toBe('cross_project_search_disabled');

    // foreign projectIds is blocked
    const projRes = await get(`/agent/search?q=marmalade&projectIds=${projectB}`);
    expect(projRes.status).toBe(403);
    expect(projRes.body.error).toBe('cross_project_search_disabled');

    // foreign /context is blocked
    const ctxRes = await get(`/agent/conversations/${convB}/context?eventId=${foreignEv}`);
    expect(ctxRes.status).toBe(403);
    expect(ctxRes.body.error).toBe('cross_project_search_disabled');
  });

  it('caps remote-host conversations to project scope even when global agentSearchScope is all', async () => {
    db.prepare("INSERT INTO remote_hosts (id, name, status, created_at, updated_at) VALUES (?, ?, 'trusted', ?, ?)")
      .run('host-1', 'node-a', NOW, NOW);
    db.prepare('UPDATE projects SET remote_host_id = ? WHERE id = ?').run('host-1', projectA);
    updateGeneralSettings(db, { agentSearchScope: 'all' });
    seedPrompt(sessA, 'marmalade alpha');
    const foreignEv = seedPrompt(sessB, 'marmalade beta');

    const own = await get('/agent/search?q=marmalade');
    expect(own.status).toBe(200);
    expect(own.body.hits.map((h: { conversationId: string }) => h.conversationId)).toEqual([convA]);

    const allRes = await get('/agent/search?q=marmalade&scope=all');
    expect(allRes.status).toBe(403);
    expect(allRes.body.error).toBe('cross_project_search_disabled');

    const projRes = await get(`/agent/search?q=marmalade&projectIds=${projectB}`);
    expect(projRes.status).toBe(403);
    expect(projRes.body.error).toBe('cross_project_search_disabled');

    const ctxRes = await get(`/agent/conversations/${convB}/context?eventId=${foreignEv}`);
    expect(ctxRes.status).toBe(403);
    expect(ctxRes.body.error).toBe('cross_project_search_disabled');
  });
});

describe('GET /agent/search helper snapshots', () => {
  it('indexes terminal helper snapshots, skips running snapshots, and resolves helper context', async () => {
    const runningId = 'helper-running-1';
    const doneNoSummaryId = 'helper-done-0';
    const doneId = 'helper-done-1';
    db.prepare(
      `INSERT INTO events (id, session_id, seq, type, sender, payload, ts)
       VALUES (?, ?, ?, 'helper', 'agent', ?, ?)`,
    ).run(
      runningId,
      sessA,
      50,
      JSON.stringify({
        taskId: 't-helper-1',
        label: 'Explore',
        description: 'Inspecting runningquokka',
        status: 'running',
        startedAt: 1000,
      }),
      1000,
    );
    db.prepare(
      `INSERT INTO events (id, session_id, seq, type, sender, payload, ts)
       VALUES (?, ?, ?, 'helper', 'agent', ?, ?)`,
    ).run(
      doneNoSummaryId,
      sessA,
      51,
      JSON.stringify({
        taskId: 't-helper-1',
        label: 'Explore',
        description: 'Inspecting config files',
        status: 'completed',
        startedAt: 1000,
      }),
      1001,
    );
    db.prepare(
      `INSERT INTO events (id, session_id, seq, type, sender, payload, ts)
       VALUES (?, ?, ?, 'helper', 'agent', ?, ?)`,
    ).run(
      doneId,
      sessA,
      52,
      JSON.stringify({
        taskId: 't-helper-1',
        label: 'Explore',
        description: 'Inspecting config files',
        summary: 'Found finalquokka in settings.ts',
        status: 'completed',
        startedAt: 1000,
      }),
      1002,
    );

    const runRes = await get('/agent/search?q=runningquokka');
    expect(runRes.status).toBe(200);
    expect(runRes.body.hits).toEqual([]);

    const doneRes = await get('/agent/search?q=finalquokka');
    expect(doneRes.status).toBe(200);
    expect(doneRes.body.hits).toHaveLength(1);
    expect(doneRes.body.hits[0].matches[0]).toMatchObject({
      eventId: doneId,
      type: 'helper',
      sender: 'helper',
    });
    expect(doneRes.body.hits[0].matches[0].snippet).toContain('finalquokka');

    const ctxRes = await get(`/agent/conversations/${convA}/context?eventId=${doneId}`);
    expect(ctxRes.status).toBe(200);
    const helperItems = ctxRes.body.items.filter((i: { type: string }) => i.type === 'helper');
    expect(helperItems).toHaveLength(1);
    const anchor = ctxRes.body.items.find((i: { isAnchor: boolean }) => i.isAnchor);
    expect(anchor).toMatchObject({
      eventId: doneId,
      type: 'helper',
      sender: 'helper',
      isAnchor: true,
    });
    expect(anchor.text).toContain('finalquokka');
  });
});

describe('GET /agent/search rate limit', () => {
  it('returns 429 after 30 requests in a minute', async () => {
    seedPrompt(sessA, 'marmalade');
    let last = { status: 0, body: { error: '', retryAfter: 0 } };
    for (let i = 0; i < 31; i++) {
      last = await get('/agent/search?q=marmalade');
    }
    expect(last.status).toBe(429);
    expect(last.body.error).toBe('rate_limited');
    expect(last.body.retryAfter).toBeGreaterThan(0);
  });
});
