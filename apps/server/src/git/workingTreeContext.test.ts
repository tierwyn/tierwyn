import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject } from '../repositories/projects.js';
import { createConversation, createScheduleHomeConversation, getConversation, listConversationWorkdirs, pruneMissingConversationWorkdirs } from '../repositories/conversations.js';
import {
  resolveWorkingTreeRequest, buildTreeList, collectLiveAgents, WorkingTreeContextError,
  isCwdAllowedForProject, healProjectWorkingTrees,
} from './workingTreeContext.js';
import { listGitWorktrees } from './workingTree.js';
import type { SessionRecord } from '../sessionManager.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function initGitRepo(dir: string) {
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@test.com'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

describe('workingTreeContext', () => {
  let db: Database.Database;
  let root: string;
  let worktree: string;

  beforeEach(() => {
    db = freshDb();
    root = mkdtempSync(join(tmpdir(), 'tierwyn-wt-ctx-root-'));
    initGitRepo(root);
    worktree = join(root, '..', `${root.split('/').pop()}-wt`);
    execFileSync('git', ['worktree', 'add', worktree], { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (worktree) rmSync(worktree, { recursive: true, force: true });
    db.close();
  });

  it('defaults to conversation workdirPath', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'WT', workdirPath: worktree });
    const resolved = resolveWorkingTreeRequest(db, { conversationId: c.id });
    expect(resolved.cwd).toBe(worktree);
  });

  it('defaults to project root without workdirPath', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'Chat' });
    const resolved = resolveWorkingTreeRequest(db, { conversationId: c.id });
    expect(resolved.cwd).toBe(root);
  });

  it('defaults to project root with projectId only', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const resolved = resolveWorkingTreeRequest(db, { projectId: p.id });
    expect(resolved.cwd).toBe(root);
  });

  it('allows cwd query for linked worktree', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const resolved = resolveWorkingTreeRequest(db, { projectId: p.id, cwd: worktree });
    expect(resolved.cwd).toBe(worktree);
  });

  it('rejects cwd from a different git repo', () => {
    const other = mkdtempSync(join(tmpdir(), 'tierwyn-wt-other-'));
    initGitRepo(other);
    const p = createProject(db, { name: 'P', rootPath: root });
    try {
      expect(() => resolveWorkingTreeRequest(db, { projectId: p.id, cwd: other }))
        .toThrow(WorkingTreeContextError);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects /etc', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    expect(() => resolveWorkingTreeRequest(db, { projectId: p.id, cwd: '/etc' }))
      .toThrow(WorkingTreeContextError);
  });

  it('tree list includes project root, conversation workdir, and extra worktree', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    createConversation(db, { projectId: p.id, title: 'WT', workdirPath: worktree });
    const extra = join(root, '..', `${root.split('/').pop()}-extra`);
    execFileSync('git', ['worktree', 'add', extra], { cwd: root });
    const trees = buildTreeList(db, p);
    const cwds = trees.map((t) => t.cwd);
    expect(cwds).toContain(root);
    expect(cwds).toContain(worktree);
    expect(cwds).toContain(extra);
    try {
      execFileSync('git', ['worktree', 'remove', extra], { cwd: root });
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it('listConversationWorkdirs includes schedule_home workdir', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const home = createScheduleHomeConversation(db, { projectId: p.id, jobName: 'job' });
    db.prepare('UPDATE conversations SET workdir_path = ? WHERE id = ?').run(worktree, home.id);
    const rows = listConversationWorkdirs(db, p.id);
    expect(rows.some((r) => r.id === home.id && r.workdirPath === worktree)).toBe(true);
  });

  it('collectLiveAgents lists running session on matching cwd', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'Agent', workdirPath: worktree });
    const session = {
      id: 's1',
      conversationId: c.id,
      lastStatus: 'running' as const,
      steerQueue: [],
      steerOrigin: { cwd: worktree, conversationId: c.id, projectId: p.id, agent: 'x', model: 'm', profileId: 'p' },
    } as SessionRecord;
    const agents = collectLiveAgents(db, worktree, [session]);
    expect(agents).toHaveLength(1);
    expect(agents[0].title).toBe('Agent');
  });

  it('collectLiveAgents omits parked sessions', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'Parked', workdirPath: worktree });
    const session = {
      id: 's1',
      conversationId: c.id,
      lastStatus: 'done' as const,
      steerQueue: [],
      steerOrigin: { cwd: worktree, conversationId: c.id, projectId: p.id, agent: 'x', model: 'm', profileId: 'p' },
    } as SessionRecord;
    expect(collectLiveAgents(db, worktree, [session])).toHaveLength(0);
  });

  it('collectLiveAgents includes idle session with pending steer', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'Queued', workdirPath: worktree });
    const session = {
      id: 's1',
      conversationId: c.id,
      lastStatus: 'idle' as const,
      steerQueue: [{ id: 'q1', type: 'queue', text: 'pending', ts: Date.now() }],
      steerOrigin: { cwd: worktree, conversationId: c.id, projectId: p.id, agent: 'x', model: 'm', profileId: 'p' },
    } as SessionRecord;
    expect(collectLiveAgents(db, worktree, [session])).toHaveLength(1);
  });

  it('collectLiveAgents omits sessions on other cwd', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'Elsewhere' });
    const session = {
      id: 's1',
      conversationId: c.id,
      lastStatus: 'running' as const,
      steerQueue: [],
      steerOrigin: { cwd: root, conversationId: c.id, projectId: p.id, agent: 'x', model: 'm', profileId: 'p' },
    } as SessionRecord;
    expect(collectLiveAgents(db, worktree, [session])).toHaveLength(0);
  });

  it('rejects foreign repo workdir when project root has unreadable git metadata', () => {
    const brokenRoot = mkdtempSync(join(tmpdir(), 'tierwyn-wt-broken-root-'));
    writeFileSync(join(brokenRoot, '.git'), 'gitdir: /nonexistent/xyz\n');
    const foreign = mkdtempSync(join(tmpdir(), 'tierwyn-wt-foreign-'));
    initGitRepo(foreign);
    const p = createProject(db, { name: 'Broken', rootPath: brokenRoot });
    createConversation(db, { projectId: p.id, title: 'Foreign WT', workdirPath: foreign });
    expect(isCwdAllowedForProject(db, p, foreign)).toBe(false);
    expect(() => resolveWorkingTreeRequest(db, { projectId: p.id, cwd: foreign }))
      .toThrow(WorkingTreeContextError);
    rmSync(foreign, { recursive: true, force: true });
    rmSync(brokenRoot, { recursive: true, force: true });
  });

  it('canonicalises symlinked non-git root to realpath', () => {
    const real = mkdtempSync(join(tmpdir(), 'tierwyn-wt-nongit-real-'));
    const link = join(real, '..', `${real.split('/').pop()}-link`);
    symlinkSync(real, link);
    const p = createProject(db, { name: 'NoGit', rootPath: link });
    const resolved = resolveWorkingTreeRequest(db, { projectId: p.id });
    expect(resolved.cwd).toBe(real);
    rmSync(real, { recursive: true, force: true });
  });

  it('detects nested git repos in buildTreeList and allows them in isCwdAllowedForProject', () => {
    const internal = join(root, 'internal');
    mkdirSync(internal);
    initGitRepo(internal);

    const p = createProject(db, { name: 'P', rootPath: root });
    const trees = buildTreeList(db, p);
    const nestedRef = trees.find((t) => t.cwd === internal);
    expect(nestedRef).toBeDefined();
    expect(nestedRef?.label).toBe('internal');
    expect(nestedRef?.source).toBe('nested');

    expect(isCwdAllowedForProject(db, p, internal)).toBe(true);
    const resolved = resolveWorkingTreeRequest(db, { projectId: p.id, cwd: internal });
    expect(resolved.cwd).toBe(internal);
  });

  it('nulls a missing conversation workdir and drops it from the tree list', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'Ghost', workdirPath: worktree });
    rmSync(worktree, { recursive: true, force: true });

    const n = pruneMissingConversationWorkdirs(db, p.id);
    expect(n).toBe(1);

    const row = getConversation(db, c.id);
    expect(row).toBeDefined();
    expect(row?.workdirPath).toBeUndefined();

    const trees = buildTreeList(db, p);
    expect(trees.map((t) => t.cwd)).not.toContain(worktree);
    expect(trees.some((t) => t.conversationId === c.id)).toBe(false);
  });

  it('keeps a live conversation workdir on disk', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'Live', workdirPath: worktree });

    expect(pruneMissingConversationWorkdirs(db, p.id)).toBe(0);
    expect(getConversation(db, c.id)?.workdirPath).toBe(worktree);
    expect(buildTreeList(db, p).map((t) => t.cwd)).toContain(worktree);
  });

  it('keeps a conversation workdir that exists but is not a git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'tierwyn-wt-plain-'));
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'Plain', workdirPath: plain });
    try {
      expect(pruneMissingConversationWorkdirs(db, p.id)).toBe(0);
      expect(getConversation(db, c.id)?.workdirPath).toBe(plain);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('falls back to project root when conversation workdir is missing', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const c = createConversation(db, { projectId: p.id, title: 'Ghost', workdirPath: worktree });
    rmSync(worktree, { recursive: true, force: true });

    const resolved = resolveWorkingTreeRequest(db, { conversationId: c.id });
    expect(resolved.cwd).toBe(root);
  });

  it('falls back to project root when cwd query is a missing ghost', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    createConversation(db, { projectId: p.id, title: 'Ghost', workdirPath: worktree });
    rmSync(worktree, { recursive: true, force: true });

    const resolved = resolveWorkingTreeRequest(db, { projectId: p.id, cwd: worktree });
    expect(resolved.cwd).toBe(root);
  });

  it('still rejects foreign existing paths after a missing-cwd fallback', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    expect(() => resolveWorkingTreeRequest(db, { projectId: p.id, cwd: '/etc' }))
      .toThrow(WorkingTreeContextError);
  });

  it('leaves nested repos in the tree list after healing a missing workdir', () => {
    const internal = join(root, 'internal');
    mkdirSync(internal);
    initGitRepo(internal);

    const p = createProject(db, { name: 'P', rootPath: root });
    createConversation(db, { projectId: p.id, title: 'Ghost', workdirPath: worktree });
    rmSync(worktree, { recursive: true, force: true });

    healProjectWorkingTrees(db, p);
    const trees = buildTreeList(db, p);
    const nestedRef = trees.find((t) => t.cwd === internal);
    expect(nestedRef).toBeDefined();
    expect(nestedRef?.source).toBe('nested');
    expect(trees.map((t) => t.cwd)).not.toContain(worktree);
  });

  it('does not null missing workdirs belonging to other projects', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    const otherRoot = mkdtempSync(join(tmpdir(), 'tierwyn-wt-other-root-'));
    initGitRepo(otherRoot);
    const ghost = mkdtempSync(join(tmpdir(), 'tierwyn-wt-other-ghost-'));
    const p2 = createProject(db, { name: 'Other', rootPath: otherRoot });
    const c2 = createConversation(db, { projectId: p2.id, title: 'Other ghost', workdirPath: ghost });
    rmSync(ghost, { recursive: true, force: true });

    try {
      expect(pruneMissingConversationWorkdirs(db, p.id)).toBe(0);
      expect(getConversation(db, c2.id)?.workdirPath).toBe(ghost);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('prunes stale git worktrees so missing paths leave the switcher', () => {
    const p = createProject(db, { name: 'P', rootPath: root });
    rmSync(worktree, { recursive: true, force: true });
    expect(listGitWorktrees(root).some((wt) => wt.cwd === worktree)).toBe(true);

    healProjectWorkingTrees(db, p);

    expect(listGitWorktrees(root).some((wt) => wt.cwd === worktree)).toBe(false);
    expect(buildTreeList(db, p).map((t) => t.cwd)).not.toContain(worktree);
  });
});
