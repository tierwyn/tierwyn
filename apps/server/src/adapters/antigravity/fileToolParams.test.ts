import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { AgyStreamMapper } from './mapping.js';
import {
  agyToolInputNeedsEnrichment,
  extractAgyFileToolParamsFromStepPayload,
  readAgyStepFileToolParams,
  enrichAgyMappedFileTools,
} from './fileToolParams.js';

describe('agyToolInputNeedsEnrichment', () => {
  it('is true for path-only TargetFile input', () => {
    expect(agyToolInputNeedsEnrichment({ TargetFile: '/tmp/a.ts' })).toBe(true);
  });

  it('is false when TargetContent + ReplacementContent are present', () => {
    expect(agyToolInputNeedsEnrichment({
      TargetFile: '/tmp/a.ts',
      TargetContent: 'old',
      ReplacementContent: 'new',
    })).toBe(false);
  });

  it('is false when CodeContent is present', () => {
    expect(agyToolInputNeedsEnrichment({
      TargetFile: '/tmp/a.ts',
      CodeContent: 'hello',
    })).toBe(false);
  });
});

describe('extractAgyFileToolParamsFromStepPayload', () => {
  it('pulls replace_file_content TargetContent/ReplacementContent from a protobuf-ish blob', () => {
    const payload = Buffer.from(
      'replace_file_content \x00\x01{"AllowMultiple":false,"TargetFile":"/tmp/a.ts","TargetContent":"old line","ReplacementContent":"new line","toolAction":"Edit a.ts"}',
      'utf8',
    );
    expect(extractAgyFileToolParamsFromStepPayload(payload)).toEqual({
      AllowMultiple: false,
      TargetFile: '/tmp/a.ts',
      TargetContent: 'old line',
      ReplacementContent: 'new line',
      toolAction: 'Edit a.ts',
    });
  });

  it('pulls write_to_file CodeContent from a step payload', () => {
    const payload = Buffer.from(
      'write_to_file {"CodeContent":" consoles.log(1)\\n","Description":"add file","Overwrite":true,"TargetFile":"/tmp/b.ts","toolSummary":"Write b.ts"}',
      'utf8',
    );
    expect(extractAgyFileToolParamsFromStepPayload(payload)).toMatchObject({
      CodeContent: ' consoles.log(1)\n',
      TargetFile: '/tmp/b.ts',
    });
  });

  it('returns null when the payload only has path metadata', () => {
    const payload = Buffer.from(
      'replace_file_content {"TargetFile":"/tmp/a.ts","toolAction":"Edit"}',
      'utf8',
    );
    expect(extractAgyFileToolParamsFromStepPayload(payload)).toBeNull();
  });
});

function seedStep(dir: string, id: string, idx: number, payload: string): void {
  const dbPath = path.join(dir, `${id}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      idx INTEGER PRIMARY KEY,
      step_payload BLOB
    );
  `);
  db.prepare('INSERT OR REPLACE INTO steps (idx, step_payload) VALUES (?, ?)').run(idx, Buffer.from(payload, 'utf8'));
  db.close();
}

describe('readAgyStepFileToolParams', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agy-file-params-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads rich params for a conversation step index', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    seedStep(
      tmp,
      id,
      186,
      'replace_file_content {"TargetFile":"/tmp/a.ts","TargetContent":"a","ReplacementContent":"b"}',
    );
    expect(readAgyStepFileToolParams(tmp, id, 186)).toEqual({
      TargetFile: '/tmp/a.ts',
      TargetContent: 'a',
      ReplacementContent: 'b',
    });
  });

  it('returns null when the db or step is missing', () => {
    expect(readAgyStepFileToolParams(tmp, 'missing', 1)).toBeNull();
  });
});

describe('enrichAgyMappedFileTools', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agy-enrich-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const CONV = '22222222-2222-2222-2222-222222222222';

  it('enriches the DONE tool_call when stream-json only had TargetFile', () => {
    seedStep(
      tmp,
      CONV,
      8,
      'replace_file_content {"TargetFile":"/tmp/a.ts","TargetContent":"old","ReplacementContent":"new"}',
    );

    const mapper = new AgyStreamMapper();
    // ACTIVE: deferred (no tool_call for file tools)
    expect(mapper.map({
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 8,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'replace_file_content',
        tool_info: { name: 'replace_file_content', parameters: { TargetFile: '/tmp/a.ts' } },
      },
    })).toEqual([]);

    const doneFrame = {
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 8,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'replace_file_content',
        tool_info: {
          name: 'replace_file_content',
          parameters: { TargetFile: '/tmp/a.ts' },
          output: '',
        },
      },
    };
    const mapped = mapper.map(doneFrame);
    expect(mapped.find((e) => e.type === 'tool_call')).toMatchObject({
      payload: { input: { TargetFile: '/tmp/a.ts' } },
    });

    const enriched = enrichAgyMappedFileTools(mapped, doneFrame, { conversationsDir: tmp });
    const tc = enriched.find((e) => e.type === 'tool_call');
    expect(tc).toEqual({
      type: 'tool_call',
      payload: {
        toolUseId: `agy:${CONV}:8`,
        name: 'replace_file_content',
        input: {
          TargetFile: '/tmp/a.ts',
          TargetContent: 'old',
          ReplacementContent: 'new',
        },
      },
    });
    expect(enriched.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(enriched.some((e) => e.type === 'file_change')).toBe(true);
    expect(enriched.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('enriches write_to_file CodeContent on DONE', () => {
    seedStep(
      tmp,
      CONV,
      7,
      'write_to_file {"TargetFile":"/tmp/b.ts","CodeContent":"x = 1\\n","Overwrite":true}',
    );
    const frame = {
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 7,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: {
          name: 'write_to_file',
          parameters: { TargetFile: '/tmp/b.ts' },
          output: 'wrote',
        },
      },
    };
    const mapped = new AgyStreamMapper().map(frame);
    const enriched = enrichAgyMappedFileTools(mapped, frame, { conversationsDir: tmp });
    expect(enriched.find((e) => e.type === 'tool_call')).toMatchObject({
      payload: {
        toolUseId: `agy:${CONV}:7`,
        name: 'write_to_file',
        input: { TargetFile: '/tmp/b.ts', CodeContent: 'x = 1\n', Overwrite: true },
      },
    });
  });

  it('agy 1.5 edit_file: one enriched tool_call (DONE only), file_change, Target/Replacement body', () => {
    seedStep(tmp, CONV, 9, 'edit_file {"Path":"/tmp/c.md","Replacement":"new","Target":"old"}');
    const mapper = new AgyStreamMapper();
    const frame = (state: string) => ({
      event: 'step_update',
      step_update: {
        conversation_id: CONV, step_index: 9, state, step_type: 'tool',
        tool_info: { name: 'edit_file', parameters: { Path: '/tmp/c.md' }, output: '' },
      },
    });
    const active = enrichAgyMappedFileTools(mapper.map(frame('ACTIVE')), frame('ACTIVE'), { conversationsDir: tmp });
    expect(active).toEqual([]);
    const done = enrichAgyMappedFileTools(mapper.map(frame('DONE')), frame('DONE'), { conversationsDir: tmp });
    expect(done.map((e) => e.type)).toEqual(['tool_call', 'file_change', 'tool_result']);
    expect(done[0]).toMatchObject({ payload: { name: 'edit_file', input: { Path: '/tmp/c.md', Target: 'old', Replacement: 'new' } } });
    expect(done[1]).toMatchObject({ payload: { path: '/tmp/c.md', kind: 'modified', toolUseId: `agy:${CONV}:9` } });
  });

  it('agy 1.5 write_file: Content body + created file_change', () => {
    seedStep(tmp, CONV, 10, 'write_file {"Content":"hi\\n","Overwrite":true,"Path":"/tmp/d.md"}');
    const frame = {
      event: 'step_update',
      step_update: {
        conversation_id: CONV, step_index: 10, state: 'DONE', step_type: 'tool',
        tool_info: { name: 'write_file', parameters: { Path: '/tmp/d.md' }, output: '' },
      },
    };
    const done = enrichAgyMappedFileTools(new AgyStreamMapper().map(frame), frame, { conversationsDir: tmp });
    expect(done[0]).toMatchObject({ payload: { input: { Path: '/tmp/d.md', Content: 'hi\n' } } });
    expect(done[1]).toMatchObject({ type: 'file_change', payload: { kind: 'created' } });
  });

  it('leaves non-file tools untouched', () => {
    const frame = {
      event: 'step_update',
      step_update: {
        conversation_id: CONV,
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\n' },
      },
    };
    const mapped = new AgyStreamMapper().map(frame);
    expect(enrichAgyMappedFileTools(mapped, frame, { conversationsDir: tmp })).toEqual(mapped);
  });
});
