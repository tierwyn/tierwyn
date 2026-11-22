import { describe, it, expect } from 'vitest';
import type { TranscriptEvent } from '@tierwyn/shared';
import { renderConversationMarkdown, exportFilename } from './conversationExport.js';

const META = {
  title: 'Ship the export button',
  conversationId: 'conv-1234abcd-ef',
  projectId: 'proj-1',
  projectName: 'Tierwyn',
  createdAt: Date.UTC(2026, 7, 20, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 10, 30, 0),
  exportedAt: Date.UTC(2026, 7, 21, 12, 0, 0),
};

let seq = 0;
function ev(type: string, payload: Record<string, unknown>, ts = 1000): TranscriptEvent {
  seq += 1;
  return {
    id: `e${seq}`, sessionId: 's1', type: type as TranscriptEvent['type'],
    payload, sender: 'agent', seq, ts,
  };
}

describe('renderConversationMarkdown — header', () => {
  it('starts with the title as an h1 and lists conversation + project metadata', () => {
    const md = renderConversationMarkdown(META, []);
    expect(md.startsWith('# Ship the export button\n')).toBe(true);
    expect(md).toContain('- **Conversation:** `conv-1234abcd-ef`');
    expect(md).toContain('- **Project:** Tierwyn (`proj-1`)');
    expect(md).toContain('- **Created:** 2026-08-20T09:00:00.000Z');
    expect(md).toContain('- **Updated:** 2026-08-21T10:30:00.000Z');
    expect(md).toContain('- **Exported:** 2026-08-21T12:00:00.000Z');
  });

  it('omits the description line when there is no description', () => {
    expect(renderConversationMarkdown(META, [])).not.toContain('**Description:**');
  });

  it('includes the description line when set', () => {
    const md = renderConversationMarkdown({ ...META, description: 'FW-9 work' }, []);
    expect(md).toContain('- **Description:** FW-9 work');
  });

  it('renders a header-only document for an empty transcript', () => {
    const md = renderConversationMarkdown(META, []);
    expect(md).not.toContain('## User');
    expect(md).not.toContain('## Agent');
    expect(md.trim().endsWith('---')).toBe(true);
  });
});

describe('renderConversationMarkdown — messages', () => {
  it('labels prompts User and message chunks Agent, in event order', () => {
    const md = renderConversationMarkdown(META, [
      ev('prompt', { text: 'first question' }, 100),
      ev('message', { chunk: 'partial ' }, 101),
      ev('message', { chunk: 'answer' }, 102),
      ev('prompt', { text: 'second question' }, 103),
      ev('message', { chunk: 'second answer' }, 104),
    ]);
    expect(md).toContain('## User\n\nfirst question');
    expect(md).toContain('## Agent\n\npartial answer');
    expect(md).toContain('## User\n\nsecond question');
    expect(md.indexOf('first question')).toBeLessThan(md.indexOf('partial answer'));
    expect(md.indexOf('partial answer')).toBeLessThan(md.indexOf('second question'));
    expect(md.indexOf('second question')).toBeLessThan(md.indexOf('second answer'));
  });

  it('coalesces consecutive chunks into one Agent block', () => {
    const md = renderConversationMarkdown(META, [
      ev('message', { chunk: 'a' }), ev('message', { chunk: 'b' }), ev('message', { chunk: 'c' }),
    ]);
    expect(md.match(/## Agent/g)).toHaveLength(1);
    expect(md).toContain('## Agent\n\nabc');
  });

  it('labels a subagent_notify prompt as a subagent result, not User', () => {
    const md = renderConversationMarkdown(META, [
      ev('prompt', { text: 'child finished', source: 'subagent_notify' }),
    ]);
    expect(md).toContain('## Subagent result');
    expect(md).toContain('child finished');
    expect(md).not.toContain('## User');
  });

  it('labels a parent_message prompt as Parent message, not User', () => {
    const md = renderConversationMarkdown(META, [
      ev('prompt', { text: 'from ancestor', source: 'parent_message' }),
    ]);
    expect(md).toContain('## Parent message');
    expect(md).toContain('from ancestor');
    expect(md).not.toContain('## User');
  });

  it('does not emit an Agent block for whitespace-only chunks', () => {
    const md = renderConversationMarkdown(META, [
      ev('message', { chunk: '   \n ' }),
    ]);
    expect(md).not.toContain('## Agent');
  });

  it('labels steer events', () => {
    const md = renderConversationMarkdown(META, [ev('steer', { text: 'stop that' })]);
    expect(md).toContain('## Steer\n\nstop that');
  });
});

describe('exportFilename', () => {
  it('slugifies the title and appends an id fragment', () => {
    expect(exportFilename('Ship the Export Button!', 'abcd1234-ef56')).toBe('ship-the-export-button-abcd1234.md');
  });

  it('falls back to "conversation" when the title has no ascii word characters', () => {
    expect(exportFilename('🚀🚀', 'abcd1234-ef56')).toBe('conversation-abcd1234.md');
  });

  it('caps a very long title', () => {
    const name = exportFilename('x'.repeat(200), 'abcd1234-ef56');
    expect(name.length).toBeLessThanOrEqual(60 + 1 + 8 + 3);
    expect(name.endsWith('-abcd1234.md')).toBe(true);
  });
});

describe('renderConversationMarkdown — tools and non-prose events', () => {
  it('summarises a tool call on one line instead of dumping its input JSON', () => {
    const md = renderConversationMarkdown(META, [
      ev('tool_call', { name: 'Bash', input: { command: 'npm run typecheck', timeout: 120000 } }),
    ]);
    expect(md).toContain('- **Tool** `Bash` — `npm run typecheck`');
    expect(md).not.toContain('timeout');
    expect(md).not.toContain('{\n');
  });

  it('truncates a long tool preview and collapses newlines', () => {
    const md = renderConversationMarkdown(META, [
      ev('tool_call', { name: 'Bash', input: { command: `line1\nline2 ${'y'.repeat(300)}` } }),
    ]);
    const line = md.split('\n').find((l) => l.startsWith('- **Tool** `Bash`'))!;
    expect(line.length).toBeLessThan(160);
    expect(line).toContain('line1 line2');
    expect(line).toContain('…');
  });

  it('prefers file_path when there is no command', () => {
    const md = renderConversationMarkdown(META, [
      ev('tool_call', { name: 'Read', input: { file_path: '/tmp/a.ts' } }),
    ]);
    expect(md).toContain('- **Tool** `Read` — `/tmp/a.ts`');
  });

  it('omits successful tool results but keeps errored ones', () => {
    const md = renderConversationMarkdown(META, [
      ev('tool_result', { content: 'lots of stdout nobody needs' }),
      ev('tool_result', { content: 'ENOENT: missing file', isError: true }),
    ]);
    expect(md).not.toContain('lots of stdout');
    expect(md).toContain('- **Tool error** — ENOENT: missing file');
  });

  it('renders file changes with counts when present', () => {
    const md = renderConversationMarkdown(META, [
      ev('file_change', { kind: 'modified', path: 'src/a.ts', additions: 3, deletions: 1 }),
      ev('file_change', { kind: 'created', path: 'src/b.ts' }),
    ]);
    expect(md).toContain('- **File modified** `src/a.ts` (+3 -1)');
    expect(md).toContain('- **File created** `src/b.ts`');
  });

  it('omits the count suffix when additions is not a number', () => {
    const md = renderConversationMarkdown(META, [
      ev('file_change', { kind: 'modified', path: 'src/c.ts', additions: null }),
    ]);
    expect(md).toContain('- **File modified** `src/c.ts`');
    expect(md).not.toContain('+null');
  });

  it('renders error events', () => {
    const md = renderConversationMarkdown(META, [ev('error', { message: 'adapter died' })]);
    expect(md).toContain('- **Error** adapter died');
  });

  it('omits status events, interactions and AskUserQuestion calls', () => {
    const md = renderConversationMarkdown(META, [
      ev('status', { status: 'running' }),
      ev('interaction_request', { kind: 'permission', prompt: 'allow?' }),
      ev('tool_call', { name: 'AskUserQuestion', input: { questions: [] } }),
    ]);
    expect(md).not.toContain('running');
    expect(md).not.toContain('allow?');
    expect(md).not.toContain('AskUserQuestion');
  });

  it('omits the hidden spawn curl call and its result', () => {
    const md = renderConversationMarkdown(META, [
      ev('tool_call', { name: 'Bash', input: { command: 'curl -s -X POST http://127.0.0.1:8788/spawn -d @x' } }),
      ev('tool_result', { content: '{"parentConversationId":"p1","childConversationId":"c1"}' }),
    ]);
    expect(md).not.toContain('/spawn');
    expect(md).not.toContain('parentConversationId');
  });

  it('flushes the agent buffer before a tool line so ordering is preserved', () => {
    const md = renderConversationMarkdown(META, [
      ev('message', { chunk: 'thinking' }),
      ev('tool_call', { name: 'Bash', input: { command: 'ls' } }),
      ev('message', { chunk: 'done' }),
    ]);
    expect(md.indexOf('thinking')).toBeLessThan(md.indexOf('- **Tool**'));
    expect(md.indexOf('- **Tool**')).toBeLessThan(md.indexOf('done'));
    expect(md.match(/## Agent/g)).toHaveLength(2);
  });
});
