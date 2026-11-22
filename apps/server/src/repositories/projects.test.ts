import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { createProject, listProjects, getProject, updateProjectName, updateProject } from './projects.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('projects repository', () => {
  it('creates, lists, and gets a project', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'Tierwyn', rootPath: '/home/x/Projects/Tierwyn' });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('Tierwyn');

    expect(listProjects(db)).toHaveLength(1);
    expect(getProject(db, p.id)?.rootPath).toBe('/home/x/Projects/Tierwyn');
    expect(getProject(db, 'missing')).toBeUndefined();
  });

  it('renames a project without touching id, rootPath, or createdAt', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'Tierwyn', rootPath: '/home/x/Projects/Tierwyn' });

    const updated = updateProjectName(db, p.id, 'Tierwyn Prod');
    expect(updated?.name).toBe('Tierwyn Prod');
    expect(updated?.id).toBe(p.id);
    expect(updated?.rootPath).toBe('/home/x/Projects/Tierwyn');
    expect(updated?.createdAt).toBe(p.createdAt);

    expect(getProject(db, p.id)?.name).toBe('Tierwyn Prod');
    expect(listProjects(db).map((x) => x.name)).toEqual(['Tierwyn Prod']);
  });

  it('returns undefined for an unknown project id', () => {
    const db = freshDb();
    createProject(db, { name: 'Tierwyn', rootPath: '/home/x/Projects/Tierwyn' });
    expect(updateProjectName(db, 'missing', 'Whatever')).toBeUndefined();
  });

  it('updates rootPath without touching name, id, or createdAt', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'Tierwyn', rootPath: '/home/x/Projects/Tierwyn' });
    const updated = updateProject(db, p.id, { rootPath: '/home/x/Projects/Moved' });
    expect(updated?.rootPath).toBe('/home/x/Projects/Moved');
    expect(updated?.name).toBe('Tierwyn');
    expect(updated?.id).toBe(p.id);
    expect(updated?.createdAt).toBe(p.createdAt);
  });

  it('updates name and rootPath together', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'Demo', rootPath: '/home/x/Projects/Demo' });
    const updated = updateProject(db, p.id, { name: 'Tierwyn', rootPath: '/home/x/Projects/Tierwyn' });
    expect(updated?.name).toBe('Tierwyn');
    expect(updated?.rootPath).toBe('/home/x/Projects/Tierwyn');
  });

  it('leaves omitted fields unchanged', () => {
    const db = freshDb();
    const p = createProject(db, { name: 'Tierwyn', rootPath: '/home/x/Projects/Tierwyn' });
    expect(updateProject(db, p.id, { name: 'Tierwyn Prod' })?.rootPath).toBe('/home/x/Projects/Tierwyn');
    expect(updateProject(db, p.id, { rootPath: '/tmp/other' })?.name).toBe('Tierwyn Prod');
  });
});
