import { describe, it, expect } from 'vitest';
import {
  entryEchoesPrompt, imagesFromEntry, mapApprovalDelta, mapQuestionDelta, mapReplicaDelta,
  openReplicaWidgetsToCards, unwrapSlice, replicaEntries, textFromEntry,
} from './mapping.js';
import type { ReplicaEntry } from './mapping.js';

const user: ReplicaEntry = {
  kind: 'message',
  id: 't7u',
  role: 'user',
  content: 'Reply with exactly: pong',
  isStreaming: false,
  timestampMs: 1788284752789,
  clientNonce: '43da6092-74b6-4a82-ae5b-ff375b3cbdab',
  requestId: 'af1306b1-27c8-49e4-9a93-37f1f171c949',
};

const assistant: ReplicaEntry = {
  kind: 'send-message',
  id: 't7s0',
  message: { type: 'text', content: 'pong' },
  timestampMs: 1788284759100,
  requestId: 'af1306b1-27c8-49e4-9a93-37f1f171c949',
};

const widget: ReplicaEntry = {
  kind: 'send-message',
  id: 't7s1',
  message: { type: 'widget', content: { title: 'Pick a thing', options: ['a', 'b'] } },
  timestampMs: 1788284759200,
  requestId: 'af1306b1-27c8-49e4-9a93-37f1f171c949',
};

describe('unwrapSlice', () => {
  it('unwraps schemaVersion envelopes, including JSON strings', () => {
    expect(unwrapSlice({ schemaVersion: 1, value: { agentId: 'abc' } })).toEqual({ agentId: 'abc' });
    expect(unwrapSlice(JSON.stringify({ schemaVersion: 1, value: { agentId: 'abc' } }))).toEqual({ agentId: 'abc' });
    expect(unwrapSlice({ agentId: 'abc' })).toEqual({ agentId: 'abc' });
  });
});

describe('replicaEntries', () => {
  it('reads entries from the replica envelope', () => {
    const raw = { schemaVersion: 1, value: { entries: [user, assistant], persistedAt: 1 } };
    expect(replicaEntries(raw).map((e) => e.id)).toEqual(['t7u', 't7s0']);
  });
});

describe('textFromEntry', () => {
  it('reads send-message.message.content for text cards', () => {
    expect(textFromEntry(assistant)).toBe('pong');
  });

  it('summarises legacy content.title widgets', () => {
    const t = textFromEntry(widget);
    expect(t).toMatch(/widget/i);
    expect(t).toMatch(/Pick a thing/);
  });

  it('reads live message.widget.prompt', () => {
    expect(textFromEntry({
      kind: 'send-message',
      id: 't8s0',
      message: {
        type: 'widget',
        widget: { prompt: 'Which of these?', options: [{ label: 'A' }] },
      },
    })).toBe('[widget] Which of these?');
  });
});

describe('mapReplicaDelta', () => {
  it('skips user messages and emits assistant text once per id', () => {
    const seen = new Set<string>();
    const first = mapReplicaDelta([user, assistant], seen);
    expect(first).toEqual([
      { type: 'message', payload: { chunk: 'pong', final: true } },
    ]);
    const again = mapReplicaDelta([user, assistant], seen);
    expect(again).toEqual([]);
  });

  it('skips widget entries (question ingest owns them)', () => {
    const events = mapReplicaDelta([widget, {
      kind: 'send-message',
      id: 't8s0',
      message: {
        type: 'widget',
        widget: { prompt: 'Pick one', options: [{ label: 'Yes' }] },
      },
    }], new Set());
    expect(events).toEqual([]);
  });
});

describe('openReplicaWidgetsToCards', () => {
  const open: ReplicaEntry = {
    kind: 'send-message',
    id: 't8s0',
    message: {
      type: 'widget',
      widget: {
        prompt: 'Which of these would you like help with most this week?',
        helpText: 'Just a test.',
        allowCustom: true,
        options: [
          { label: 'Security fixes', value: 'Security fixes' },
          { label: 'Daily briefing', value: 'A daily morning briefing' },
        ],
      },
    },
  };

  it('maps open widgets to question cards with gbw- ids and lettered choices', () => {
    const cards = openReplicaWidgetsToCards([open]);
    expect(cards).toEqual([{
      cardId: 'gbw-t8s0',
      prompt: 'Which of these would you like help with most this week?',
      allowFreeText: true,
      choices: [
        { id: 'A', label: 'A Security fixes' },
        { id: 'B', label: 'B Daily briefing' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
    }]);
  });

  it('omits answered and skipped widgets', () => {
    expect(openReplicaWidgetsToCards([
      { ...open, respondedValue: 'Security fixes' },
      { ...open, id: 't9s0', widgetSkipped: true },
    ])).toEqual([]);
  });
});

describe('entryEchoesPrompt', () => {
  const echo = (content: string): ReplicaEntry => ({ kind: 'message', id: 'x', role: 'user', content });

  it('matches when the replica collapsed newlines to spaces', () => {
    expect(entryEchoesPrompt(echo('line one line two Reply with exactly: pong'), 'line one\n\nline two\nReply with exactly: pong')).toBe(true);
  });

  it('matches when the replica truncated a long prompt', () => {
    const prompt = 'a'.repeat(400);
    expect(entryEchoesPrompt(echo('a'.repeat(120)), prompt)).toBe(true);
  });

  it('rejects a different prompt and non-user entries', () => {
    expect(entryEchoesPrompt(echo('something else entirely'), 'Reply with exactly: pong')).toBe(false);
    expect(entryEchoesPrompt({ kind: 'send-message', id: 's', message: { type: 'text', content: 'pong' } }, 'pong')).toBe(false);
  });
});

describe('mapReplicaDelta attachment entries', () => {
  const att: ReplicaEntry = {
    kind: 'send-message',
    id: 't11s0',
    message: {
      type: 'attachment',
      url: 'file:///home/box/agent-data/agents/abc/attachments/deadbeef.txt',
      file_name: 'test-file.txt',
      alt: 'A small test text file from Grok Bot',
    },
    timestampMs: 1791407060741,
    requestId: 'req-1',
  };

  it('maps an attachment entry to a fallback chunk and sandboxUrl', () => {
    const [ev] = mapReplicaDelta([att], new Set());
    expect(ev).toMatchObject({
      type: 'message',
      payload: {
        chunk: '📎 test-file.txt',
        final: true,
      },
    });
    const files = (ev.payload as { files: Array<{ name: string; sandboxUrl?: string; status: string }> }).files;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: 'test-file.txt',
      sandboxUrl: 'file:///home/box/agent-data/agents/abc/attachments/deadbeef.txt',
      status: 'unavailable',
    });
  });

  it('falls back to the URL basename when file_name is missing', () => {
    const [ev] = mapReplicaDelta([{
      ...att,
      id: 't11s1',
      message: { type: 'attachment', url: att.message!.url },
    }], new Set());
    expect((ev.payload as { chunk: string }).chunk).toBe('📎 deadbeef.txt');
    expect((ev.payload as { files: Array<{ name: string }> }).files[0].name).toBe('deadbeef.txt');
  });

  it('marks a non-/home/box URL unavailable with no sandboxUrl', () => {
    const [ev] = mapReplicaDelta([{
      ...att,
      id: 't11s2',
      message: { type: 'attachment', url: 'file:///etc/passwd', file_name: 'passwd' },
    }], new Set());
    const files = (ev.payload as { files: Array<{ sandboxUrl?: string; status: string }> }).files;
    expect(files[0].status).toBe('unavailable');
    expect(files[0].sandboxUrl).toBeUndefined();
  });
});

describe('imagesFromEntry', () => {
  const entry = {
    id: 't19s1', kind: 'send-message',
    message: {
      type: 'text', content: 'Here you go.',
      images: [{ url: 'file:///home/box/a.jpg', alt: 'kitten', width: 1280 }, { alt: 'no url' }],
    },
  };
  it('pulls url+alt and skips entries without a url', () => {
    expect(imagesFromEntry(entry)).toEqual([{ url: 'file:///home/box/a.jpg', alt: 'kitten' }]);
    expect(imagesFromEntry({ id: 'x', kind: 'send-message' })).toEqual([]);
  });
  it('appends markdown images to the mapped chunk', () => {
    const [ev] = mapReplicaDelta([entry], new Set());
    expect((ev.payload as { chunk: string }).chunk)
      .toBe('Here you go.\n\n![kitten](file:///home/box/a.jpg)');
  });
});

describe('mapApprovalDelta', () => {
  const card = {
    cardId: 'gb-abc',
    prompt: 'Open Chrome and sign in',
    choices: [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Never' },
      { id: 'always_allow', label: 'Always allow' },
    ],
  };

  it('emits interaction_request for a new card', () => {
    const pending = new Set<string>();
    const events = mapApprovalDelta([card], pending);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'interaction_request',
      payload: { requestId: 'gb-abc', kind: 'permission', prompt: 'Open Chrome and sign in' },
    });
    if (events[0]?.type === 'interaction_request') {
      expect(events[0].payload.choices.map((c) => c.id)).toEqual(['allow_once', 'deny', 'always_allow']);
    }
    expect(pending.has('gb-abc')).toBe(true);
    expect(mapApprovalDelta([card], pending)).toEqual([]);
  });

  it('emits interaction_resolved auto when a pending card disappears', () => {
    const pending = new Set<string>();
    mapApprovalDelta([card], pending);
    const gone = mapApprovalDelta([], pending);
    expect(gone).toEqual([{
      type: 'interaction_resolved',
      payload: { requestId: 'gb-abc', selection: [], resolution: 'auto' },
    }]);
    expect(pending.size).toBe(0);
  });
});

describe('mapQuestionDelta', () => {
  const card = {
    cardId: 'gbq-abc',
    prompt: 'What would you most like me to help with?',
    choices: [
      { id: 'A', label: 'A Email and calendar' },
      { id: 'B', label: 'B Coding and debugging' },
      { id: 'dismiss', label: 'Dismiss' },
    ],
    allowFreeText: true as const,
  };

  it('emits interaction_request kind=question with allowFreeText', () => {
    const pending = new Set<string>();
    const events = mapQuestionDelta([card], pending);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'interaction_request',
      payload: {
        requestId: 'gbq-abc',
        kind: 'question',
        prompt: 'What would you most like me to help with?',
        allowFreeText: true,
      },
    });
    if (events[0]?.type === 'interaction_request') {
      expect(events[0].payload.choices.map((c) => c.id)).toEqual(['A', 'B', 'dismiss']);
    }
    expect(pending.has('gbq-abc')).toBe(true);
    expect(mapQuestionDelta([card], pending)).toEqual([]);
  });

  it('emits interaction_resolved auto when a pending question card disappears', () => {
    const pending = new Set<string>();
    mapQuestionDelta([card], pending);
    const gone = mapQuestionDelta([], pending);
    expect(gone).toEqual([{
      type: 'interaction_resolved',
      payload: { requestId: 'gbq-abc', selection: [], resolution: 'auto' },
    }]);
    expect(pending.size).toBe(0);
  });
});

describe('mapReplicaDelta includeUser', () => {
  const userRow = { id: 'u1', kind: 'message', role: 'user', content: 'from my phone' };
  const botRow = { id: 'a1', kind: 'send-message', message: { type: 'text', content: 'on it' } };

  it('still skips user rows by default (live adapter path)', () => {
    const out = mapReplicaDelta([userRow, botRow], new Set());
    expect(out).toEqual([{ type: 'message', payload: { chunk: 'on it', final: true } }]);
  });

  it('emits a prompt event for user rows when includeUser is set', () => {
    const out = mapReplicaDelta([userRow, botRow], new Set(), { includeUser: true });
    expect(out).toEqual([
      { type: 'prompt', payload: { text: 'from my phone' } },
      { type: 'message', payload: { chunk: 'on it', final: true } },
    ]);
  });

  it('ignores non-user message rows and blank user text', () => {
    const out = mapReplicaDelta(
      [
        { id: 'u2', kind: 'message', role: 'assistant', content: 'echo' },
        { id: 'u3', kind: 'message', role: 'user', content: '   ' },
      ],
      new Set(),
      { includeUser: true },
    );
    expect(out).toEqual([]);
  });

  it('marks user rows as seen so a re-map does not duplicate them', () => {
    const seen = new Set<string>();
    mapReplicaDelta([userRow], seen, { includeUser: true });
    expect(mapReplicaDelta([userRow], seen, { includeUser: true })).toEqual([]);
  });
});
