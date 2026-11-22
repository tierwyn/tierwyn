import { describe, it, expect } from 'vitest';
import { mapAgyChunk, mapAgyFrame, AgyStreamMapper, agySubagentLaunches, AgySubagentTranscriptMapper, agyTranscriptSubagentLaunches } from './mapping.js';

describe('mapAgyChunk', () => {
  it('maps a non-empty text line to a non-final message chunk with trailing newline', () => {
    const result = mapAgyChunk('Hello from Antigravity');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'message',
      payload: { chunk: 'Hello from Antigravity\n', final: false },
    });
  });

  it('returns [] for an empty line', () => {
    expect(mapAgyChunk('')).toEqual([]);
  });

  it('maps a whitespace-only line (non-empty) to a message chunk', () => {
    // Lines that contain spaces are non-empty — only truly empty strings are dropped.
    const result = mapAgyChunk('  ');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('message');
  });

  it('preserves content exactly (no trimming)', () => {
    const result = mapAgyChunk('  leading and trailing  ');
    expect(result[0]).toEqual({
      type: 'message',
      payload: { chunk: '  leading and trailing  \n', final: false },
    });
  });

  describe('banner / arg-echo filtering', () => {
    // Regression: agy v1.0.8 prints a security banner to stdout that contains
    // the literal --dangerously-skip-permissions flag name. Without filtering,
    // the banner became assistant message content and users saw the flag
    // "injected into the prompt".

    it('drops a bare line containing only the flag name', () => {
      expect(mapAgyChunk('--dangerously-skip-permissions')).toEqual([]);
    });

    it('drops a short warning line that mentions the flag', () => {
      expect(mapAgyChunk('[warning] running with --dangerously-skip-permissions')).toEqual([]);
      expect(mapAgyChunk('warning: --dangerously-skip-permissions is active')).toEqual([]);
    });

    it('drops short generic warning/banner prefixes even without the flag', () => {
      expect(mapAgyChunk('Warning: agy is starting up')).toEqual([]);
      expect(mapAgyChunk('NOTE: this conversation is sandboxed')).toEqual([]);
      expect(mapAgyChunk('info: initializing')).toEqual([]);
    });

    it('does NOT drop long model output that happens to mention the flag', () => {
      // A real model response discussing the flag should pass through.
      const longLine =
        'To run agy without permission prompts you can pass --dangerously-skip-permissions as a CLI flag, ' +
        'but be aware this bypasses all tool permission checks and should only be used in trusted environments.';
      const result = mapAgyChunk(longLine);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('message');
    });

    it('does NOT drop code-block-style content mentioning the flag', () => {
      // Fenced code often contains indented flag names; these must survive.
      const codeLine = '  agy --print --dangerously-skip-permissions "do the thing"  ';
      const result = mapAgyChunk(codeLine);
      expect(result).toHaveLength(1);
    });
  });
});

const CONV = 'db192107-47ee-4c72-9f68-dabcca03d531';

describe('mapAgyFrame (agy 1.1.8+ stream-json)', () => {
  it('drops init, user_input, checkpoint, and empty agent_response', () => {
    expect(mapAgyFrame({
      event: 'init',
      conversation_id: CONV,
      init: { cwd: '/tmp', tools: ['run_command'], permission_mode: 'always-proceed' },
    })).toEqual([]);
    expect(mapAgyFrame({
      event: 'step_update',
      step_update: { conversation_id: CONV, step_index: 0, state: 'DONE', step_type: 'user_input' },
    })).toEqual([]);
    expect(mapAgyFrame({
      event: 'step_update',
      step_update: { conversation_id: CONV, step_index: 1, state: 'DONE', step_type: 'checkpoint' },
    })).toEqual([]);
    expect(mapAgyFrame({
      event: 'step_update',
      step_update: { conversation_id: CONV, step_index: 2, state: 'DONE', step_type: 'agent_response' },
    })).toEqual([]);
  });

  it('maps agent_response text_delta to a non-final message chunk', () => {
    expect(mapAgyFrame({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 4,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'OK\n',
      },
    })).toEqual([{ type: 'message', payload: { chunk: 'OK\n', final: false } }]);
  });

  it('maps an ACTIVE run_command step to tool_call', () => {
    expect(mapAgyFrame({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo tierwyn-agy-stream-probe' } },
      },
    })).toEqual([{
      type: 'tool_call',
      payload: {
        toolUseId: `agy:${CONV}:3`,
        name: 'run_command',
        input: { CommandLine: 'echo tierwyn-agy-stream-probe' },
      },
    }]);
  });

  it('maps a DONE run_command step to tool_call + tool_result', () => {
    const out = mapAgyFrame({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 3,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'echo tierwyn-agy-stream-probe' },
          output: 'tierwyn-agy-stream-probe\r\n',
        },
      },
    });
    expect(out).toEqual([
      {
        type: 'tool_call',
        payload: {
          toolUseId: `agy:${CONV}:3`,
          name: 'run_command',
          input: { CommandLine: 'echo tierwyn-agy-stream-probe' },
        },
      },
      {
        type: 'tool_result',
        payload: { toolUseId: `agy:${CONV}:3`, content: 'tierwyn-agy-stream-probe\r\n', isError: false },
      },
    ]);
  });

  it('defers ACTIVE write_to_file tool_call until DONE (path-only stream-json)', () => {
    const out = mapAgyFrame({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 7,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: { name: 'write_to_file', parameters: { TargetFile: '/tmp/a.ts', Contents: 'x' } },
      },
    });
    expect(out).toEqual([]);
  });

  it('maps DONE write_to_file without error to tool_call + file_change created + tool_result', () => {
    const out = mapAgyFrame({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 7,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: { name: 'write_to_file', parameters: { TargetFile: '/tmp/a.ts', Contents: 'x' }, output: 'wrote' },
      },
    });
    expect(out.find((e) => e.type === 'file_change')).toEqual({
      type: 'file_change',
      payload: { path: '/tmp/a.ts', kind: 'created', toolUseId: `agy:${CONV}:7` },
    });
    expect(out.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('synthesizes tool_result content when a successful file edit has empty output', () => {
    const out = mapAgyFrame({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 8,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'replace_file_content',
        tool_info: { name: 'replace_file_content', parameters: { TargetFile: '/tmp/b.ts' }, output: '' },
      },
    });
    expect(out.find((e) => e.type === 'tool_result')?.payload).toEqual({
      toolUseId: `agy:${CONV}:8`, content: 'Modified /tmp/b.ts', isError: false,
    });
  });

  it('maps replace_file_content to file_change modified and delete_file to deleted', () => {
    const replace = mapAgyFrame({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 8,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'replace_file_content',
        tool_info: { name: 'replace_file_content', parameters: { TargetFile: '/tmp/a.ts' } },
      },
    });
    expect(replace.find((e) => e.type === 'file_change')).toEqual({
      type: 'file_change',
      payload: { path: '/tmp/a.ts', kind: 'modified', toolUseId: `agy:${CONV}:8` },
    });

    const del = mapAgyFrame({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 9,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'delete_file',
        tool_info: { name: 'delete_file', parameters: { TargetFile: '/tmp/a.ts' } },
      },
    });
    expect(del.find((e) => e.type === 'file_change')).toEqual({
      type: 'file_change',
      payload: { path: '/tmp/a.ts', kind: 'deleted', toolUseId: `agy:${CONV}:9` },
    });
  });

  it('maps tool_info.error to an error tool_result', () => {
    const out = mapAgyFrame({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 5,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'false' },
          error: { type: 'COMMAND_FAILED', message: 'exit 1' },
        },
      },
    });
    expect(out.find((e) => e.type === 'tool_result')).toEqual({
      type: 'tool_result',
      payload: { toolUseId: `agy:${CONV}:5`, content: 'exit 1', isError: true },
    });
  });

  it('maps a SUCCESS result to message final + status done with usage', () => {
    expect(mapAgyFrame({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'SUCCESS',
        response: 'OK\n',
        usage: { input_tokens: 50234, output_tokens: 180, cache_read_tokens: 0, thinking_tokens: 113 },
      },
    })).toEqual([
      { type: 'message', payload: { chunk: '', final: true } },
      {
        type: 'status',
        payload: { status: 'done', inputTokens: 50234, outputTokens: 180, cacheReadTokens: 0 },
      },
    ]);
  });

  it('maps an ERROR result to error + status error', () => {
    expect(mapAgyFrame({
      event: 'result',
      result: { conversation_id: CONV, status: 'ERROR', response: '', error: 'invalid model selection' },
    })).toEqual([
      { type: 'error', payload: { message: 'invalid model selection' } },
      { type: 'status', payload: { status: 'error' } },
    ]);
  });

  it('maps USER_CANCELLED stop_reason to operator_interrupt on the terminal status', () => {
    const out = mapAgyFrame({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'ERROR',
        response: '',
        error: 'cancelled',
        stop_reason: 'USER_CANCELLED',
      },
    });
    expect(out).toEqual([
      { type: 'error', payload: { message: 'cancelled' } },
      { type: 'status', payload: { status: 'error', cause: 'operator_interrupt' } },
    ]);
  });

  it('maps TURN_LIMIT stop_reason to turn_limit on SUCCESS done', () => {
    const out = mapAgyFrame({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'SUCCESS',
        response: 'OK\n',
        stop_reason: 'TURN_LIMIT',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0 },
      },
    });
    expect(out).toEqual([
      { type: 'message', payload: { chunk: '', final: true } },
      { type: 'status', payload: { status: 'done', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cause: 'turn_limit' } },
    ]);
  });

  it('maps BUDGET_EXCEEDED stop_reason to budget_exceeded on SUCCESS done', () => {
    const out = mapAgyFrame({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'SUCCESS',
        response: 'OK\n',
        stop_reason: 'BUDGET_EXCEEDED',
      },
    });
    expect(out).toEqual([
      { type: 'message', payload: { chunk: '', final: true } },
      { type: 'status', payload: { status: 'done', cause: 'budget_exceeded' } },
    ]);
  });

  it('omits cause when stop_reason is unknown or missing', () => {
    expect(mapAgyFrame({
      event: 'result',
      result: { conversation_id: CONV, status: 'SUCCESS', response: 'OK\n', stop_reason: 'SOMETHING_ELSE' },
    })).toEqual([
      { type: 'message', payload: { chunk: '', final: true } },
      { type: 'status', payload: { status: 'done' } },
    ]);
    expect(mapAgyFrame({
      event: 'result',
      result: { conversation_id: CONV, status: 'SUCCESS', response: 'OK\n' },
    })[1].payload).not.toHaveProperty('cause');
  });

  it('emits error listing string denied_actions on SUCCESS without flipping status to error', () => {
    const out = mapAgyFrame({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'SUCCESS',
        response: 'OK\n',
        denied_actions: ['run_command: rm -rf', 'delete_file: /etc/hosts'],
      },
    });
    const err = out.find((e) => e.type === 'error');
    expect(err?.type).toBe('error');
    const message = (err as { payload: { message: string } }).payload.message;
    expect(message).toMatch(/run_command: rm -rf/);
    expect(message).toMatch(/delete_file: \/etc\/hosts/);
    expect(out.find((e) => e.type === 'status')).toEqual({
      type: 'status',
      payload: { status: 'done' },
    });
  });

  it('formats object-shaped denied_actions using tool/name/action plus command/path', () => {
    const out = mapAgyFrame({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'SUCCESS',
        response: 'OK\n',
        denied_actions: [
          { tool: 'run_command', command: 'rm -rf /' },
          { name: 'delete_file', path: '/etc/hosts' },
          { action: 'write_to_file' },
          { foo: 'bar', extra: 1 },
        ],
      },
    });
    const message = (out.find((e) => e.type === 'error') as { payload: { message: string } }).payload.message;
    expect(message).toMatch(/run_command: rm -rf \//);
    expect(message).toMatch(/delete_file: \/etc\/hosts/);
    expect(message).toMatch(/write_to_file/);
    expect(message).toMatch(/\{"foo":"bar","extra":1\}/);
  });

  it('folds denied_actions into the existing ERROR message without dropping result.error', () => {
    const out = mapAgyFrame({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'ERROR',
        response: '',
        error: 'invalid model selection',
        denied_actions: ['run_command: rm -rf'],
      },
    });
    expect(out.map((e) => e.type)).toEqual(['error', 'status']);
    const message = (out[0] as { payload: { message: string } }).payload.message;
    expect(message).toMatch(/invalid model selection/);
    expect(message).toMatch(/run_command: rm -rf/);
    expect(out[1]).toEqual({ type: 'status', payload: { status: 'error' } });
  });

  it('stamps cause when both stop_reason and denied_actions are present', () => {
    const out = mapAgyFrame({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'SUCCESS',
        response: 'OK\n',
        stop_reason: 'BUDGET_EXCEEDED',
        denied_actions: ['run_command: rm -rf'],
      },
    });
    expect(out.some((e) => e.type === 'error')).toBe(true);
    expect(out.find((e) => e.type === 'status')).toEqual({
      type: 'status',
      payload: { status: 'done', cause: 'budget_exceeded' },
    });
  });

  it('does not emit a denial error when denied_actions is empty, missing, or not an array', () => {
    expect(mapAgyFrame({
      event: 'result',
      result: { conversation_id: CONV, status: 'SUCCESS', response: 'OK\n', denied_actions: [] },
    }).some((e) => e.type === 'error')).toBe(false);
    expect(mapAgyFrame({
      event: 'result',
      result: { conversation_id: CONV, status: 'SUCCESS', response: 'OK\n' },
    }).some((e) => e.type === 'error')).toBe(false);
    expect(mapAgyFrame({
      event: 'result',
      result: { conversation_id: CONV, status: 'SUCCESS', response: 'OK\n', denied_actions: 'run_command: rm -rf' },
    }).some((e) => e.type === 'error')).toBe(false);
  });

  it('returns [] for non-event objects', () => {
    expect(mapAgyFrame({ type: 'assistant', text: 'nope' })).toEqual([]);
  });

  const SUB_CONV = 'd7464f32-ee77-4ac3-bfce-1e4380cd9573';
  const SUBAGENT_ACTIVE = {
    event: 'step_update',
    step_update: {
      conversation_id: CONV,
      step_index: 4,
      state: 'ACTIVE',
      step_type: 'subagent',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [{
          type_name: 'research',
          role: 'File Summarizer',
          initial_prompt: 'Please read the file ...',
          conversation_id: SUB_CONV,
          log_uri: `file:///tmp/agy-sub/${SUB_CONV}/transcript.jsonl`,
        }],
      },
    },
  };
  const SUBAGENT_DONE = {
    event: 'step_update',
    step_update: {
      conversation_id: CONV,
      step_index: 4,
      state: 'DONE',
      step_type: 'subagent',
      tool_name: 'invoke_subagent',
      duration_seconds: 12.3,
      subagent_info: {
        subagents: [{
          type_name: 'research',
          role: 'File Summarizer',
          initial_prompt: 'Please read the file ...',
          conversation_id: SUB_CONV,
          log_uri: `file:///tmp/agy-sub/${SUB_CONV}/transcript.jsonl`,
        }],
      },
    },
  };

  it('maps an ACTIVE subagent step to invoke_subagent tool_call with stable id', () => {
    const out = mapAgyFrame(SUBAGENT_ACTIVE);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: 'tool_call',
      payload: {
        toolUseId: `agy:${CONV}:4`,
        name: 'invoke_subagent',
        input: {
          role: 'File Summarizer',
          type_name: 'research',
          initial_prompt: 'Please read the file ...',
          conversation_id: SUB_CONV,
          // web UI groups native subagents when input.subagent_type is set
          subagent_type: 'research',
          prompt: 'Please read the file ...',
        },
      },
    });
  });

  it('maps a DONE subagent step to only the (deduped downstream) tool_call — DONE means launch, not completion', () => {
    const out = mapAgyFrame(SUBAGENT_DONE);
    // agy marks the subagent step DONE at the spawn handshake; the card is
    // closed by SubagentTailerSet.stopAll() at parent-turn end instead.
    expect(out.map((e) => e.type)).toEqual(['tool_call']);
  });

  it('exposes subagent launches (log_uri stripped of file://) for tailing', () => {
    const launches = agySubagentLaunches(SUBAGENT_ACTIVE);
    expect(launches).toEqual({
      state: 'ACTIVE',
      parentConversationId: CONV,
      stepIndex: 4,
      parentToolUseId: `agy:${CONV}:4`,
      subagents: [{
        type_name: 'research',
        role: 'File Summarizer',
        initial_prompt: 'Please read the file ...',
        conversation_id: SUB_CONV,
        logPath: `/tmp/agy-sub/${SUB_CONV}/transcript.jsonl`,
      }],
    });
  });
});

describe('AgyStreamMapper', () => {
  it('dedups tool_call when ACTIVE is followed by DONE for the same step', () => {
    const mapper = new AgyStreamMapper();
    const active = mapper.map({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
      },
    });
    const done = mapper.map({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 3,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'echo hi' },
          output: 'hi\n',
        },
      },
    });
    expect(active.map((e) => e.type)).toEqual(['tool_call']);
    expect(done.map((e) => e.type)).toEqual(['tool_result']);
    expect(done[0]).toEqual({
      type: 'tool_result',
      payload: { toolUseId: `agy:${CONV}:3`, content: 'hi\n', isError: false },
    });
  });

  it('does not fail the turn when result is ERROR but a response was produced after a rejected write_to_file', () => {
    const mapper = new AgyStreamMapper();
    mapper.map({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: {
          name: 'write_to_file',
          parameters: { TargetFile: '/home/user/Projects/Test/mock_test_file.txt' },
        },
      },
    });
    const out = mapper.map({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'ERROR',
        response: 'The test operations have been completed:\n',
        error: 'declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) /home/user/Projects/Test/mock_test_file.txt is not a valid artifact path; artifacts must be in /home/user/.gemini/antigravity-cli/brain/9ee56cfe-1a5a-463b-a0f0-be063bbda446/',
        usage: { input_tokens: 47155, output_tokens: 1280, cache_read_tokens: 101806 },
      },
    });
    // ACTIVE file tools defer tool_call; recoverResult synthesizes it so the
    // error tool_result is not an orphan card.
    expect(out.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'message', 'status']);
    expect(out[0]).toMatchObject({
      type: 'tool_call',
      payload: { toolUseId: `agy:${CONV}:3`, name: 'write_to_file' },
    });
    expect(out[1]).toMatchObject({
      type: 'tool_result',
      payload: {
        toolUseId: `agy:${CONV}:3`,
        isError: true,
      },
    });
    expect(String((out[1] as { payload: { content: string } }).payload.content)).toMatch(/not a valid artifact path/);
    expect(out[1].type === 'tool_result' && out[1].payload.content).not.toMatch(/^declaring permissions:/);
    expect(out[3]).toEqual({
      type: 'status',
      payload: { status: 'done', inputTokens: 47155, outputTokens: 1280, cacheReadTokens: 101806 },
    });
  });

  it('stamps recoverResult terminal done with mapped stop_reason cause', () => {
    const mapper = new AgyStreamMapper();
    mapper.map({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: {
          name: 'write_to_file',
          parameters: { TargetFile: '/tmp/x.txt' },
        },
      },
    });
    const out = mapper.map({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'ERROR',
        response: 'Partial reply despite tool error\n',
        error: 'declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) /tmp/x.txt is not a valid artifact path',
        stop_reason: 'TURN_LIMIT',
        usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0 },
      },
    });
    const status = out.find((e) => e.type === 'status');
    expect(status).toEqual({
      type: 'status',
      payload: { status: 'done', inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cause: 'turn_limit' },
    });
  });

  it('does not drop denied_actions when recoverResult short-circuits mapResult', () => {
    const mapper = new AgyStreamMapper();
    mapper.map({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: {
          name: 'write_to_file',
          parameters: { TargetFile: '/tmp/x.txt' },
        },
      },
    });
    const out = mapper.map({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'ERROR',
        response: 'Partial reply despite tool error\n',
        error: 'declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) /tmp/x.txt is not a valid artifact path',
        denied_actions: ['run_command: rm -rf', 'delete_file: /etc/hosts'],
        usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0 },
      },
    });
    const err = out.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    const message = (err as { payload: { message: string } }).payload.message;
    expect(message).toMatch(/run_command: rm -rf/);
    expect(message).toMatch(/delete_file: \/etc\/hosts/);
    expect(out.find((e) => e.type === 'status')).toMatchObject({
      type: 'status',
      payload: { status: 'done' },
    });
  });

  it('treats transient retried API error (INTERNAL 500) as clean done when response is present', () => {
    const mapper = new AgyStreamMapper();
    const out = mapper.map({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'ERROR',
        response: 'All planned changes have been executed successfully.\n',
        error: 'API error (attempt 1): INTERNAL (code 500): Internal error encountered.',
        usage: { input_tokens: 1200, output_tokens: 45, cache_read_tokens: 0 },
      },
    });
    expect(out.some((e) => e.type === 'error')).toBe(false);
    expect(out).toEqual([
      { type: 'message', payload: { chunk: '', final: true } },
      {
        type: 'status',
        payload: { status: 'done', inputTokens: 1200, outputTokens: 45, cacheReadTokens: 0 },
      },
    ]);
  });

  it('recovers clean done when text_delta chunks were streamed before result frame with transient API error', () => {
    const mapper = new AgyStreamMapper();
    const chunkEvents = mapper.map({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 2,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'Streamed answer',
      },
    });
    expect(chunkEvents).toEqual([{ type: 'message', payload: { chunk: 'Streamed answer', final: false } }]);

    const resultEvents = mapper.map({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'ERROR',
        response: '',
        error: 'API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.',
        usage: { input_tokens: 500, output_tokens: 20, cache_read_tokens: 0 },
      },
    });
    expect(resultEvents.some((e) => e.type === 'error')).toBe(false);
    expect(resultEvents).toEqual([
      { type: 'message', payload: { chunk: '', final: true } },
      {
        type: 'status',
        payload: { status: 'done', inputTokens: 500, outputTokens: 20, cacheReadTokens: 0 },
      },
    ]);
  });

  it('does NOT swallow RESOURCE_EXHAUSTED quota error even with attempt count', () => {
    const mapper = new AgyStreamMapper();
    const out = mapper.map({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'ERROR',
        response: 'Some partial text before quota cut off',
        error: 'API error (attempt 8): RESOURCE_EXHAUSTED (code 429): Individual quota reached.',
        usage: { input_tokens: 500, output_tokens: 20, cache_read_tokens: 0 },
      },
    });
    expect(out.some((e) => e.type === 'error')).toBe(true);
    expect(out.find((e) => e.type === 'status')).toMatchObject({
      type: 'status',
      payload: { status: 'error' },
    });
  });

  it('preserves denied_actions when recovering transient retried API error', () => {
    const mapper = new AgyStreamMapper();
    const out = mapper.map({
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'ERROR',
        response: 'Done with warnings.\n',
        error: 'API error (attempt 1): INTERNAL (code 500): Internal error encountered.',
        denied_actions: ['run_command: rm -rf /'],
        usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0 },
      },
    });
    expect(out.some((e) => e.type === 'error')).toBe(true);
    const err = out.find((e) => e.type === 'error') as { payload: { message: string } };
    expect(err.payload.message).toMatch(/run_command: rm -rf \//);
    expect(out.find((e) => e.type === 'status')).toMatchObject({
      type: 'status',
      payload: { status: 'done' },
    });
  });

  it('dedups invoke_subagent tool_call when ACTIVE→DONE is re-emitted (DONE = launch, card closes via tailer stopAll)', () => {
    const mapper = new AgyStreamMapper();
    const SUB_CONV = 'd7464f32-ee77-4ac3-bfce-1e4380cd9573';
    const active = {
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'subagent',
        tool_name: 'invoke_subagent',
        subagent_info: {
          subagents: [{
            type_name: 'research',
            role: 'File Summarizer',
            initial_prompt: 'Please read the file ...',
            conversation_id: SUB_CONV,
            log_uri: `file:///tmp/agy-sub/${SUB_CONV}/transcript.jsonl`,
          }],
        },
      },
    };
    const done = {
      ...active,
      step_update: { ...active.step_update, state: 'DONE', duration_seconds: 0.087 },
    };
    expect(mapper.map(active).map((e) => e.type)).toEqual(['tool_call']);
    // DONE is the spawn handshake — no tool_result; the deduped tool_call is dropped.
    expect(mapper.map(done)).toEqual([]);
    expect(mapper.map(active)).toEqual([]);
  });
});

const SUB_CONV = 'd7464f32-ee77-4ac3-bfce-1e4380cd9573';
const PARENT_ID = `agy:${CONV}:4`;

describe('AgySubagentTranscriptMapper', () => {
  it('skips USER_INPUT and SYSTEM_MESSAGE', () => {
    const mapper = new AgySubagentTranscriptMapper(PARENT_ID, SUB_CONV);
    expect(mapper.map({
      step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>read it</USER_REQUEST>',
    })).toEqual([]);
    expect(mapper.map({
      step_index: 22, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'parent said hi',
    })).toEqual([]);
  });

  it('maps PLANNER_RESPONSE tool_calls to nested tool_call with parentToolUseId', () => {
    const mapper = new AgySubagentTranscriptMapper(PARENT_ID, SUB_CONV);
    const out = mapper.map({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{
        name: 'view_file',
        args: {
          AbsolutePath: '"/tmp/README.md"',
          toolAction: '"Reading README"',
          toolSummary: '"Read README"',
        },
      }],
    });
    expect(out).toEqual([{
      type: 'tool_call',
      payload: {
        toolUseId: `agy:sub:${SUB_CONV}:1`,
        name: 'view_file',
        input: { AbsolutePath: '/tmp/README.md', toolAction: 'Reading README', toolSummary: 'Read README' },
        parentToolUseId: PARENT_ID,
      },
    }]);
  });

  it('maps GENERIC content to tool_result of the preceding tool_call', () => {
    const mapper = new AgySubagentTranscriptMapper(PARENT_ID, SUB_CONV);
    mapper.map({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'list_dir', args: { DirectoryPath: '"/tmp"' } }],
    });
    const out = mapper.map({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:00Z\nfile.txt\n',
    });
    expect(out).toEqual([{
      type: 'tool_result',
      payload: {
        toolUseId: `agy:sub:${SUB_CONV}:1`,
        content: 'file.txt\n',
        isError: false,
        parentToolUseId: PARENT_ID,
      },
    }]);
  });

  it('maps PLANNER_RESPONSE / MODEL_RESPONSE content to a nested message', () => {
    const mapper = new AgySubagentTranscriptMapper(PARENT_ID, SUB_CONV);
    const planner = mapper.map({
      step_index: 29,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Here is the listing.',
    });
    expect(planner).toEqual([{
      type: 'message',
      payload: { chunk: 'Here is the listing.', final: false, parentToolUseId: PARENT_ID },
    }]);
    const model = mapper.map({
      step_index: 30,
      type: 'MODEL_RESPONSE',
      status: 'DONE',
      content: 'final prose',
    });
    expect(model).toEqual([{
      type: 'message',
      payload: { chunk: 'final prose', final: false, parentToolUseId: PARENT_ID },
    }]);
  });

  it('omits a tool_result when the transcript never supplies one', () => {
    const mapper = new AgySubagentTranscriptMapper(PARENT_ID, SUB_CONV);
    const out = mapper.map({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/tmp/secret"' } }],
    });
    expect(out.map((e) => e.type)).toEqual(['tool_call']);
    expect(mapper.map({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'blocked',
    }).map((e) => e.type)).toEqual(['message']);
  });

  it('does not close a nested invoke_subagent on a following GENERIC line', () => {
    const mapper = new AgySubagentTranscriptMapper(PARENT_ID, SUB_CONV);
    const nestedConv = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
    const launch = mapper.map({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{
        name: 'invoke_subagent',
        args: {
          type_name: '"research"',
          role: '"Nested"',
          initial_prompt: '"go deeper"',
          conversation_id: `"${nestedConv}"`,
          log_uri: `"file:///tmp/agy-sub/${nestedConv}/transcript.jsonl"`,
        },
      }],
      subagent_info: {
        subagents: [{
          type_name: 'research',
          role: 'Nested',
          initial_prompt: 'go deeper',
          conversation_id: nestedConv,
          log_uri: `file:///tmp/agy-sub/${nestedConv}/transcript.jsonl`,
        }],
      },
    });
    expect(launch).toEqual([{
      type: 'tool_call',
      payload: {
        toolUseId: `agy:sub:${SUB_CONV}:1`,
        name: 'invoke_subagent',
        input: {
          role: 'Nested',
          type_name: 'research',
          initial_prompt: 'go deeper',
          conversation_id: nestedConv,
          subagent_type: 'research',
          prompt: 'go deeper',
        },
        parentToolUseId: PARENT_ID,
      },
    }]);
    // agy marks invoke_subagent DONE at launch — GENERIC must not close the card.
    expect(mapper.map({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:00Z\nspawned\n',
    })).toEqual([]);
  });

  it('agyTranscriptSubagentLaunches prefers subagent_info and ignores tool_calls when info is non-empty', () => {
    const fromInfo = 'info-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const fromCall = 'call-aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
    const launches = agyTranscriptSubagentLaunches({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: { conversation_id: `"${fromCall}"`, role: '"Call"', type_name: '"research"', log_uri: '"file:///tmp/call.jsonl"' },
        },
        { name: 'run_command', args: { CommandLine: '"echo x"' } },
      ],
      subagent_info: {
        subagents: [
          { conversation_id: fromInfo, role: 'InfoA', type_name: 'research', log_uri: 'file:///tmp/a.jsonl' },
          { conversation_id: 'info-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', role: 'InfoB', type_name: 'research', log_uri: 'file:///tmp/b.jsonl' },
        ],
      },
    });
    expect(launches.map((l) => l.conversation_id)).toEqual([
      fromInfo,
      'info-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
    ]);
    expect(launches.every((l) => l.logPath.startsWith('/tmp/'))).toBe(true);
  });

  it('emits leftover info-only launches with :launchN ids next to a run_command', () => {
    const mapper = new AgySubagentTranscriptMapper(PARENT_ID, SUB_CONV);
    const a = 'aaaaaaaa-1111-2222-3333-444444444444';
    const b = 'bbbbbbbb-1111-2222-3333-444444444444';
    const out = mapper.map({
      step_index: 7,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: { conversation_id: `"${a}"`, role: '"One"', type_name: '"research"' },
        },
        { name: 'run_command', args: { CommandLine: '"echo x"' } },
      ],
      subagent_info: {
        subagents: [
          { conversation_id: a, role: 'One', type_name: 'research', log_uri: 'file:///tmp/a.jsonl' },
          { conversation_id: b, role: 'Two', type_name: 'research', log_uri: 'file:///tmp/b.jsonl' },
        ],
      },
    });
    const names = out.map((e) => (e.payload as { name?: string }).name);
    expect(names).toEqual(['invoke_subagent', 'run_command', 'invoke_subagent']);
    expect(out[0]).toMatchObject({
      type: 'tool_call',
      payload: { toolUseId: `agy:sub:${SUB_CONV}:7:0`, name: 'invoke_subagent' },
    });
    expect(out[1]).toMatchObject({
      type: 'tool_call',
      payload: { toolUseId: `agy:sub:${SUB_CONV}:7:1`, name: 'run_command' },
    });
    expect(out[2]).toMatchObject({
      type: 'tool_call',
      payload: {
        toolUseId: `agy:sub:${SUB_CONV}:7:launch1`,
        name: 'invoke_subagent',
        input: { conversation_id: b, role: 'Two' },
      },
    });
    // leftover invoke is not queued; GENERIC must not close it (or the first invoke).
    expect(mapper.map({
      step_index: 8,
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created At: x\nCompleted At: y\nok\n',
    })).toEqual([{
      type: 'tool_result',
      payload: {
        toolUseId: `agy:sub:${SUB_CONV}:7:1`,
        content: 'ok\n',
        isError: false,
        parentToolUseId: PARENT_ID,
      },
    }]);
  });
});
