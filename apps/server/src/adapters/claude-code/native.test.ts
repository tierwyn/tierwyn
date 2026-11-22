import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeCodeAdapter } from './index.js';
import { isRealUserPrompt } from '../nativeJsonlFork.js';

describe('ClaudeCodeAdapter.isNativeSessionAvailable', () => {
  it('returns true when a session file exists under the projects dir', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tierwyn-home-'));
    const adapter = new ClaudeCodeAdapter({ claudeHome: join(home, '.claude') });
    const dir = join(home, '.claude', 'projects', 'whatever');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess-123.jsonl'), '{}');
    expect(await adapter.isNativeSessionAvailable!('sess-123')).toBe(true);
  });

  it('returns false when no matching session file exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tierwyn-home-'));
    const adapter = new ClaudeCodeAdapter({ claudeHome: join(home, '.claude') });
    expect(await adapter.isNativeSessionAvailable!('nope')).toBe(false);
  });
});

describe('ClaudeCodeAdapter.deleteNativeSession', () => {
  it('unlinks the native .jsonl when it exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tierwyn-home-'));
    const adapter = new ClaudeCodeAdapter({ claudeHome: join(home, '.claude') });
    const dir = join(home, '.claude', 'projects', 'whatever');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'sess-del.jsonl');
    writeFileSync(file, '{}');
    await adapter.deleteNativeSession!('sess-del');
    expect(existsSync(file)).toBe(false);
  });

  it('swallows ENOENT when the file is already gone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tierwyn-home-'));
    const adapter = new ClaudeCodeAdapter({ claudeHome: join(home, '.claude') });
    // locateJsonlFile returns null → adapter returns early (no throw).
    await expect(adapter.deleteNativeSession!('never-existed')).resolves.toBeUndefined();
  });
});

describe('ClaudeCodeAdapter.exciseNativeTurn', () => {
  function seed(home: string, nativeId: string): string {
    const dir = join(home, '.claude', 'projects', 'whatever');
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'user', sessionId: nativeId, uuid: 'u1', parentUuid: null,
        message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
      { type: 'assistant', sessionId: nativeId, uuid: 'a1', parentUuid: 'u1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }] } },
      { type: 'user', sessionId: nativeId, uuid: 'u2', parentUuid: 'a1',
        message: { role: 'user', content: [{ type: 'text', text: 'two' }] } },
      { type: 'assistant', sessionId: nativeId, uuid: 'a2', parentUuid: 'u2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'r2' }] } },
      { type: 'user', sessionId: nativeId, uuid: 'u3', parentUuid: 'a2',
        message: { role: 'user', content: [{ type: 'text', text: 'three' }] } },
      { type: 'assistant', sessionId: nativeId, uuid: 'a3', parentUuid: 'u3',
        message: { role: 'assistant', content: [{ type: 'text', text: 'r3' }] } },
    ];
    const path = join(dir, `${nativeId}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return dir;
  }

  it('delegates to exciseTurnFromJsonl: excises turn 2, rewires u3 parent to a1', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tierwyn-home-'));
    const adapter = new ClaudeCodeAdapter({ claudeHome: join(home, '.claude') });
    const dir = seed(home, 'sess-excise');
    const newId = await adapter.exciseNativeTurn!('sess-excise', 2);
    expect(newId).not.toBe('sess-excise');
    const kept = readFileSync(join(dir, `${newId}.jsonl`), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(kept.filter((l) => isRealUserPrompt(l))).toHaveLength(2);
    const u3 = kept.find((l) => l.uuid === 'u3');
    expect(u3!.parentUuid).toBe('a1');
    // Original untouched.
    expect(existsSync(join(dir, 'sess-excise.jsonl'))).toBe(true);
  });

  it('rejects on single-turn file (route maps to 400/409)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tierwyn-home-'));
    const adapter = new ClaudeCodeAdapter({ claudeHome: join(home, '.claude') });
    const dir = join(home, '.claude', 'projects', 'whatever');
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'user', sessionId: 'solo', uuid: 'u1', parentUuid: null,
        message: { role: 'user', content: [{ type: 'text', text: 'only' }] } },
      { type: 'assistant', sessionId: 'solo', uuid: 'a1', parentUuid: 'u1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } },
    ];
    writeFileSync(join(dir, 'solo.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await expect(adapter.exciseNativeTurn!('solo', 1)).rejects.toThrow(/single-turn|delete the conversation/i);
  });

  it('rejects on missing native file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tierwyn-home-'));
    const adapter = new ClaudeCodeAdapter({ claudeHome: join(home, '.claude') });
    await expect(adapter.exciseNativeTurn!('missing', 1)).rejects.toThrow(/not found/);
  });
});
