import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'fs';
import type { NormalisedEvent } from '@tierwyn/shared';
import type { CdpLike } from './cdp.js';
import { GrokBotAdapter } from './index.js';
import type { ReplicaEntry } from './mapping.js';

const AGENT = '8c236467-9550-4bb2-bb9d-80938bc7e5f6';
const KEYS = [
  `sand.client.slice.account.acct.selection.last-agent`,
  `sand.client.slice.account.acct.roster.last-roster`,
  `sand.client.slice.account.acct.transcript.replicas.${AGENT}`,
];

function collect(adapter: GrokBotAdapter): { events: NormalisedEvent[]; ended: number } {
  const events: NormalisedEvent[] = [];
  let ended = 0;
  adapter.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
  adapter.streamEvents().on('end', () => { ended += 1; });
  return { events, get ended() { return ended; } };
}

const CARD = {
  cardId: 'gb-card1',
  prompt: 'Open Chrome and sign in',
  choices: [
    { id: 'allow_once', label: 'Allow once' },
    { id: 'deny', label: 'Never' },
    { id: 'always_allow', label: 'Always allow' },
  ],
};

const QUESTION_CARD = {
  cardId: 'gbq-help',
  prompt: 'What would you most like me to help with?',
  choices: [
    { id: 'A', label: 'A Email and calendar' },
    { id: 'B', label: 'B Coding and debugging' },
    { id: 'dismiss', label: 'Dismiss' },
  ],
  allowFreeText: true,
};

function makeFake(opts: {
  composer?: boolean;
  replica?: ReplicaEntry[];
  roster?: { id: string; name?: string }[];
  /** Values returned by successive reads of the app's data-grok-state mark. */
  states?: string[];
  lateEntryAtRead?: number;
  approvals?: typeof CARD[];
  questions?: typeof QUESTION_CARD[];
  /** When false, Enter writes the user echo only — no assistant reply. */
  autoReply?: boolean;
  questionClickOk?: boolean;
  questionClickThrow?: boolean;
  /** When false, DOM.querySelector for the file input returns no node. */
  fileInput?: boolean;
  /** When false, staging never reports the filenames. */
  stageReady?: boolean;
} = {}) {
  const replica: ReplicaEntry[] = opts.replica ? [...opts.replica] : [];
  const states = opts.states ? [...opts.states] : [];
  const approvals = opts.approvals ? [...opts.approvals] : [];
  const questions = opts.questions ? [...opts.questions] : [];
  let stateReads = 0;
  let inserted = '';
  let lastActivityAt = 1;
  const methods: string[] = [];
  const clicked: string[] = [];
  const clicks: { cardId: string; choiceId: string }[] = [];
  const questionClicks: { cardId: string; choiceId: string }[] = [];
  const freeTexts: { cardId: string; text: string }[] = [];
  const insertedTexts: string[] = [];
  const setFiles: string[][] = [];
  let stagedNames: string[] = [];
  const client: CdpLike = {
    async evaluate(expression: string) {
      const expr = expression;
      if (expr.includes('__tierwynGrokBotQuestionScan')) return [...questions];
      if (expr.includes('__tierwynGrokBotQuestionClick')) {
        const m = expr.match(/__tierwynGrokBotQuestionClick\((.*)\)/);
        const args = m?.[1] ? JSON.parse(`[${m[1]}]`) as [string, string] : ['', ''];
        questionClicks.push({ cardId: args[0], choiceId: args[1] });
        if (opts.questionClickThrow) throw new Error('CDP socket closed');
        if (opts.questionClickOk === false) return false;
        questions.splice(0);
        return true;
      }
      if (expr.includes('__tierwynGrokBotQuestionFreeText')) {
        const m = expr.match(/__tierwynGrokBotQuestionFreeText\((.*)\)/);
        const args = m?.[1] ? JSON.parse(`[${m[1]}]`) as [string, string] : ['', ''];
        freeTexts.push({ cardId: args[0], text: args[1] });
        questions.splice(0);
        return true;
      }
      if (expr.includes('__tierwynGrokBotScan')) return [...approvals];
      if (expr.includes('__tierwynGrokBotClick')) {
        const m = expr.match(/__tierwynGrokBotClick\((.*)\)/);
        const args = m?.[1] ? JSON.parse(`[${m[1]}]`) as [string, string] : ['', ''];
        clicks.push({ cardId: args[0], choiceId: args[1] });
        approvals.splice(0);
        return true;
      }
      if (expr.includes('dataset.grokState')) {
        stateReads += 1;
        if (stateReads === opts.lateEntryAtRead) {
          replica.push({ kind: 'send-message', id: 't1s1', message: { type: 'text', content: 'here are the news' } });
        }
        return states.length ? states.shift()! : 'idle';
      }
      if (expr.includes('sand-agent-item[data-agent-id')) {
        const m = expr.match(/data-agent-id=\\"([^\\"]+)/);
        if (m) clicked.push(m[1]);
        const known = (opts.roster ?? [{ id: AGENT }]).some((r) => expr.includes(r.id));
        return known;
      }
      if (expr.includes('sand-kit-message-input-frame')) {
        if (opts.stageReady === false) return false;
        const text = stagedNames.join(' ');
        return text.length > 0 && stagedNames.every((n) => text.includes(n));
      }
      if (opts.composer === false && expr.includes('querySelector')) return null;
      if (expr.includes('listClientPersistenceKeys')) return KEYS;
      if (expr.includes('readClientPersistence')) {
        if (expr.includes('selection.last-agent')) {
          return { schemaVersion: 1, value: { agentId: AGENT } };
        }
        if (expr.includes('roster.last-roster')) {
          const rows = (opts.roster ?? [{ id: AGENT, name: 'Inbox Triage' }])
            .map((r) => ({ ...r, lastActivityAt }));
          return { schemaVersion: 1, value: { rows } };
        }
        if (expr.includes('transcript.replicas')) {
          return { schemaVersion: 1, value: { entries: replica } };
        }
      }
      if (expr.includes('return { selector:')) {
        return { selector: 'div.tiptap.ProseMirror.sand-prompt-field[role="textbox"][aria-label="Prompt"]', text: inserted };
      }
      if (expr.includes('el.focus')) return true;
      if (expr.includes('innerText')) return inserted;
      if (expr.includes('textContent = text')) return true;
      return null;
    },
    async send(method: string, params?: Record<string, unknown>) {
      methods.push(method);
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') {
        if (opts.fileInput === false) return { nodeId: 0 };
        return { nodeId: 2 };
      }
      if (method === 'DOM.setFileInputFiles') {
        const files = (params?.files as string[]) ?? [];
        setFiles.push(files);
        stagedNames = files.map((p) => p.split('/').pop() ?? p);
      }
      if (method === 'Input.insertText') {
        inserted = String(params?.text ?? '');
        insertedTexts.push(inserted);
      }
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp' && replica.length === 0) {
        replica.push(
          { kind: 'message', id: 't1u', role: 'user', content: inserted.replace(/\s+/g, ' ').trim() || '📎', isStreaming: false },
        );
        if (opts.autoReply !== false) {
          replica.push({ kind: 'send-message', id: 't1s0', message: { type: 'text', content: 'pong' } });
        }
        lastActivityAt = 1;
      }
      return {};
    },
    on() { return () => undefined; },
    async close() { /* noop */ },
  };
  return {
    client, replica, methods, clicked, approvals, questions, clicks, questionClicks, freeTexts, insertedTexts, setFiles,
    setActivity: (n: number) => { lastActivityAt = n; },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('GrokBotAdapter constructor', () => {
  it('is side-effect free (no connect on construct)', () => {
    let connected = 0;
    new GrokBotAdapter({ connect: async () => { connected += 1; throw new Error('no'); } });
    expect(connected).toBe(0);
  });

  it('listModels degrades to [] when the app cannot be attached', async () => {
    let connected = 0;
    const a = new GrokBotAdapter({ connect: async () => { connected += 1; throw new Error('no'); } });
    await expect(a.listModels()).resolves.toEqual([]);
    expect(connected).toBe(1);
  });
});

describe('GrokBotAdapter start', () => {
  it('degrades to error + end when the composer is missing', async () => {
    const { client } = makeFake({ composer: false });
    const adapter = new GrokBotAdapter({ client, timeoutMs: 1000, idleMs: 10, pollMs: 1 });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    expect(bag.events.some((e) => e.type === 'error')).toBe(true);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'error')).toBe(true);
    expect(bag.ended).toBe(1);
  });

  it('records nativeSessionId from selection.last-agent', async () => {
    const { client } = makeFake();
    const adapter = new GrokBotAdapter({ client });
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    expect(adapter.nativeSessionId).toBe(AGENT);
  });
});

describe('GrokBotAdapter sendPrompt', () => {
  it('reports ingested replica entry ids to the watcher as they stream', async () => {
    const { client } = makeFake();
    let t = 10_000;
    const reports: Array<{ botId: string; ids: string[] }> = [];
    const adapter = new GrokBotAdapter({
      client,
      idleMs: 4000,
      pollMs: 750,
      timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      onIngested: (botId, ids) => reports.push({ botId, ids }),
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('hello');
    expect(bag.events.filter((e) => e.type === 'message').map((e) => e.type === 'message' ? e.payload.chunk : '')).toEqual(['pong']);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.at(-1)?.ids).toEqual(['t1u', 't1s0']);
    expect(reports.every((r) => r.botId === AGENT)).toBe(true);
  });

  it('types into the composer, dispatches Enter, streams replica text, then emits done+end', async () => {
    const { client, methods } = makeFake();
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client,
      idleMs: 4000,
      pollMs: 750,
      timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => { t += ms; },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('Reply with exactly: pong');

    expect(methods).toContain('Input.insertText');
    expect(methods.filter((m) => m === 'Input.dispatchKeyEvent').length).toBeGreaterThanOrEqual(2);

    const messages = bag.events.filter((e) => e.type === 'message');
    expect(messages.map((e) => e.type === 'message' ? e.payload.chunk : '')).toEqual(['pong']);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'running')).toBe(true);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(bag.ended).toBe(1);
  });

  it('settles a multi-line prompt whose replica echo has collapsed newlines', async () => {
    const { client } = makeFake();
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('line one\n\nline two\nReply with exactly: pong');

    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(bag.events.some((e) => e.type === 'error')).toBe(false);
    expect(bag.ended).toBe(1);
  });

  it('stays in the turn while the app reports "working" and still delivers late text', async () => {
    // Grok answers, then drives the computer in silence for longer than the idle
    // window before sending the real answer.
    const { client } = makeFake({ states: ['working', 'working', 'working', 'working', 'idle', 'idle'], lateEntryAtRead: 4 });
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client, idleMs: 4000, pollMs: 750, timeoutMs: 60_000,
      now: () => t, sleep: async (ms) => { t += 5000; void ms; },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('open chrome and tell me the news');

    const chunks = bag.events.filter((e) => e.type === 'message').map((e) => e.type === 'message' ? e.payload.chunk : '');
    expect(chunks).toEqual(['pong', 'here are the news']);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(bag.ended).toBe(1);
  });

  it('selects the pinned Bot row before typing', async () => {
    const other = '8794657a-762d-4896-9299-974aeb15d334';
    const { client, clicked } = makeFake({ roster: [{ id: AGENT, name: 'Inbox Triage' }, { id: other, name: 'New Bot' }] });
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: other });
    expect(adapter.nativeSessionId).toBe(other);
    await adapter.sendPrompt('hi');
    expect(clicked).toContain(other);
  });

  it('does not time out while the agent is busy past the original start deadline', async () => {
    const { client } = makeFake({
      states: ['working', 'working', 'working', 'working', 'working', 'idle', 'idle'],
      lateEntryAtRead: 5,
    });
    let t = 0;
    const adapter = new GrokBotAdapter({
      client, idleMs: 1000, pollMs: 100, timeoutMs: 5_000,
      now: () => t, sleep: async (ms) => { t += 2_000; void ms; },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('open chrome and tell me the news');

    const chunks = bag.events.filter((e) => e.type === 'message').map((e) => e.type === 'message' ? e.payload.chunk : '');
    expect(chunks).toEqual(['pong', 'here are the news']);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(bag.events.some((e) => e.type === 'error')).toBe(false);
    expect(bag.ended).toBe(1);
  });

  it('steer mid-turn slides the timeout window', async () => {
    const fake = makeFake({ autoReply: false });
    let t = 0;
    let steered = false;
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 1000, pollMs: 100, timeoutMs: 5_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (!steered && t >= 4_000) {
          steered = true;
          await adapter.steer('ok news in England as well');
          fake.replica.push({
            kind: 'send-message', id: 't1s0', message: { type: 'text', content: 'england news' },
          });
        }
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('italy news');

    const chunks = bag.events.filter((e) => e.type === 'message').map((e) => e.type === 'message' ? e.payload.chunk : '');
    expect(chunks).toEqual(['england news']);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(bag.events.some((e) => e.type === 'error')).toBe(false);
    expect(bag.ended).toBe(1);
  });

  it('does not duplicate assistant text across polls', async () => {
    const { client } = makeFake();
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('Reply with exactly: pong');
    const chunks = bag.events.filter((e) => e.type === 'message').map((e) => e.type === 'message' ? e.payload.chunk : '');
    expect(chunks).toEqual(['pong']);
  });

  it('sendPrompt with attachments sets file input paths under original names, then Enter', async () => {
    const { client, methods, setFiles } = makeFake();
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000, attachTimeoutMs: 200,
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('see these', [
      { mediaType: 'text/plain', base64: Buffer.from('a').toString('base64'), name: 'notes.txt' },
      { mediaType: 'image/png', base64: Buffer.from('b').toString('base64'), name: 'pic.png' },
    ]);
    expect(setFiles[0]?.map((p) => p.split('/').pop())).toEqual(['notes.txt', 'pic.png']);
    expect(methods).toContain('DOM.setFileInputFiles');
    expect(methods).toContain('Input.insertText');
    expect(methods.filter((m) => m === 'Input.dispatchKeyEvent').length).toBeGreaterThanOrEqual(2);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(setFiles[0]?.every((p) => !existsSync(p))).toBe(true);
  });

  it('rejects more than MAX_STAGED_ATTACHMENTS without touching the file input', async () => {
    const { client, methods, setFiles } = makeFake();
    const adapter = new GrokBotAdapter({
      client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000, attachTimeoutMs: 200,
      now: () => 10_000, sleep: async () => undefined,
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    const many = Array.from({ length: 7 }, (_, i) => ({
      mediaType: 'text/plain',
      base64: Buffer.from('a').toString('base64'),
      name: `f${i}.txt`,
    }));
    await adapter.sendPrompt('too many', many);
    expect(bag.events.some((e) => e.type === 'error' && e.payload.message.includes('at most 6'))).toBe(true);
    expect(methods).not.toContain('DOM.setFileInputFiles');
    expect(setFiles).toEqual([]);
  });

  it('readiness timeout _fail with no Enter', async () => {
    const { client, methods } = makeFake({ stageReady: false });
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client, idleMs: 4000, pollMs: 10, timeoutMs: 30_000, attachTimeoutMs: 20,
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('x', [
      { mediaType: 'text/plain', base64: Buffer.from('a').toString('base64'), name: 'notes.txt' },
    ]);
    expect(bag.events.some((e) => e.type === 'error' && e.payload.message.includes('did not accept'))).toBe(true);
    expect(methods).not.toContain('Input.insertText');
    expect(methods.filter((m) => m === 'Input.dispatchKeyEvent')).toEqual([]);
  });

  it('empty text plus an attachment settles done on a new user row', async () => {
    const { client } = makeFake();
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000, attachTimeoutMs: 200,
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('', [
      { mediaType: 'text/plain', base64: Buffer.from('a').toString('base64'), name: 'notes.txt' },
    ]);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(bag.events.some((e) => e.type === 'error')).toBe(false);
    expect(bag.ended).toBe(1);
  });

  it('steer forwards attachments onto the composer file input', async () => {
    const fake = makeFake();
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000, attachTimeoutMs: 200,
      now: () => 10_000, sleep: async () => undefined,
    });
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.steer('with file', [
      { mediaType: 'text/plain', base64: Buffer.from('s').toString('base64'), name: 'steer.txt' },
    ]);
    expect(fake.setFiles.some((files) => files.some((p) => p.endsWith('steer.txt')))).toBe(true);
  });
});

describe('GrokBotAdapter roster surface', () => {
  it('listModels returns the Bot chats by their real names prefixed with Grok Bot', async () => {
    const other = '8794657a-762d-4896-9299-974aeb15d334';
    const { client } = makeFake({ roster: [{ id: AGENT, name: 'Inbox Triage' }, { id: other, name: 'New Bot' }] });
    const adapter = new GrokBotAdapter({ client });
    expect(await adapter.listModels()).toEqual([
      { name: AGENT, label: 'Grok Bot · Inbox Triage', provider: 'xai', vision: true, steer: true },
      { name: other, label: 'Grok Bot · New Bot', provider: 'xai', vision: true, steer: true },
    ]);
  });

  it('listModels returns [] when the app is unreachable', async () => {
    const adapter = new GrokBotAdapter({ connect: async () => { throw new Error('CDP unreachable'); } });
    expect(await adapter.listModels()).toEqual([]);
  });

  it('isNativeSessionAvailable tracks roster membership', async () => {
    const { client } = makeFake();
    const adapter = new GrokBotAdapter({ client });
    expect(await adapter.isNativeSessionAvailable(AGENT)).toBe(true);
    expect(await adapter.isNativeSessionAvailable('8794657a-762d-4896-9299-974aeb15d334')).toBe(false);
    expect(await adapter.isNativeSessionAvailable('')).toBe(false);
  });
});

describe('GrokBotAdapter Phase 2 approvals / stop / steer', () => {
  function clocked(client: ReturnType<typeof makeFake>['client']) {
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    return { adapter, bag: collect(adapter) };
  }

  it('relays an approval card, clicks Allow once, then finishes running → waiting → running → done', async () => {
    const fake = makeFake({ approvals: [CARD], autoReply: false });
    let t = 10_000;
    let answered = false;
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        const req = bag.events.find((e) => e.type === 'interaction_request');
        if (req && req.type === 'interaction_request' && !answered) {
          answered = true;
          adapter.respondToInteraction(req.payload.requestId, { selection: ['allow_once'] });
          await flush();
          fake.replica.push({ kind: 'send-message', id: 't1s0', message: { type: 'text', content: 'ok' } });
        }
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('do something consequential');

    expect(fake.clicks).toEqual([{ cardId: 'gb-card1', choiceId: 'allow_once' }]);
    const statuses = bag.events.filter((e) => e.type === 'status').map((e) => e.type === 'status' ? e.payload.status : '');
    expect(statuses).toEqual(['running', 'waiting', 'running', 'done']);
    const resolved = bag.events.find((e) => e.type === 'interaction_resolved');
    expect(resolved && resolved.type === 'interaction_resolved' && resolved.payload.resolution).toBe('answered');
    expect(bag.ended).toBe(1);
  });

  it('does not emit auto after answered when a poll sees the card gone while answering', async () => {
    const fake = makeFake({ approvals: [CARD], autoReply: false });
    let t = 10_000;
    let phase: 'wait-req' | 'clicking' | 'remount' | 'gone' = 'wait-req';
    let releaseClick: (() => void) | undefined;
    const origEvaluate = fake.client.evaluate.bind(fake.client);
    fake.client.evaluate = async (expression: string) => {
      // Match the click call only — APPROVAL_SCAN_JS also contains the helper name.
      if (expression.includes('window.__tierwynGrokBotClick(')) {
        const result = await origEvaluate(expression);
        await new Promise<void>((resolve) => { releaseClick = resolve; });
        return result;
      }
      return origEvaluate(expression);
    };
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (phase === 'wait-req') {
          const req = bag.events.find((e) => e.type === 'interaction_request');
          if (req && req.type === 'interaction_request') {
            phase = 'clicking';
            adapter.respondToInteraction(req.payload.requestId, { selection: ['allow_once'] });
            await flush();
          }
        } else if (phase === 'clicking' && releaseClick) {
          // Poll has now seen an empty DOM while _answering is still set.
          phase = 'remount';
          releaseClick();
          releaseClick = undefined;
          await flush();
          fake.approvals.push({ ...CARD });
        } else if (phase === 'remount') {
          phase = 'gone';
          fake.approvals.splice(0);
          if (!fake.replica.some((e) => e.kind === 'send-message')) {
            fake.replica.push({ kind: 'send-message', id: 't1s0', message: { type: 'text', content: 'ok' } });
          }
        }
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('do something consequential');

    const resolved = bag.events.filter((e) => e.type === 'interaction_resolved');
    expect(resolved.map((e) => e.type === 'interaction_resolved' ? e.payload.resolution : '')).toEqual(['answered']);
    expect(bag.events.filter((e) => e.type === 'interaction_request')).toHaveLength(1);
    expect(bag.ended).toBe(1);
  });

  it('relays a second approval card with the same headline after the first one resolves', async () => {
    const CARD1 = { ...CARD, cardId: 'gb-12345-1' };
    const CARD2 = { ...CARD, cardId: 'gb-12345-2' };
    const fake = makeFake({ approvals: [CARD1], autoReply: false });
    let t = 10_000;
    let step = 0;
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (step === 0) {
          const req = bag.events.find((e) => e.type === 'interaction_request' && e.payload.requestId === 'gb-12345-1');
          if (req) {
            step = 1;
            adapter.respondToInteraction('gb-12345-1', { selection: ['allow_once'] });
            await flush();
            fake.approvals.splice(0);
          }
        } else if (step === 1) {
          step = 2;
          fake.approvals.push(CARD2);
        } else if (step === 2) {
          const req2 = bag.events.find((e) => e.type === 'interaction_request' && e.payload.requestId === 'gb-12345-2');
          if (req2) {
            step = 3;
            adapter.respondToInteraction('gb-12345-2', { selection: ['allow_once'] });
            await flush();
            fake.approvals.splice(0);
            fake.replica.push({ kind: 'send-message', id: 't1s0', message: { type: 'text', content: 'ok both done' } });
          }
        }
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('do two consequential things');

    const requests = bag.events.filter((e) => e.type === 'interaction_request');
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.type === 'interaction_request' ? r.payload.requestId : '')).toEqual(['gb-12345-1', 'gb-12345-2']);

    const resolved = bag.events.filter((e) => e.type === 'interaction_resolved');
    expect(resolved).toHaveLength(2);
    expect(resolved.map((r) => r.type === 'interaction_resolved' ? r.payload.resolution : '')).toEqual(['answered', 'answered']);
    expect(bag.ended).toBe(1);
  });

  it('emits interaction_resolved auto when the card disappears without a Tierwyn click', async () => {
    const fake = makeFake({ approvals: [CARD], autoReply: false });
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        fake.approvals.splice(0);
        if (!fake.replica.some((e) => e.kind === 'send-message')) {
          fake.replica.push({ kind: 'send-message', id: 't1s0', message: { type: 'text', content: 'ok' } });
        }
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('do something consequential');

    expect(fake.clicks).toEqual([]);
    const resolved = bag.events.find((e) => e.type === 'interaction_resolved');
    expect(resolved && resolved.type === 'interaction_resolved' && resolved.payload.resolution).toBe('auto');
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'waiting')).toBe(true);
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'done')).toBe(true);
    expect(bag.ended).toBe(1);
  });

  it('relays a question card, clicks letter A, then finishes', async () => {
    const fake = makeFake({ questions: [QUESTION_CARD], autoReply: false });
    let t = 10_000;
    let answered = false;
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        const req = bag.events.find((e) => e.type === 'interaction_request');
        if (req && req.type === 'interaction_request' && !answered) {
          answered = true;
          adapter.respondToInteraction(req.payload.requestId, { selection: ['A'] });
          await flush();
          fake.replica.push({ kind: 'send-message', id: 't1s0', message: { type: 'text', content: 'ok' } });
        }
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('hello new bot');

    expect(fake.questionClicks).toEqual([{ cardId: 'gbq-help', choiceId: 'A' }]);
    expect(fake.clicks).toEqual([]);
    const req = bag.events.find((e) => e.type === 'interaction_request');
    expect(req && req.type === 'interaction_request' && req.payload.kind).toBe('question');
    expect(req && req.type === 'interaction_request' && req.payload.allowFreeText).toBe(true);
    const resolved = bag.events.find((e) => e.type === 'interaction_resolved');
    expect(resolved && resolved.type === 'interaction_resolved' && resolved.payload.resolution).toBe('answered');
    expect(bag.ended).toBe(1);
  });

  it('does not emit answered when the question click misses', async () => {
    const fake = makeFake({ questions: [QUESTION_CARD], autoReply: false, questionClickOk: false });
    let t = 10_000;
    let answered = false;
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        const req = bag.events.find((e) => e.type === 'interaction_request');
        if (req && req.type === 'interaction_request' && !answered) {
          answered = true;
          adapter.respondToInteraction(req.payload.requestId, { selection: ['A'] });
          await flush();
        }
        if (t > 12_000) await adapter.stop();
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('hello new bot');

    expect(fake.questionClicks).toEqual([{ cardId: 'gbq-help', choiceId: 'A' }]);
    const resolved = bag.events.find((e) => e.type === 'interaction_resolved');
    expect(resolved).toBeUndefined();
    expect(bag.events.some((e) => e.type === 'error')).toBe(true);
  });

  it('does not emit answered when clickQuestion throws', async () => {
    const fake = makeFake({ questions: [QUESTION_CARD], autoReply: false, questionClickThrow: true });
    let t = 10_000;
    let answered = false;
    const adapter = new GrokBotAdapter({
      // 'CDP socket closed' drops the client; without `connect` stop() redials the REAL app on :9333.
      client: fake.client, connect: async () => fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        const req = bag.events.find((e) => e.type === 'interaction_request');
        if (req && req.type === 'interaction_request' && !answered) {
          answered = true;
          adapter.respondToInteraction(req.payload.requestId, { selection: ['A'] });
          await flush();
        }
        if (t > 12_000) await adapter.stop();
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('hello new bot');

    const resolved = bag.events.find((e) => e.type === 'interaction_resolved');
    expect(resolved).toBeUndefined();
    expect(bag.events.some((e) => e.type === 'error')).toBe(true);
  });

  it('submits question free text when selection is empty', async () => {
    const fake = makeFake({ questions: [QUESTION_CARD], autoReply: false });
    let t = 10_000;
    let answered = false;
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        const req = bag.events.find((e) => e.type === 'interaction_request');
        if (req && req.type === 'interaction_request' && !answered) {
          answered = true;
          adapter.respondToInteraction(req.payload.requestId, { selection: [], text: 'just email' });
          await flush();
          fake.replica.push({ kind: 'send-message', id: 't1s0', message: { type: 'text', content: 'ok' } });
        }
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('hello new bot');

    expect(fake.freeTexts).toEqual([{ cardId: 'gbq-help', text: 'just email' }]);
    expect(fake.questionClicks).toEqual([]);
    const resolved = bag.events.find((e) => e.type === 'interaction_resolved');
    expect(resolved && resolved.type === 'interaction_resolved' && resolved.payload.text).toBe('just email');
    expect(bag.ended).toBe(1);
  });

  it('stop() sends Stop now, emits idle, then end', async () => {
    const { client, insertedTexts } = makeFake();
    const { adapter, bag } = clocked(client);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.stop();
    expect(insertedTexts).toContain('Stop now');
    expect(bag.events.some((e) => e.type === 'status' && e.payload.status === 'idle')).toBe(true);
    expect(bag.ended).toBe(1);
  });

  it('interruptTurn() sends Stop now and does not emit end', async () => {
    const { client, insertedTexts } = makeFake();
    const { adapter, bag } = clocked(client);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    adapter.interruptTurn();
    await flush();
    expect(insertedTexts).toContain('Stop now');
    expect(bag.ended).toBe(0);
  });

  it('steer() types into the composer without ending the session', async () => {
    const { client, insertedTexts } = makeFake();
    const { adapter, bag } = clocked(client);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.steer('actually do the other thing');
    expect(insertedTexts).toContain('actually do the other thing');
    expect(bag.ended).toBe(0);
  });

  it('steer() resets assistant settle state and allows approval cards to be received and answered', async () => {
    const fake = makeFake({ autoReply: false });
    let t = 10_000;
    let step = 0;
    const adapter = new GrokBotAdapter({
      client: fake.client, idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (step === 0) {
          // Assistant replies to first prompt
          step = 1;
          fake.replica.push({ kind: 'send-message', id: 't1s0', message: { type: 'text', content: 'first done' } });
        } else if (step === 1) {
          // Mid-turn steer arrives
          step = 2;
          await adapter.steer('and once more');
          fake.approvals.push({ ...CARD, cardId: 'gb-12345-1' });
        } else if (step === 2) {
          const req = bag.events.find((e) => e.type === 'interaction_request' && e.payload.requestId === 'gb-12345-1');
          if (req) {
            step = 3;
            adapter.respondToInteraction('gb-12345-1', { selection: ['allow_once'] });
            await flush();
            fake.approvals.splice(0);
            fake.replica.push({ kind: 'send-message', id: 't2s0', message: { type: 'text', content: 'second done' } });
          }
        }
      },
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    await adapter.sendPrompt('can you write a file?');

    const reqs = bag.events.filter((e) => e.type === 'interaction_request');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.type === 'interaction_request' ? reqs[0].payload.requestId : '').toBe('gb-12345-1');

    const resolved = bag.events.filter((e) => e.type === 'interaction_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.type === 'interaction_resolved' ? resolved[0].payload.resolution : '').toBe('answered');
    expect(bag.ended).toBe(1);
  });
});

describe('GrokBotAdapter.deleteNativeSession', () => {
  it('is a no-op when the flag is false (zero CDP calls)', async () => {
    let connects = 0;
    const adapter = new GrokBotAdapter({
      deleteBotOnConversationDelete: () => false,
      connect: async () => { connects += 1; throw new Error('no'); },
    });
    await adapter.deleteNativeSession(AGENT);
    expect(connects).toBe(0);
  });

  it('skips default without connecting', async () => {
    let connects = 0;
    const adapter = new GrokBotAdapter({
      deleteBotOnConversationDelete: () => true,
      connect: async () => { connects += 1; throw new Error('no'); },
    });
    await adapter.deleteNativeSession('default');
    expect(connects).toBe(0);
  });

  it('swallows a thrown CDP error without rejecting', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = new GrokBotAdapter({
      deleteBotOnConversationDelete: () => true,
      connect: async () => { throw new Error('CDP down'); },
    });
    await expect(adapter.deleteNativeSession(AGENT)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('GrokBotAdapter ensureRunning', () => {
  const failedStatus = {
    state: 'failed' as const,
    enabled: true,
    autoStart: 'keep-running' as const,
    envLocks: { autostart: false, watch: false },
    launcher: null,
    attribution: null,
    layout: 'native' as const,
    attempts: 5,
    nextAttemptAt: null,
    lastError: 'unit failed',
    lastErrorAt: 1,
    since: 1,
  };

  it('awaits ensureRunning before connect on start', async () => {
    const order: string[] = [];
    const { client } = makeFake();
    const adapter = new GrokBotAdapter({
      client,
      timeoutMs: 1000, idleMs: 10, pollMs: 1,
      connect: async () => { order.push('connect'); return client; },
      ensureRunning: async () => { order.push('ensure'); return { ...failedStatus, state: 'running' }; },
    });
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    expect(order[0]).toBe('ensure');
  });

  it('awaits ensureRunning before connect on sendPrompt', async () => {
    const order: string[] = [];
    const { client } = makeFake();
    let t = 10_000;
    const adapter = new GrokBotAdapter({
      client,
      idleMs: 4000, pollMs: 750, timeoutMs: 30_000,
      now: () => t, sleep: async (ms) => { t += ms; },
      connect: async () => { order.push('connect'); return client; },
      ensureRunning: async () => { order.push('ensure'); return { ...failedStatus, state: 'running' }; },
    });
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    order.length = 0;
    await adapter.sendPrompt('Reply with exactly: pong');
    expect(order[0]).toBe('ensure');
  });

  it('emits a turn error with the supervisor text when not running', async () => {
    const { client } = makeFake();
    const adapter = new GrokBotAdapter({
      client,
      timeoutMs: 1000, idleMs: 10, pollMs: 1,
      ensureRunning: async () => failedStatus,
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    const err = bag.events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.payload.message).toMatch(/failed to start after 5 attempts/);
    expect(bag.ended).toBe(1);
  });

  it('does not call ensureRunning from listModels or isNativeSessionAvailable', async () => {
    let calls = 0;
    const { client } = makeFake();
    const adapter = new GrokBotAdapter({
      client,
      ensureRunning: async () => { calls += 1; return { ...failedStatus, state: 'running' }; },
    });
    await adapter.listModels();
    await adapter.isNativeSessionAvailable(AGENT);
    expect(calls).toBe(0);
  });

  it('35s supervisor timeout does not claim 5 failed attempts', async () => {
    const { client } = makeFake();
    let t = 0;
    const adapter = new GrokBotAdapter({
      client,
      timeoutMs: 1000, idleMs: 10, pollMs: 1,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      ensureRunning: () => new Promise(() => { /* hang */ }),
    });
    const bag = collect(adapter);
    await adapter.start({ sessionId: 's1', conversationId: 'c1', cwd: '/tmp', model: 'default' });
    const err = bag.events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.payload.message).toMatch(/did not become ready within 35s/);
    expect(err && err.type === 'error' && err.payload.message).not.toMatch(/5 attempts/);
  });
});
