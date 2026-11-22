import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { SubagentTailerSet } from './subagentTail.js';
import type { PartialEvent } from './mapping.js';

const SUB_CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PARENT_ID = 'agy:parent-conv:4';

function launch(dir: string, convId = SUB_CONV) {
  return {
    type_name: 'research',
    role: 'Lister',
    initial_prompt: 'run ls',
    conversation_id: convId,
    logPath: path.join(dir, convId, 'transcript.jsonl'),
  };
}

describe('SubagentTailerSet', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tierwyn-agy-subtail-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits nested tool_call + message from transcript.jsonl with parentToolUseId', async () => {
    const convDir = path.join(dir, SUB_CONV);
    mkdirSync(convDir);
    const log = path.join(convDir, 'transcript.jsonl');
    writeFileSync(log, [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'ls please' }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"' } }],
      }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'file listing follows',
      }),
      '',
    ].join('\n'));

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 40 });
    set.ensure(launch(dir), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));
    set.stopAll();

    const types = emitted.map((e) => e.type);
    expect(types).toEqual(['tool_call', 'message', 'tool_result']);
    expect(emitted[2]).toMatchObject({
      type: 'tool_result',
      payload: { toolUseId: PARENT_ID, content: 'subagent Lister finished', isError: false },
    });
    expect(emitted[0]).toMatchObject({
      type: 'tool_call',
      payload: {
        name: 'run_command',
        parentToolUseId: PARENT_ID,
        toolUseId: `agy:sub:${SUB_CONV}:1`,
      },
    });
    expect(emitted[1]).toMatchObject({
      type: 'message',
      payload: { chunk: 'file listing follows', parentToolUseId: PARENT_ID },
    });
  });

  it('picks up lines appended after the first poll', async () => {
    const convDir = path.join(dir, SUB_CONV);
    mkdirSync(convDir);
    const log = path.join(convDir, 'transcript.jsonl');
    writeFileSync(log, '');

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 40 });
    set.ensure(launch(dir), PARENT_ID);

    await new Promise((r) => setTimeout(r, 50));
    expect(emitted).toEqual([]);

    appendFileSync(log, JSON.stringify({
      step_index: 29, type: 'MODEL_RESPONSE', status: 'DONE', content: 'done listing',
    }) + '\n');
    await new Promise((r) => setTimeout(r, 80));
    set.stopAll();

    expect(emitted).toEqual([{
      type: 'message',
      payload: { chunk: 'done listing', final: false, parentToolUseId: PARENT_ID },
    }, {
      type: 'tool_result',
      payload: { toolUseId: PARENT_ID, content: 'subagent Lister finished', isError: false },
    }]);
  });

  it('tolerates a missing transcript and gives up after missingMs', async () => {
    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({
      emit: (e) => emitted.push(e),
      pollMs: 30,
      missingMs: 80,
    });
    set.ensure(launch(dir), PARENT_ID);
    expect(set.activeCount).toBe(1);
    await new Promise((r) => setTimeout(r, 140));
    expect(set.activeCount).toBe(0);
    expect(emitted).toEqual([]);
    // stopAll on a given-up tailer still closes the parent card.
    set.stopAll();
    expect(emitted).toEqual([{
      type: 'tool_result',
      payload: { toolUseId: PARENT_ID, content: 'subagent Lister finished', isError: false },
    }]);
  });

  it('stopAll clears the interval so later file writes emit nothing', async () => {
    const convDir = path.join(dir, SUB_CONV);
    mkdirSync(convDir);
    const log = path.join(convDir, 'transcript.jsonl');
    writeFileSync(log, '');

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 30 });
    set.ensure(launch(dir), PARENT_ID);
    set.stopAll();
    expect(set.activeCount).toBe(0);

    appendFileSync(log, JSON.stringify({
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'late',
    }) + '\n');
    await new Promise((r) => setTimeout(r, 80));
    // Interval cleared: the late line is not read; the card close from stopAll stands.
    expect(emitted).toEqual([{
      type: 'tool_result',
      payload: { toolUseId: PARENT_ID, content: 'subagent Lister finished', isError: false },
    }]);
  });

  it('tails two subagents independently', async () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    for (const id of [a, b]) {
      mkdirSync(path.join(dir, id));
      writeFileSync(path.join(dir, id, 'transcript.jsonl'), JSON.stringify({
        step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: id,
      }) + '\n');
    }
    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 40 });
    set.ensure(launch(dir, a), PARENT_ID);
    set.ensure(launch(dir, b), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));
    set.stopAll();

    const chunks = emitted
      .filter((e) => e.type === 'message')
      .map((e) => (e as { payload: { chunk: string } }).payload.chunk)
      .sort();
    expect(chunks).toEqual([a, b]);
    // Both subagents share PARENT_ID — one grouped closing tool_result.
    const closes = emitted.filter((e) => e.type === 'tool_result');
    expect(closes).toEqual([{
      type: 'tool_result',
      payload: {
        toolUseId: PARENT_ID,
        content: '2 subagents finished: Lister, Lister',
        isError: false,
      },
    }]);
  });

  it('stopAll reads remaining lines then stops the tailer', async () => {
    const convDir = path.join(dir, SUB_CONV);
    mkdirSync(convDir);
    const log = path.join(convDir, 'transcript.jsonl');
    writeFileSync(log, '');

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 10_000 });
    set.ensure(launch(dir), PARENT_ID);
    appendFileSync(log, JSON.stringify({
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'final',
    }) + '\n');
    set.stopAll();
    expect(set.activeCount).toBe(0);
    expect(emitted).toEqual([{
      type: 'message',
      payload: { chunk: 'final', final: false, parentToolUseId: PARENT_ID },
    }, {
      type: 'tool_result',
      payload: { toolUseId: PARENT_ID, content: 'subagent Lister finished', isError: false },
    }]);
  });

  it('parses a last transcript line that has no trailing newline on stopAll', () => {
    const convDir = path.join(dir, SUB_CONV);
    mkdirSync(convDir);
    writeFileSync(
      path.join(convDir, 'transcript.jsonl'),
      JSON.stringify({ step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'no nl' }),
    );
    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 10_000 });
    set.ensure(launch(dir), PARENT_ID);
    set.stopAll();
    expect(emitted).toEqual([{
      type: 'message',
      payload: { chunk: 'no nl', final: false, parentToolUseId: PARENT_ID },
    }, {
      type: 'tool_result',
      payload: { toolUseId: PARENT_ID, content: 'subagent Lister finished', isError: false },
    }]);
  });

  const CHILD = '11111111-aaaa-bbbb-cccc-111111111111';
  const GRAND = '22222222-aaaa-bbbb-cccc-222222222222';

  function writeTranscript(convId: string, lines: unknown[]): string {
    const convDir = path.join(dir, convId);
    mkdirSync(convDir, { recursive: true });
    const log = path.join(convDir, 'transcript.jsonl');
    writeFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return log;
  }

  function nestedInvokeStep(_fromConv: string, toConv: string, role: string) {
    const logUri = `file://${path.join(dir, toConv, 'transcript.jsonl')}`;
    return {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{
        name: 'invoke_subagent',
        args: {
          type_name: '"research"',
          role: `"${role}"`,
          initial_prompt: '"go deeper"',
          conversation_id: `"${toConv}"`,
          log_uri: `"${logUri}"`,
        },
      }],
      subagent_info: {
        subagents: [{
          type_name: 'research',
          role,
          initial_prompt: 'go deeper',
          conversation_id: toConv,
          log_uri: logUri,
        }],
      },
    };
  }

  it('tails a 2-level tree: grandchild events nest under the child invoke, stopAll closes deepest-first', async () => {
    writeTranscript(GRAND, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"echo hi"' } }],
      },
      {
        step_index: 5,
        type: 'MODEL_RESPONSE',
        status: 'DONE',
        content: 'grandchild says hi',
      },
    ]);
    writeTranscript(CHILD, [nestedInvokeStep(CHILD, GRAND, 'Nested')]);

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 40 });
    set.ensure(launch(dir, CHILD), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));
    set.stopAll();

    const childInvokeId = `agy:sub:${CHILD}:1`;
    const grandchildCall = emitted.find((e) =>
      e.type === 'tool_call' && (e.payload as { name?: string }).name === 'run_command',
    );
    expect(grandchildCall).toMatchObject({
      type: 'tool_call',
      payload: { name: 'run_command', parentToolUseId: childInvokeId },
    });
    const grandchildMsg = emitted.find((e) =>
      e.type === 'message' && (e.payload as { chunk?: string }).chunk === 'grandchild says hi',
    );
    expect(grandchildMsg).toMatchObject({
      type: 'message',
      payload: { chunk: 'grandchild says hi', parentToolUseId: childInvokeId },
    });

    const childInvoke = emitted.find((e) =>
      e.type === 'tool_call' && (e.payload as { name?: string }).name === 'invoke_subagent',
    );
    expect(childInvoke).toMatchObject({
      type: 'tool_call',
      payload: {
        toolUseId: childInvokeId,
        name: 'invoke_subagent',
        parentToolUseId: PARENT_ID,
        input: { subagent_type: 'research', conversation_id: GRAND },
      },
    });

    const closeIds = emitted
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    const idxChild = closeIds.indexOf(childInvokeId);
    const idxParent = closeIds.indexOf(PARENT_ID);
    expect(idxChild).toBeGreaterThan(-1);
    expect(idxParent).toBeGreaterThan(-1);
    expect(idxChild).toBeLessThan(idxParent);
    expect(set.activeCount).toBe(0);
  });

  it('depth-caps a 5th nested launch: no 5th interval, invoke_subagent still emitted', async () => {
    const ids = [
      '00000000-0000-0000-0000-000000000000',
      '11111111-0000-0000-0000-000000000001',
      '22222222-0000-0000-0000-000000000002',
      '33333333-0000-0000-0000-000000000003',
      '44444444-0000-0000-0000-000000000004',
    ];
    // Leaf first so each parent can point at an existing path.
    writeTranscript(ids[4], [{
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'leaf-4',
    }]);
    for (let i = 3; i >= 0; i--) {
      writeTranscript(ids[i], [nestedInvokeStep(ids[i], ids[i + 1], `L${i + 1}`)]);
    }

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 40 });
    set.ensure(launch(dir, ids[0]), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));

    // Top-level is depth 0; nested ensure is parentDepth+1; maxDepth default 4
    // allows depths 0..3 (four tailers). The 5th launch (ids[4]) is not tailed.
    expect(set.activeCount).toBe(4);

    const invokes = emitted.filter((e) =>
      e.type === 'tool_call' && (e.payload as { name?: string }).name === 'invoke_subagent',
    );
    // ids[0] transcript launches ids[1], … ids[3] launches ids[4] — four invoke cards.
    expect(invokes.length).toBe(4);
    const fifthConv = invokes.some((e) =>
      (e.payload as { input?: { conversation_id?: string } }).input?.conversation_id === ids[4],
    );
    expect(fifthConv).toBe(true);

    const leaf = emitted.some((e) =>
      e.type === 'message' && (e.payload as { chunk?: string }).chunk === 'leaf-4',
    );
    expect(leaf).toBe(false);

    set.stopAll();
    expect(set.activeCount).toBe(0);

    const fifthInvokeId = `agy:sub:${ids[3]}:1`;
    const closeIds = emitted
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    expect(closeIds).toContain(fifthInvokeId);
    expect(closeIds.indexOf(fifthInvokeId)).toBeLessThan(closeIds.indexOf(PARENT_ID));
  });

  it('stopAll then append to grandchild file emits nothing (nested interval leak)', async () => {
    const grandLog = writeTranscript(GRAND, [{
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'early',
    }]);
    writeTranscript(CHILD, [nestedInvokeStep(CHILD, GRAND, 'Nested')]);

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 30 });
    set.ensure(launch(dir, CHILD), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));
    set.stopAll();
    expect(set.activeCount).toBe(0);
    const n = emitted.length;

    appendFileSync(grandLog, JSON.stringify({
      step_index: 9, type: 'MODEL_RESPONSE', status: 'DONE', content: 'late-grandchild',
    }) + '\n');
    await new Promise((r) => setTimeout(r, 80));
    expect(emitted).toHaveLength(n);
    expect(emitted.some((e) =>
      e.type === 'message' && (e.payload as { chunk?: string }).chunk === 'late-grandchild',
    )).toBe(false);
    expect(set.activeCount).toBe(0);
  });

  it('missingMs on a grandchild transcript gives up that tailer; parent still closes on stopAll', async () => {
    writeTranscript(CHILD, [nestedInvokeStep(CHILD, GRAND, 'Nested')]);
    // Grandchild logPath is set but the file is never created.

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({
      emit: (e) => emitted.push(e),
      pollMs: 30,
      missingMs: 80,
    });
    set.ensure(launch(dir, CHILD), PARENT_ID);
    await new Promise((r) => setTimeout(r, 50));
    // Child file exists (stays active) + grandchild missing (still within missingMs).
    expect(set.activeCount).toBe(2);
    await new Promise((r) => setTimeout(r, 120));
    // Grandchild gave up; child transcript is present so its interval remains.
    expect(set.activeCount).toBe(1);

    set.stopAll();
    expect(set.activeCount).toBe(0);
    const closeIds = emitted
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    expect(closeIds).toContain(PARENT_ID);
    expect(closeIds).toContain(`agy:sub:${CHILD}:1`);
    expect(closeIds.indexOf(`agy:sub:${CHILD}:1`)).toBeLessThan(closeIds.indexOf(PARENT_ID));
  });

  it('stopAll then append to both child and grandchild files emits nothing', async () => {
    const grandLog = writeTranscript(GRAND, [{
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'early-g',
    }]);
    const childLog = writeTranscript(CHILD, [nestedInvokeStep(CHILD, GRAND, 'Nested')]);

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 30 });
    set.ensure(launch(dir, CHILD), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));
    set.stopAll();
    expect(set.activeCount).toBe(0);
    const n = emitted.length;

    appendFileSync(childLog, JSON.stringify({
      step_index: 9, type: 'MODEL_RESPONSE', status: 'DONE', content: 'late-child',
    }) + '\n');
    appendFileSync(grandLog, JSON.stringify({
      step_index: 9, type: 'MODEL_RESPONSE', status: 'DONE', content: 'late-grandchild',
    }) + '\n');
    await new Promise((r) => setTimeout(r, 80));
    expect(emitted).toHaveLength(n);
    expect(emitted.some((e) =>
      e.type === 'message' && (e.payload as { chunk?: string }).chunk === 'late-child',
    )).toBe(false);
    expect(emitted.some((e) =>
      e.type === 'message' && (e.payload as { chunk?: string }).chunk === 'late-grandchild',
    )).toBe(false);
    expect(set.activeCount).toBe(0);
  });

  it('duplicate conversation_id ensure no-ops; second invoke card still closes on stopAll', async () => {
    const sibA = 'aaaa1111-aaaa-bbbb-cccc-111111111111';
    const sibB = 'bbbb2222-aaaa-bbbb-cccc-222222222222';
    writeTranscript(GRAND, [{
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'shared-grand',
    }]);
    writeTranscript(sibA, [nestedInvokeStep(sibA, GRAND, 'FromA')]);
    writeTranscript(sibB, [nestedInvokeStep(sibB, GRAND, 'FromB')]);

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 40 });
    set.ensure(launch(dir, sibA), PARENT_ID);
    set.ensure(launch(dir, sibB), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));
    // Two siblings + one shared grandchild (second ensure of GRAND no-ops).
    expect(set.activeCount).toBe(3);
    set.stopAll();
    expect(set.activeCount).toBe(0);

    const invokeA = `agy:sub:${sibA}:1`;
    const invokeB = `agy:sub:${sibB}:1`;
    const closeIds = emitted
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    expect(closeIds).toContain(invokeA);
    expect(closeIds).toContain(invokeB);
    expect(closeIds).toContain(PARENT_ID);
  });

  it('same conversation_id cycle does not grow tailers and still closes the nested card', async () => {
    writeTranscript(CHILD, [nestedInvokeStep(CHILD, CHILD, 'Loop')]);

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 40 });
    set.ensure(launch(dir, CHILD), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));
    expect(set.activeCount).toBe(1);
    set.stopAll();
    expect(set.activeCount).toBe(0);
    const nestedId = `agy:sub:${CHILD}:1`;
    const closeIds = emitted
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    expect(closeIds).toContain(nestedId);
    expect(closeIds).toContain(PARENT_ID);
  });

  it('nested launch discovered on stopAll final tick is flushed and does not leak', () => {
    const convDir = path.join(dir, CHILD);
    mkdirSync(convDir, { recursive: true });
    const childLog = path.join(convDir, 'transcript.jsonl');
    writeFileSync(childLog, '');
    writeTranscript(GRAND, [{
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'from-stopall',
    }]);

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 10_000 });
    set.ensure(launch(dir, CHILD), PARENT_ID);
    appendFileSync(childLog, JSON.stringify(nestedInvokeStep(CHILD, GRAND, 'Late')) + '\n');
    set.stopAll();
    expect(set.activeCount).toBe(0);
    expect(emitted.some((e) =>
      e.type === 'message' && (e.payload as { chunk?: string }).chunk === 'from-stopall',
    )).toBe(true);
    const childInvokeId = `agy:sub:${CHILD}:1`;
    const closeIds = emitted
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    expect(closeIds.indexOf(childInvokeId)).toBeGreaterThan(-1);
    expect(closeIds.indexOf(childInvokeId)).toBeLessThan(closeIds.indexOf(PARENT_ID));
  });

  it('emit throw during tick does not leak the interval; stopAll still clears', async () => {
    writeTranscript(CHILD, [{
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'boom-msg',
    }]);
    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({
      emit: (e) => {
        emitted.push(e);
        if (e.type === 'message') throw new Error('emit boom');
      },
      pollMs: 30,
    });
    set.ensure(launch(dir, CHILD), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));
    set.stopAll();
    expect(set.activeCount).toBe(0);
    expect(emitted.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('missingSince is not reset on later ticks of a still-missing file', async () => {
    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({
      emit: (e) => emitted.push(e),
      pollMs: 25,
      missingMs: 70,
    });
    set.ensure(launch(dir), PARENT_ID);
    expect(set.activeCount).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(set.activeCount).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(set.activeCount).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(set.activeCount).toBe(0);
    set.stopAll();
  });

  it('truncated transcript rereads from 0 without re-emitting seen steps', async () => {
    const convDir = path.join(dir, SUB_CONV);
    mkdirSync(convDir);
    const log = path.join(convDir, 'transcript.jsonl');
    writeFileSync(log, JSON.stringify({
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'first',
    }) + '\n');

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 30 });
    set.ensure(launch(dir), PARENT_ID);
    await new Promise((r) => setTimeout(r, 50));
    const firstCount = emitted.filter((e) => e.type === 'message').length;
    expect(firstCount).toBe(1);

    writeFileSync(log, [
      JSON.stringify({ step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'first' }),
      JSON.stringify({ step_index: 2, type: 'MODEL_RESPONSE', status: 'DONE', content: 'second' }),
      '',
    ].join('\n'));
    await new Promise((r) => setTimeout(r, 80));
    set.stopAll();
    const msgs = emitted
      .filter((e) => e.type === 'message')
      .map((e) => (e.payload as { chunk: string }).chunk);
    expect(msgs.filter((c) => c === 'first')).toHaveLength(1);
    expect(msgs).toContain('second');
  });

  it('readFileSync throw on a directory logPath does not kill later stopAll', async () => {
    const convDir = path.join(dir, SUB_CONV);
    mkdirSync(convDir);
    // logPath points at the directory itself — readFileSync throws EISDIR.
    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 30 });
    set.ensure({
      ...launch(dir),
      logPath: convDir,
    }, PARENT_ID);
    await new Promise((r) => setTimeout(r, 50));
    set.stopAll();
    expect(set.activeCount).toBe(0);
    expect(emitted).toEqual([{
      type: 'tool_result',
      payload: { toolUseId: PARENT_ID, content: 'subagent Lister finished', isError: false },
    }]);
  });

  it('fan-out: two nested launches in one step get 1:1 tailers and both cards close', async () => {
    const g1 = 'g1111111-aaaa-bbbb-cccc-111111111111';
    const g2 = 'g2222222-aaaa-bbbb-cccc-222222222222';
    writeTranscript(g1, [{
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'g1-hi',
    }]);
    writeTranscript(g2, [{
      step_index: 1, type: 'MODEL_RESPONSE', status: 'DONE', content: 'g2-hi',
    }]);
    const log1 = `file://${path.join(dir, g1, 'transcript.jsonl')}`;
    const log2 = `file://${path.join(dir, g2, 'transcript.jsonl')}`;
    writeTranscript(CHILD, [{
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            type_name: '"research"',
            role: '"One"',
            initial_prompt: '"a"',
            conversation_id: `"${g1}"`,
            log_uri: `"${log1}"`,
          },
        },
        { name: 'run_command', args: { CommandLine: '"echo x"' } },
      ],
      subagent_info: {
        subagents: [
          { type_name: 'research', role: 'One', initial_prompt: 'a', conversation_id: g1, log_uri: log1 },
          { type_name: 'research', role: 'Two', initial_prompt: 'b', conversation_id: g2, log_uri: log2 },
        ],
      },
    }]);

    const emitted: PartialEvent[] = [];
    const set = new SubagentTailerSet({ emit: (e) => emitted.push(e), pollMs: 40 });
    set.ensure(launch(dir, CHILD), PARENT_ID);
    await new Promise((r) => setTimeout(r, 80));
    // child + two grandchildren
    expect(set.activeCount).toBe(3);
    set.stopAll();
    expect(set.activeCount).toBe(0);

    const chunks = emitted
      .filter((e) => e.type === 'message')
      .map((e) => (e.payload as { chunk: string }).chunk)
      .sort();
    expect(chunks).toEqual(['g1-hi', 'g2-hi']);
    const invokeIds = emitted
      .filter((e) => e.type === 'tool_call' && (e.payload as { name?: string }).name === 'invoke_subagent')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    expect(invokeIds).toHaveLength(2);
    const closeIds = emitted
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    for (const id of invokeIds) expect(closeIds).toContain(id);
  });
});
