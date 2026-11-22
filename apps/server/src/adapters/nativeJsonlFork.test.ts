import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { forkClaudeJsonl, isRealUserPrompt, exciseTurnFromJsonl } from './nativeJsonlFork.js';

describe('forkClaudeJsonl', () => {
  let home: string;
  let nativeId: string;
  let projectDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tierwyn-jsonl-'));
    nativeId = 'sess-original';
    projectDir = join(home, 'projects', 'proj');
    mkdirSync(projectDir, { recursive: true });

    const lines = [
      { type: 'queue-operation', sessionId: nativeId },
      {
        type: 'user',
        sessionId: nativeId,
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
      },
      {
        type: 'assistant',
        sessionId: nativeId,
        uuid: 'a1',
        parentUuid: 'u1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer1' }] },
      },
      {
        type: 'user',
        sessionId: nativeId,
        uuid: 'u2',
        parentUuid: 'a1',
        message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
      },
      {
        type: 'assistant',
        sessionId: nativeId,
        uuid: 'a2',
        parentUuid: 'u2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer2' }] },
      },
    ];
    writeFileSync(join(projectDir, `${nativeId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps prefix through the toTurn-th user turn and preserves parentUuid chain', async () => {
    const newId = await forkClaudeJsonl(home, nativeId, 1);
    expect(newId).not.toBe(nativeId);
    expect(existsSync(join(projectDir, `${newId}.jsonl`))).toBe(true);

    const kept = readFileSync(join(projectDir, `${newId}.jsonl`), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(kept).toHaveLength(3);
    expect(kept.filter((l) => isRealUserPrompt(l))).toHaveLength(1);
    expect(kept[2]).toMatchObject({ type: 'assistant', parentUuid: 'u1' });
    for (const line of kept) {
      if ('sessionId' in line) expect(line.sessionId).toBe(newId);
    }
    expect(kept.some((l) => l.uuid === 'u2')).toBe(false);
  });
});

// v2 surgical-excision tests. Fixture: 3 user turns where turn 2 contains a
// tool_use + tool_result pair, and turn 3 follows a steer-bearing user
// message (steers count as user prompts in isRealUserPrompt, so this verifies
// the counting alignment between client deleteTurnIndex and the helper).
describe('exciseTurnFromJsonl', () => {
  let home: string;
  let nativeId: string;
  let projectDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tierwyn-jsonl-excise-'));
    nativeId = 'sess-excise';
    projectDir = join(home, 'projects', 'proj');
    mkdirSync(projectDir, { recursive: true });

    // Layout (uuids chosen to be human-traceable):
    //   queue-op  q0   parent=null          (preamble, not a user prompt)
    //   user      u1   parent=null          ← turn 1 prompt
    //   assistant a1   parent=u1            ← turn 1 reply
    //   user      u2   parent=a1            ← turn 2 prompt
    //   assistant a2   parent=u2            ← turn 2 assistant text (with tool_use)
    //   user      ur   parent=a2   tool_result  ← tool_result wrapper (NOT a user prompt)
    //   assistant a2b  parent=ur            ← turn 2 final assistant text after tool
    //   user      u3   parent=a2b           ← turn 3 prompt (the steer-bearing turn)
    //   assistant a3   parent=u3            ← turn 3 reply
    const lines = [
      { type: 'queue-operation', sessionId: nativeId, uuid: 'q0' },
      { type: 'user', sessionId: nativeId, uuid: 'u1', parentUuid: null,
        message: { role: 'user', content: [{ type: 'text', text: 'turn one' }] } },
      { type: 'assistant', sessionId: nativeId, uuid: 'a1', parentUuid: 'u1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply one' }] } },
      { type: 'user', sessionId: nativeId, uuid: 'u2', parentUuid: 'a1',
        message: { role: 'user', content: [{ type: 'text', text: 'turn two' }] } },
      { type: 'assistant', sessionId: nativeId, uuid: 'a2', parentUuid: 'u2',
        message: { role: 'assistant', content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } },
        ] } },
      { type: 'user', sessionId: nativeId, uuid: 'ur', parentUuid: 'a2',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }] } },
      { type: 'assistant', sessionId: nativeId, uuid: 'a2b', parentUuid: 'ur',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply two final' }] } },
      { type: 'user', sessionId: nativeId, uuid: 'u3', parentUuid: 'a2b',
        message: { role: 'user', content: [{ type: 'text', text: 'turn three' }] } },
      { type: 'assistant', sessionId: nativeId, uuid: 'a3', parentUuid: 'u3',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply three' }] } },
    ];
    writeFileSync(join(projectDir, `${nativeId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function readExcised(id: string): Record<string, unknown>[] {
    return readFileSync(join(projectDir, `${id}.jsonl`), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('middle-turn excision: rewires chain, keeps turns 1 + 3, tool pair stays together', async () => {
    const newId = await exciseTurnFromJsonl(home, nativeId, 2);
    expect(newId).not.toBe(nativeId);
    const kept = readExcised(newId);

    // Preamble + turn1 (2) + turn3 (2) = 5 lines. Turn 2's 4 lines (u2,a2,ur,a2b) gone.
    expect(kept).toHaveLength(5);
    // Surviving user prompts = turn 1 + turn 3.
    expect(kept.filter((l) => isRealUserPrompt(l))).toHaveLength(2);

    // Tool pair from turn 2 must NOT leak into the kept file.
    expect(kept.some((l) => l.uuid === 'a2')).toBe(false);
    expect(kept.some((l) => l.uuid === 'ur')).toBe(false);
    expect(kept.some((l) => l.uuid === 'a2b')).toBe(false);
    expect(kept.some((l) => l.uuid === 'u2')).toBe(false);

    // Chain rewire: the line after the gap is u3 (the next user prompt).
    // Its parentUuid must now point at the last surviving line BEFORE the gap,
    // which is a1 (the last assistant of turn 1).
    const u3 = kept.find((l) => l.uuid === 'u3');
    expect(u3).toBeDefined();
    expect(u3!.parentUuid).toBe('a1');

    // The rest of the chain (q0→? none, u1→null, a1→u1, a3→u3) is intact.
    const u1 = kept.find((l) => l.uuid === 'u1');
    const a1 = kept.find((l) => l.uuid === 'a1');
    const a3 = kept.find((l) => l.uuid === 'a3');
    expect(u1!.parentUuid).toBeNull();
    expect(a1!.parentUuid).toBe('u1');
    expect(a3!.parentUuid).toBe('u3');

    // Every kept line carries the new sessionId.
    for (const line of kept) {
      if ('sessionId' in line) expect(line.sessionId).toBe(newId);
    }

    // Original file untouched.
    expect(existsSync(join(projectDir, `${nativeId}.jsonl`))).toBe(true);
    expect(readExcised(nativeId)).toHaveLength(9);
  });

  it('last-turn excision: delegates to forkClaudeJsonl (clean prefix, no rewire)', async () => {
    const newId = await exciseTurnFromJsonl(home, nativeId, 3);
    expect(newId).not.toBe(nativeId);
    const kept = readExcised(newId);

    // Preamble + turn1 (2) + turn2 (4) = 7 lines. Turn 3's 2 lines gone.
    expect(kept).toHaveLength(7);
    expect(kept.filter((l) => isRealUserPrompt(l))).toHaveLength(2);
    // No rewire happened: u3/a3 simply absent, a2b (turn 2 last) keeps its real parent.
    const a2b = kept.find((l) => l.uuid === 'a2b');
    expect(a2b!.parentUuid).toBe('ur');
    expect(kept.some((l) => l.uuid === 'u3')).toBe(false);
    expect(kept.some((l) => l.uuid === 'a3')).toBe(false);
  });

  it('first-turn excision: beforeTail is the preamble, afterHead parent rewired to it', async () => {
    const newId = await exciseTurnFromJsonl(home, nativeId, 1);
    const kept = readExcised(newId);

    // Preamble (q0) + turn2 (4) + turn3 (2) = 7 lines. Turn 1's 2 lines gone.
    expect(kept).toHaveLength(7);
    expect(kept.filter((l) => isRealUserPrompt(l))).toHaveLength(2);
    // The first surviving user prompt (u2) now parents to the preamble line q0.
    const u2 = kept.find((l) => l.uuid === 'u2');
    expect(u2!.parentUuid).toBe('q0');
    expect(kept.some((l) => l.uuid === 'u1')).toBe(false);
    expect(kept.some((l) => l.uuid === 'a1')).toBe(false);
  });

  it('first-turn excision with no preamble: afterHead.parentUuid set to null', async () => {
    // Rewrite the file without the queue-operation preamble so startLine === 0
    // and beforeTail is genuinely null.
    const lines = readExcised(nativeId).filter((l) => l.uuid !== 'q0')
      .map((l) => { const c = { ...l }; c.sessionId = nativeId; return c; });
    writeFileSync(join(projectDir, `${nativeId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const newId = await exciseTurnFromJsonl(home, nativeId, 1);
    const kept = readExcised(newId);

    expect(kept).toHaveLength(6); // turn2 (4) + turn3 (2)
    const u2 = kept.find((l) => l.uuid === 'u2');
    expect(u2!.parentUuid).toBeNull();
  });

  it('single-turn file: rejected with a clear error', async () => {
    // Overwrite with a single-turn file.
    const single = [
      { type: 'user', sessionId: nativeId, uuid: 'su', parentUuid: null,
        message: { role: 'user', content: [{ type: 'text', text: 'only' }] } },
      { type: 'assistant', sessionId: nativeId, uuid: 'sa', parentUuid: 'su',
        message: { role: 'assistant', content: [{ type: 'text', text: 'only reply' }] } },
    ];
    writeFileSync(join(projectDir, `${nativeId}.jsonl`), single.map((l) => JSON.stringify(l)).join('\n') + '\n');

    await expect(exciseTurnFromJsonl(home, nativeId, 1)).rejects.toThrow(/single-turn|delete the conversation/i);
    // No fork file produced.
    expect(existsSync(join(projectDir, `${nativeId}.jsonl`))).toBe(true);
  });

  it('out-of-range turn: rejected', async () => {
    await expect(exciseTurnFromJsonl(home, nativeId, 4)).rejects.toThrow(/out of range/i);
    await expect(exciseTurnFromJsonl(home, nativeId, 0)).rejects.toThrow(/>= 1/i);
  });

  it('missing native file: rejected', async () => {
    await expect(exciseTurnFromJsonl(home, 'never-existed', 1)).rejects.toThrow(/not found/);
  });
});
