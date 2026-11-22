import { describe, it, expect } from 'vitest';
import { buildTranscript } from './transcript.js';
import type { TranscriptEvent } from '@tierwyn/shared';

function ev(partial: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    id: Math.random().toString(36), sessionId: 's', type: 'message',
    payload: {}, sender: 'agent', seq: 0, ts: 0, ...partial,
  };
}

describe('buildTranscript', () => {
  it('renders prompts and messages into labelled lines', () => {
    const events: TranscriptEvent[] = [
      ev({ type: 'prompt', sender: 'user', payload: { text: 'do X' } }),
      ev({ type: 'message', sender: 'agent', payload: { chunk: 'done X', final: true } }),
      ev({ type: 'tool_call', sender: 'agent', payload: { name: 'Bash', input: { command: 'ls' } } }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000 });
    expect(text).toContain('USER: do X');
    expect(text).toContain('ASSISTANT: done X');
    expect(text).toContain('TOOL(Bash)');
  });

  it('labels subagent_notify prompts as SUBAGENT, not USER', () => {
    const events: TranscriptEvent[] = [
      ev({
        type: 'prompt',
        sender: 'system',
        payload: {
          text: 'Sub-agent (Composer) result:\n\nshipped',
          source: 'subagent_notify',
          subagent: { role: 'Composer', childConversationId: 'c-2' },
        },
      }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000 });
    expect(text).toContain('SUBAGENT (Composer):');
    expect(text).not.toContain('USER: Sub-agent');
  });

  it('labels peer_message prompts as PEER, not USER (L-8)', () => {
    const events: TranscriptEvent[] = [
      ev({
        type: 'prompt',
        sender: 'system',
        payload: {
          text: 'hello from a sibling',
          source: 'peer_message',
          subagent: { role: 'impl', childConversationId: 'c-sib' },
        },
      }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000 });
    expect(text).toContain('PEER (impl):');
    expect(text).toContain('hello from a sibling');
    expect(text).not.toContain('USER: hello from a sibling');
  });

  it('labels parent_message prompts as PARENT, not USER (L-8)', () => {
    const events: TranscriptEvent[] = [
      ev({
        type: 'prompt',
        sender: 'system',
        payload: {
          text: 'status please',
          source: 'parent_message',
          subagent: { role: 'orchestrator', childConversationId: 'c-child' },
        },
      }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000 });
    expect(text).toContain('PARENT (orchestrator):');
    expect(text).not.toContain('USER: status please');
  });

  it('sanitises SUBAGENT role tokens that contain <, newlines, or other unsafe chars (P3/F3)', () => {
    const events: TranscriptEvent[] = [
      ev({
        type: 'prompt',
        sender: 'system',
        payload: {
          text: 'shipped',
          source: 'subagent_notify',
          subagent: { role: 'impl<script>\ninject', childConversationId: 'c-2' },
        },
      }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000 });
    expect(text).toContain('SUBAGENT (implscriptinject):');
    expect(text).not.toContain('<script>');
    expect(text).not.toMatch(/SUBAGENT \([^\)]*\n/);
  });

  it('preserves tool results in full (no 500-char cap)', () => {
    // Regression: tool_result bodies used to be sliced to 500 chars, shredding
    // large file reads before the next agent ever saw them during handoff.
    const longBody = 'y'.repeat(5_000);
    const events: TranscriptEvent[] = [
      ev({ type: 'tool_call', sender: 'agent', payload: { name: 'Read', input: {} } }),
      ev({ type: 'tool_result', sender: 'agent', payload: { toolUseId: 't1', content: longBody, isError: false } }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000 });
    expect(text).toContain(`TOOL_RESULT: ${longBody}`);
    expect(text.length).toBeGreaterThan(5_000);
  });

  it('compactToolIo trims tool_result bodies and reduces tool_call to name + primary arg', () => {
    const longBody = 'y'.repeat(5_000);
    const events: TranscriptEvent[] = [
      ev({ type: 'tool_call', sender: 'agent', payload: { name: 'Read', input: { file_path: '/a/b.ts', limit: 200 } } }),
      ev({ type: 'tool_result', sender: 'agent', payload: { toolUseId: 't1', content: longBody, isError: false } }),
    ];
    const verbatim = buildTranscript(events, { maxTokens: 10_000 });
    const compacted = buildTranscript(events, { maxTokens: 10_000, compactToolIo: true });

    // tool_call: intent preserved (name + path), full JSON dropped.
    expect(compacted).toContain('TOOL(Read): file_path=/a/b.ts');
    expect(compacted).not.toContain('limit');
    // tool_result: truncated with an elision marker; far smaller than verbatim.
    expect(compacted).toContain('chars elided');
    expect(compacted).not.toContain(longBody);
    expect(compacted.length).toBeLessThan(700);
    expect(verbatim.length).toBeGreaterThan(5_000); // default path still verbatim
  });

  it('proseOnly keeps only prompt/message lines and drops tools/files/errors', () => {
    const events: TranscriptEvent[] = [
      ev({ type: 'prompt', sender: 'user', payload: { text: 'fix the bug' } }),
      ev({ type: 'message', sender: 'agent', payload: { chunk: 'looking at it', final: true } }),
      ev({ type: 'tool_call', sender: 'agent', payload: { name: 'Read', input: { file_path: '/a.ts' } } }),
      ev({ type: 'tool_result', sender: 'agent', payload: { toolUseId: 't1', content: 'secret tool body', isError: false } }),
      ev({ type: 'file_change', sender: 'agent', payload: { kind: 'modified', path: '/a.ts' } }),
      ev({ type: 'error', sender: 'agent', payload: { message: 'boom' } }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000, proseOnly: true });
    expect(text).toContain('USER: fix the bug');
    expect(text).toContain('ASSISTANT: looking at it');
    expect(text).not.toContain('TOOL(Read)');
    expect(text).not.toContain('secret tool body');
    expect(text).not.toContain('FILE');
    expect(text).not.toContain('ERROR');
  });

  it('proseOnly still applies the tail token cap', () => {
    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(ev({ type: 'prompt', sender: 'user', payload: { text: `msg-${i}-${'x'.repeat(80)}` } }));
    }
    const text = buildTranscript(events, { maxTokens: 50, proseOnly: true });
    expect(text).toContain('[earlier history truncated]');
    expect(text).toContain('msg-19');
    expect(text).not.toContain('msg-0-');
  });

  it('compactToolIo leaves prompt/message/file_change high-signal events untouched', () => {
    const events: TranscriptEvent[] = [
      ev({ type: 'prompt', sender: 'user', payload: { text: 'fix the tabs' } }),
      ev({ type: 'message', sender: 'agent', payload: { chunk: 'looking into it', final: true } }),
      ev({ type: 'file_change', sender: 'agent', payload: { kind: 'modified', path: '/x.ts' } }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000, compactToolIo: true });
    expect(text).toContain('USER: fix the tabs');
    expect(text).toContain('ASSISTANT: looking into it');
    expect(text).toContain('FILE modified: /x.ts');
  });

  it('truncates to the most recent events when over the token budget', () => {
    const events: TranscriptEvent[] = Array.from({ length: 50 }, (_, i) =>
      ev({ type: 'message', sender: 'agent', payload: { chunk: `line ${i} ` + 'x'.repeat(40), final: true } })
    );
    const text = buildTranscript(events, { maxTokens: 30 });
    expect(text).toContain('line 49');     // newest kept
    expect(text).not.toContain('line 0 '); // oldest dropped
    expect(text.startsWith('[earlier history truncated]')).toBe(true);
  });

  it('attributes operator shell tool_call/result as OPERATOR SHELL, never TOOL(shell)', () => {
    const events: TranscriptEvent[] = [
      ev({
        type: 'tool_call',
        sender: 'user',
        payload: { name: 'shell', toolUseId: 'x', input: { command: 'make test' } },
      }),
      ev({
        type: 'tool_result',
        sender: 'system',
        payload: { toolUseId: 'x', content: 'ok', isError: false },
      }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000 });
    expect(text).toContain('OPERATOR SHELL');
    expect(text).toContain('NOT by you, the agent');
    expect(text).toContain('$ make test');
    expect(text).toContain('OPERATOR SHELL OUTPUT:');
    expect(text).toContain('ok');
    expect(text).not.toContain('TOOL(shell)');
    expect(text).not.toContain('TOOL_RESULT: ok');
  });

  it('leaves non-shell tool_call/result as TOOL(...) / TOOL_RESULT (regression)', () => {
    const events: TranscriptEvent[] = [
      ev({
        type: 'tool_call',
        sender: 'agent',
        payload: { name: 'Read', toolUseId: 'y', input: { file_path: '/a' } },
      }),
      ev({
        type: 'tool_result',
        sender: 'agent',
        payload: { toolUseId: 'y', content: 'file body', isError: false },
      }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000 });
    expect(text).toContain('TOOL(Read)');
    expect(text).toContain('TOOL_RESULT: file body');
    expect(text).not.toContain('OPERATOR SHELL');
  });

  it('compactToolIo truncates shell output under OPERATOR SHELL OUTPUT, not TOOL_RESULT', () => {
    const longBody = 'z'.repeat(5_000);
    const events: TranscriptEvent[] = [
      ev({
        type: 'tool_call',
        sender: 'user',
        payload: { name: 'shell', toolUseId: 's1', input: { command: 'cat big.log' } },
      }),
      ev({
        type: 'tool_result',
        sender: 'system',
        payload: { toolUseId: 's1', content: longBody, isError: false },
      }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000, compactToolIo: true });
    expect(text).toContain('OPERATOR SHELL');
    expect(text).toContain('OPERATOR SHELL OUTPUT:');
    expect(text).toContain('chars elided');
    expect(text).not.toContain('TOOL(shell)');
    expect(text).not.toContain('TOOL_RESULT:');
    expect(text).not.toContain(longBody);
  });

  it('interleaves shell pair with agent tool without bleeding shell attribution', () => {
    const events: TranscriptEvent[] = [
      ev({ type: 'message', sender: 'agent', payload: { chunk: 'running checks', final: true } }),
      ev({
        type: 'tool_call',
        sender: 'user',
        payload: { name: 'shell', toolUseId: 'shell-1', input: { command: 'ls -la' } },
      }),
      ev({
        type: 'tool_result',
        sender: 'system',
        payload: { toolUseId: 'shell-1', content: 'file1\nfile2', isError: false },
      }),
      ev({
        type: 'tool_call',
        sender: 'agent',
        payload: { name: 'Bash', toolUseId: 'agent-1', input: { command: 'pwd' } },
      }),
      ev({
        type: 'tool_result',
        sender: 'agent',
        payload: { toolUseId: 'agent-1', content: '/tmp', isError: false },
      }),
    ];
    const text = buildTranscript(events, { maxTokens: 10_000 });
    expect(text).toContain('ASSISTANT: running checks');
    expect(text).toContain('OPERATOR SHELL');
    expect(text).toContain('$ ls -la');
    expect(text).toContain('OPERATOR SHELL OUTPUT:');
    expect(text).toContain('TOOL(Bash)');
    expect(text).toContain('TOOL_RESULT: /tmp');
    expect(text).not.toContain('TOOL(shell)');
    // Agent result must stay TOOL_RESULT, not operator-labelled
    expect(text).not.toMatch(/OPERATOR SHELL OUTPUT:\n\/tmp/);
  });
});
