import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  snapshotCode,
  restoreCode,
  deleteShadowRef,
  evaluateCodeRewindGate,
  localShadowOpsFor,
  parentHeadForCodeRef,
  codeDiff,
  resolveShadowRef,
} from './shadowCheckpoint.js';

let root: string;
const convId = 'conv-test-001';
const cpId = 'cp-test-001';

function initRepo(dir: string, file = 'f.txt', content = 'initial'): string {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, file), content);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tierwyn-sc-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('shadowCheckpoint', () => {
  it('snapshotCode returns null for non-git cwd without throwing', () => {
    expect(snapshotCode(root, convId, cpId)).toBeNull();
  });

  it('shadow ref is invisible and does not touch HEAD, branches, index, or reflog', () => {
    const headBefore = initRepo(root);
    // leave an uncommitted working-tree change so the snapshot records a distinct tree
    writeFileSync(join(root, 'g.txt'), 'snap');
    const indexBefore = readFileSync(join(root, '.git', 'index'));
    const branchesBefore = execFileSync('git', ['branch'], { cwd: root }).toString();
    const logBefore = execFileSync('git', ['log', '--oneline'], { cwd: root }).toString();
    const reflogBefore = execFileSync('git', ['reflog'], { cwd: root }).toString();

    const codeRef = snapshotCode(root, convId, cpId);
    expect(codeRef).toBeTruthy();

    const branchesAfter = execFileSync('git', ['branch'], { cwd: root }).toString();
    const logAfter = execFileSync('git', ['log', '--oneline'], { cwd: root }).toString();
    const reflogAfter = execFileSync('git', ['reflog'], { cwd: root }).toString();
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    const indexAfter = readFileSync(join(root, '.git', 'index'));

    expect(branchesAfter).toBe(branchesBefore);
    expect(logAfter).toBe(logBefore);
    expect(reflogAfter).toBe(reflogBefore);
    expect(headAfter).toBe(headBefore);
    expect(indexAfter.equals(indexBefore)).toBe(true);

    const shadowRef = `refs/tierwyn/checkpoints/${convId}/${cpId}`;
    const resolved = execFileSync('git', ['rev-parse', shadowRef], { cwd: root }).toString().trim();
    expect(resolved).toBe(codeRef);
  });

  it('worktree-mode restore resets hard to snapshot state and removes new untracked files', () => {
    initRepo(root, 'f.txt', 'v1');
    // leave an uncommitted change so the snapshot records a distinct state
    writeFileSync(join(root, 'f.txt'), 'v2');
    const codeRef = snapshotCode(root, convId, cpId)!;
    writeFileSync(join(root, 'f.txt'), 'v3');
    writeFileSync(join(root, 'new.txt'), 'created later');
    execFileSync('git', ['add', 'f.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'after'], { cwd: root });

    restoreCode(root, codeRef, 'worktree');

    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v2');
    expect(() => readFileSync(join(root, 'new.txt'), 'utf8')).toThrow();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    expect(head).toBe(codeRef);
  });

  it('shared-root gate passes even when HEAD has advanced beyond the snapshot', async () => {
    // Change 2 (2026-07-12): clean-tree / HEAD-equality guard removed.
    // `git restore --source` overwrites tracked paths without moving HEAD;
    // the route takes a pre-restore safety checkpoint first so edits are recoverable.
    initRepo(root, 'f.txt', 'v1');
    writeFileSync(join(root, 'f.txt'), 'v2');
    const codeRef = snapshotCode(root, convId, cpId)!;
    writeFileSync(join(root, 'f.txt'), 'v3');
    execFileSync('git', ['add', 'f.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'after'], { cwd: root });

    const gate = await evaluateCodeRewindGate(localShadowOpsFor(root), undefined, codeRef, true);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.mode).toBe('shared');
  });

  it('shared-root restores via git restore without moving HEAD when clean', async () => {
    const headAtSnapshot = initRepo(root, 'f.txt', 'v1');
    // leave an uncommitted change so the snapshot records a distinct state
    writeFileSync(join(root, 'f.txt'), 'v2');
    const codeRef = snapshotCode(root, convId, cpId)!;
    writeFileSync(join(root, 'f.txt'), 'v3');
    execFileSync('git', ['add', 'f.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'after'], { cwd: root });
    execFileSync('git', ['reset', '--hard', headAtSnapshot], { cwd: root });

    const gate = await evaluateCodeRewindGate(localShadowOpsFor(root), undefined, codeRef, true);
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      restoreCode(root, codeRef, gate.mode);
    }

    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v2');
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    expect(headAfter).toBe(headAtSnapshot);
  });

  it('deleteShadowRef removes the private ref', () => {
    initRepo(root);
    writeFileSync(join(root, 'g.txt'), 'snap'); // uncommitted change
    const codeRef = snapshotCode(root, convId, cpId)!;
    const ref = `refs/tierwyn/checkpoints/${convId}/${cpId}`;
    expect(execFileSync('git', ['rev-parse', ref], { cwd: root }).toString().trim()).toBe(codeRef);

    deleteShadowRef(root, convId, cpId);

    expect(() => execFileSync('git', ['rev-parse', ref], { cwd: root })).toThrow();
  });

  it('shared-root gate returns shared_tree without confirmSharedCode', async () => {
    initRepo(root);
    writeFileSync(join(root, 'g.txt'), 'snap'); // uncommitted change
    const codeRef = snapshotCode(root, convId, cpId)!;
    const gate = await evaluateCodeRewindGate(localShadowOpsFor(root), undefined, codeRef, false);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe('shared_tree');
  });

  it('worktree gate passes when workdir_path is set', async () => {
    initRepo(root);
    writeFileSync(join(root, 'g.txt'), 'snap'); // uncommitted change
    const codeRef = snapshotCode(root, convId, cpId)!;
    const gate = await evaluateCodeRewindGate(localShadowOpsFor(root), root, codeRef, false);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.mode).toBe('worktree');
  });

  it('snapshotCode skips the snapshot when the working tree equals HEAD (no changes to record)', () => {
    initRepo(root); // tree == HEAD, nothing distinct
    expect(snapshotCode(root, convId, cpId)).toBeNull();
    const ref = `refs/tierwyn/checkpoints/${convId}/${cpId}`;
    expect(() => execFileSync('git', ['rev-parse', ref], { cwd: root })).toThrow();
  });

  it('snapshotCode records uncommitted working-tree changes (no commit needed)', () => {
    initRepo(root);
    writeFileSync(join(root, 'g.txt'), 'uncommitted-snap'); // dirty, not committed
    const codeRef = snapshotCode(root, convId, cpId);
    expect(codeRef).toBeTruthy();
    const ref = `refs/tierwyn/checkpoints/${convId}/${cpId}`;
    expect(execFileSync('git', ['rev-parse', ref], { cwd: root }).toString().trim()).toBe(codeRef);
  });

  it('resolveShadowRef falls back to legacy refs/nuncii/checkpoints', () => {
    const head = initRepo(root);
    const legacy = `refs/nuncii/checkpoints/${convId}/${cpId}`;
    execFileSync('git', ['update-ref', legacy, head], { cwd: root });
    expect(resolveShadowRef(root, convId, cpId)).toBe(head);
  });

  it('deleteShadowRef removes tierwyn and legacy nuncii refs', () => {
    const head = initRepo(root);
    const tierwyn = `refs/tierwyn/checkpoints/${convId}/${cpId}`;
    const legacy = `refs/nuncii/checkpoints/${convId}/${cpId}`;
    execFileSync('git', ['update-ref', tierwyn, head], { cwd: root });
    execFileSync('git', ['update-ref', legacy, head], { cwd: root });
    deleteShadowRef(root, convId, cpId);
    expect(() => execFileSync('git', ['rev-parse', tierwyn], { cwd: root })).toThrow();
    expect(() => execFileSync('git', ['rev-parse', legacy], { cwd: root })).toThrow();
  });

  it('codeDiff reports untracked files because worktree restore removes them', () => {
    initRepo(root);
    writeFileSync(join(root, 'g.txt'), 'snap'); // uncommitted change
    const codeRef = snapshotCode(root, convId, cpId)!;
    writeFileSync(join(root, 'later.txt'), 'created later');

    expect(codeDiff(root, codeRef)).toContain('later.txt');
  });

  it('snapshotCode returns null rather than throwing when git write fails', () => {
    initRepo(root);
    rmSync(join(root, '.git', 'objects'), { recursive: true, force: true });
    expect(snapshotCode(root, convId, 'cp-fail')).toBeNull();
  });
});
