import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject, deleteProject } from './projects.js';
import { createConversation, deleteConversation, moveConversationTree } from './conversations.js';
import {
  createGlobalTask,
  getGlobalTask,
  listConversationTasks,
  openTaskIds,
  agentUpdateGlobalTask,
  operatorUpdateGlobalTask,
  hideAllCompleted,
  deleteGlobalTask,
  deleteAllHidden,
  listGlobalTaskDtos,
  getGlobalTaskDto,
  countGlobalTasks,
  sweepHiddenGlobalTasks,
  hiddenSweepCutoff,
  type NewGlobalTask,
} from './globalTasks.js';
import { updateGlobalTasksSettings } from './settings.js';

const NOW = 1_800_000_000_000;

let db: Database.Database;
let projectId: string;
let otherProjectId: string;
let convA: string;
let convChild: string;

function setup(pragmaFk = true): void {
  db = new Database(':memory:');
  if (pragmaFk) db.pragma('foreign_keys = ON');
  else db.pragma('foreign_keys = OFF');
  runMigrations(db, migrations);
  const project = createProject(db, { name: 'Alpha', rootPath: '/tmp/a' });
  const other = createProject(db, { name: 'Beta', rootPath: '/tmp/b' });
  projectId = project.id;
  otherProjectId = other.id;
  convA = createConversation(db, { projectId, title: 'A' }).id;
  convChild = createConversation(db, { projectId, title: 'Child', parentConversationId: convA }).id;
}

function newTask(over: Partial<NewGlobalTask> & { conversationId?: string } = {}): NewGlobalTask {
  const conversationId = over.conversationId ?? convA;
  return {
    projectId,
    conversationId,
    sessionId: 'sess-a',
    conversationTitle: conversationId === convChild ? 'Child' : 'A',
    title: 'Do the thing',
    description: 'desc',
    testing: 'test plan',
    progress: 'started',
    now: NOW,
    ...over,
  };
}

beforeEach(() => setup(true));

describe('hiddenSweepCutoff', () => {
  it('returns null when days <= 0, else now minus days in ms', () => {
    expect(hiddenSweepCutoff(1e12, 0)).toBeNull();
    expect(hiddenSweepCutoff(1e12, 30)).toBe(1e12 - 30 * 86_400_000);
  });
});

describe('createGlobalTask', () => {
  it('round-trips every field; status in_progress; completed/hidden unset; createdAt === updatedAt === now', () => {
    const t = createGlobalTask(db, newTask());
    expect(t.projectId).toBe(projectId);
    expect(t.conversationId).toBe(convA);
    expect(t.sessionId).toBe('sess-a');
    expect(t.conversationTitle).toBe('A');
    expect(t.title).toBe('Do the thing');
    expect(t.description).toBe('desc');
    expect(t.testing).toBe('test plan');
    expect(t.progress).toBe('started');
    expect(t.status).toBe('in_progress');
    expect(t.completedBy).toBeUndefined();
    expect(t.completedAt).toBeUndefined();
    expect(t.hiddenAt).toBeUndefined();
    expect(t.createdAt).toBe(NOW);
    expect(t.updatedAt).toBe(NOW);
    expect(getGlobalTask(db, t.id)).toEqual(t);
  });
});

describe('agentUpdateGlobalTask', () => {
  it('completed sets completedAt/completedBy agent; reopen clears both; stamps session and title; bumps updatedAt', () => {
    const t = createGlobalTask(db, newTask());
    const done = agentUpdateGlobalTask(db, t.id, { status: 'completed' }, {
      sessionId: 'sess-b', conversationTitle: 'A-renamed', now: NOW + 10,
    });
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBe(NOW + 10);
    expect(done.completedBy).toBe('agent');
    expect(done.sessionId).toBe('sess-b');
    expect(done.conversationTitle).toBe('A-renamed');
    expect(done.updatedAt).toBe(NOW + 10);

    const reopened = agentUpdateGlobalTask(db, t.id, { status: 'in_progress' }, {
      sessionId: 'sess-c', conversationTitle: 'A2', now: NOW + 20,
    });
    expect(reopened.status).toBe('in_progress');
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.completedBy).toBeUndefined();
    expect(reopened.sessionId).toBe('sess-c');
    expect(reopened.conversationTitle).toBe('A2');
    expect(reopened.updatedAt).toBe(NOW + 20);
  });
});

describe('operatorUpdateGlobalTask', () => {
  it('completed sets completedBy operator; hidden does not bump updatedAt; unhide clears; unknown id is undefined', () => {
    const t = createGlobalTask(db, newTask());
    const done = operatorUpdateGlobalTask(db, t.id, { status: 'completed' }, NOW + 5)!;
    expect(done.completedBy).toBe('operator');
    expect(done.completedAt).toBe(NOW + 5);
    expect(done.updatedAt).toBe(NOW + 5);

    const hidden = operatorUpdateGlobalTask(db, t.id, { hidden: true }, NOW + 50)!;
    expect(hidden.hiddenAt).toBe(NOW + 50);
    expect(hidden.updatedAt).toBe(NOW + 5);

    const shown = operatorUpdateGlobalTask(db, t.id, { hidden: false }, NOW + 60)!;
    expect(shown.hiddenAt).toBeUndefined();
    expect(shown.updatedAt).toBe(NOW + 5);

    expect(operatorUpdateGlobalTask(db, 'missing', { hidden: true }, NOW)).toBeUndefined();
  });
});

describe('listConversationTasks and openTaskIds', () => {
  it('listConversationTasks excludes hidden; openTaskIds counts only non-hidden in_progress', () => {
    const a = createGlobalTask(db, newTask({ title: 'open', now: NOW + 1 }));
    const b = createGlobalTask(db, newTask({ title: 'will-hide', now: NOW + 2 }));
    const c = createGlobalTask(db, newTask({ title: 'done', now: NOW + 3 }));
    agentUpdateGlobalTask(db, c.id, { status: 'completed' }, { sessionId: 'sess-a', conversationTitle: 'A', now: NOW + 4 });
    operatorUpdateGlobalTask(db, b.id, { hidden: true }, NOW + 5);

    const listed = listConversationTasks(db, convA);
    expect(listed.map((t) => t.title)).toEqual(['done', 'open']);
    expect(openTaskIds(db, convA)).toEqual([a.id]);
  });
});

describe('listGlobalTaskDtos', () => {
  it('views, projectId filter, order, DTO fields, live, parent titles, truncated at 500', () => {
    const open = createGlobalTask(db, newTask({ title: 'open', now: NOW + 1 }));
    const done = createGlobalTask(db, newTask({ title: 'done', now: NOW + 2 }));
    agentUpdateGlobalTask(db, done.id, { status: 'completed' }, { sessionId: 'sess-a', conversationTitle: 'A', now: NOW + 3 });
    const hid = createGlobalTask(db, newTask({ title: 'hid', now: NOW + 4 }));
    operatorUpdateGlobalTask(db, hid.id, { hidden: true }, NOW + 5);

    const childTask = createGlobalTask(db, newTask({
      conversationId: convChild, conversationTitle: 'Child', title: 'child-open', now: NOW + 6,
    }));
    db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(convA);

    const liveIds = new Set([convChild]);
    const isLive = (cid: string) => liveIds.has(cid);

    const inProg = listGlobalTaskDtos(db, { view: 'in_progress', isLive });
    expect(inProg.tasks.map((t) => t.title)).toEqual(['child-open', 'open']);
    expect(inProg.truncated).toBe(false);

    const completed = listGlobalTaskDtos(db, { view: 'completed', isLive });
    expect(completed.tasks.map((t) => t.title)).toEqual(['done']);

    const hidden = listGlobalTaskDtos(db, { view: 'hidden', isLive });
    expect(hidden.tasks.map((t) => t.title)).toEqual(['hid']);

    const filtered = listGlobalTaskDtos(db, { view: 'in_progress', projectId: otherProjectId, isLive });
    expect(filtered.tasks).toEqual([]);

    const dto = getGlobalTaskDto(db, open.id, isLive)!;
    expect(dto.projectName).toBe('Alpha');
    expect(dto.conversationArchived).toBe(true);
    expect(dto.live).toBe(false);
    expect(dto.parentConversationId).toBeUndefined();

    const childDto = getGlobalTaskDto(db, childTask.id, isLive)!;
    expect(childDto.parentConversationId).toBe(convA);
    expect(childDto.parentConversationTitle).toBe('A');
    expect(childDto.fromSchedule).toBeUndefined();
    expect(childDto.live).toBe(true);
    expect(childDto.conversationArchived).toBeUndefined();

    // Schedule run conversation under schedule_home has fromSchedule: true
    const schedHome = createConversation(db, { projectId, title: 'Daily Job', kind: 'schedule_home' }).id;
    const schedRun = createConversation(db, { projectId, parentConversationId: schedHome, title: 'Run #1' }).id;
    const schedTask = createGlobalTask(db, newTask({ conversationId: schedRun, conversationTitle: 'Run #1', title: 'sched-task' }));
    const schedDto = getGlobalTaskDto(db, schedTask.id, isLive)!;
    expect(schedDto.parentConversationId).toBe(schedHome);
    expect(schedDto.parentConversationTitle).toBe('Daily Job');
    expect(schedDto.fromSchedule).toBe(true);

    const extra = createProject(db, { name: 'Flood', rootPath: '/tmp/f' });
    const floodConv = createConversation(db, { projectId: extra.id, title: 'Flood' }).id;
    for (let i = 0; i < 501; i++) {
      createGlobalTask(db, {
        projectId: extra.id,
        conversationId: floodConv,
        sessionId: 's',
        conversationTitle: 'Flood',
        title: `t${i}`,
        description: '',
        testing: '',
        progress: '',
        now: NOW + 100 + i,
      });
    }
    const page = listGlobalTaskDtos(db, { view: 'in_progress', projectId: extra.id, isLive: () => false });
    expect(page.tasks).toHaveLength(500);
    expect(page.truncated).toBe(true);
    expect(page.tasks[0]!.title).toBe('t500');
    expect(page.tasks[499]!.title).toBe('t1');
  });
});

describe('count / hide / delete / sweep', () => {
  it('countGlobalTasks returns the three counts', () => {
    createGlobalTask(db, newTask({ title: 'a' }));
    const b = createGlobalTask(db, newTask({ title: 'b' }));
    agentUpdateGlobalTask(db, b.id, { status: 'completed' }, { sessionId: 's', conversationTitle: 'A', now: NOW + 1 });
    const c = createGlobalTask(db, newTask({ title: 'c' }));
    operatorUpdateGlobalTask(db, c.id, { hidden: true }, NOW + 2);
    expect(countGlobalTasks(db)).toEqual({ inProgress: 1, completedVisible: 1, hidden: 1 });
  });

  it('hideAllCompleted returns ids of visible completed rows only', () => {
    const open = createGlobalTask(db, newTask({ title: 'open' }));
    const done = createGlobalTask(db, newTask({ title: 'done' }));
    agentUpdateGlobalTask(db, done.id, { status: 'completed' }, { sessionId: 's', conversationTitle: 'A', now: NOW + 1 });
    const already = createGlobalTask(db, newTask({ title: 'already' }));
    agentUpdateGlobalTask(db, already.id, { status: 'completed' }, { sessionId: 's', conversationTitle: 'A', now: NOW + 2 });
    operatorUpdateGlobalTask(db, already.id, { hidden: true }, NOW + 3);
    expect(hideAllCompleted(db, NOW + 4)).toEqual([done.id]);
    expect(getGlobalTask(db, done.id)!.hiddenAt).toBe(NOW + 4);
    expect(getGlobalTask(db, open.id)!.hiddenAt).toBeUndefined();
  });

  it('deleteAllHidden returns the deleted ids; sweep deletes only hidden_at < cutoff', () => {
    const a = createGlobalTask(db, newTask({ title: 'a' }));
    const b = createGlobalTask(db, newTask({ title: 'b' }));
    operatorUpdateGlobalTask(db, a.id, { hidden: true }, NOW + 10);
    operatorUpdateGlobalTask(db, b.id, { hidden: true }, NOW + 20);
    expect(sweepHiddenGlobalTasks(db, NOW + 15)).toBe(1);
    expect(getGlobalTask(db, a.id)).toBeUndefined();
    expect(getGlobalTask(db, b.id)).toBeDefined();

    const ids = deleteAllHidden(db);
    expect(ids).toEqual([b.id]);
    expect(getGlobalTask(db, b.id)).toBeUndefined();
    expect(deleteGlobalTask(db, 'missing')).toBe(false);
  });

  it('sweep is a no-op while the feature is disabled; resumes on re-enable', () => {
    const a = createGlobalTask(db, newTask({ title: 'stale-hidden' }));
    operatorUpdateGlobalTask(db, a.id, { hidden: true }, NOW - 90 * 86_400_000);
    updateGlobalTasksSettings(db, { enabled: false });
    expect(sweepHiddenGlobalTasks(db, Date.now())).toBe(0);
    expect(getGlobalTask(db, a.id)).toBeDefined();
    updateGlobalTasksSettings(db, { enabled: true });
    expect(sweepHiddenGlobalTasks(db, Date.now())).toBe(1);
    expect(getGlobalTask(db, a.id)).toBeUndefined();
  });
});

describe('conversation / project delete and move', () => {
  it('deleteConversation nulls conversationId and keeps the title snapshot (FKs on)', () => {
    const t = createGlobalTask(db, newTask());
    deleteConversation(db, convA);
    const kept = getGlobalTask(db, t.id)!;
    expect(kept.conversationId).toBeUndefined();
    expect(kept.conversationTitle).toBe('A');
  });

  it('deleteConversation nulls conversationId with foreign_keys OFF (explicit statement)', () => {
    setup(false);
    const t = createGlobalTask(db, newTask());
    deleteConversation(db, convA);
    const kept = getGlobalTask(db, t.id)!;
    expect(kept.conversationId).toBeUndefined();
    expect(kept.conversationTitle).toBe('A');
  });

  it('deleteProject removes the task (FKs on)', () => {
    const t = createGlobalTask(db, newTask());
    deleteProject(db, projectId);
    expect(getGlobalTask(db, t.id)).toBeUndefined();
  });

  it('deleteProject removes the task with foreign_keys OFF', () => {
    setup(false);
    const t = createGlobalTask(db, newTask());
    deleteProject(db, projectId);
    expect(getGlobalTask(db, t.id)).toBeUndefined();
  });

  it('moveConversationTree re-points root and child tasks to the destination project', () => {
    const rootTask = createGlobalTask(db, newTask());
    const childTask = createGlobalTask(db, newTask({
      conversationId: convChild, conversationTitle: 'Child',
    }));
    moveConversationTree(db, convA, otherProjectId);
    expect(getGlobalTask(db, rootTask.id)!.projectId).toBe(otherProjectId);
    expect(getGlobalTask(db, childTask.id)!.projectId).toBe(otherProjectId);
  });
});
