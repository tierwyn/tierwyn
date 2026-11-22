import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import { migrations } from './migrations/index.js';
import {
  setConversationPermissionMode, setConversationSandbox, getConversation,
  createConversation, forkConversation, duplicateConversation,
} from '../repositories/conversations.js';
import { createProject, updateProject, getProject } from '../repositories/projects.js';

describe('runMigrations', () => {
  it('applies a migration once and records its version', () => {
    const db = new Database(':memory:');
    const migrations = [{ version: 1, sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY);' }];

    runMigrations(db, migrations);
    runMigrations(db, migrations); // second run is a no-op

    const applied = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
    expect(applied).toEqual([{ version: 1 }]);

    const cols = db.prepare("PRAGMA table_info('t')").all();
    expect(cols.length).toBe(1);
  });

  // Adversary F4 — FK-off is opt-in so ordinary migrations keep enforcement.
  it('needsFkOff allows parent rebuild without CASCADE-deleting children', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, [
      {
        version: 1,
        sql: `
          CREATE TABLE parent (id TEXT PRIMARY KEY);
          CREATE TABLE child (
            id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE
          );
          INSERT INTO parent (id) VALUES ('p1');
          INSERT INTO child (id, parent_id) VALUES ('c1', 'p1');
        `,
      },
      {
        version: 2,
        needsFkOff: true,
        sql: `
          CREATE TABLE parent_new (id TEXT PRIMARY KEY, extra INTEGER NOT NULL DEFAULT 0);
          INSERT INTO parent_new (id, extra) SELECT id, 0 FROM parent;
          DROP TABLE parent;
          ALTER TABLE parent_new RENAME TO parent;
        `,
      },
    ]);
    const child = db.prepare('SELECT id, parent_id FROM child').all() as Array<{ id: string; parent_id: string }>;
    expect(child).toEqual([{ id: 'c1', parent_id: 'p1' }]);
    const parent = db.prepare('SELECT id, extra FROM parent').get() as { id: string; extra: number };
    expect(parent).toEqual({ id: 'p1', extra: 0 });
    // Runner restores FK-on after needsFkOff migrations.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('baseline is version 1 and later migrations are strictly increasing', () => {
    expect(migrations[0].version).toBe(1);
    migrations.slice(1).forEach((m, i) => expect(m.version).toBeGreaterThan(migrations[i].version));
  });

  it('is a no-op on a DB already stamped with the baseline', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_migrations VALUES (1, 0)').run();
    runMigrations(db, migrations);
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name <> 'schema_migrations'").get()).toEqual({ c: 0 });
  });

  it('140 adds mcp_servers and conversations.mcp_servers (null default)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = (db.prepare('PRAGMA table_info(mcp_servers)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'transport', 'env', 'headers', 'allow_in_delegating', 'agent_types']));
    const conv = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string; dflt_value: unknown }>)
      .find((c) => c.name === 'mcp_servers');
    expect(conv).toBeDefined();
    expect(conv!.dflt_value).toBeNull();
  });

  it('baseline (ex-130) adds conversations.auto_tagged_at (null default)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'auto_tagged_at');
    expect(col).toBeDefined();
    expect(col!.dflt_value).toBeNull();
  });

  it('baseline (ex-129) adds schedule_jobs.capability_profile (null default)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = db.prepare("PRAGMA table_info('schedule_jobs')").all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'capability_profile');
    expect(col).toBeDefined();
    expect(col!.dflt_value).toBeNull();
  });

  it('baseline (ex-128) adds conversations.capability_profile (null default)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'capability_profile');
    expect(col).toBeDefined();
    expect(col!.dflt_value).toBeNull();
    // Existing rows read as NULL → resolved to the default 'all' profile.
    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'p', '/tmp', 0)").run();
    db.prepare(
      "INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c1', 'p1', 't', 0, 0)",
    ).run();
    const row = db.prepare("SELECT capability_profile FROM conversations WHERE id = 'c1'").get() as { capability_profile: string | null };
    expect(row.capability_profile).toBeNull();
  });

  it('baseline (ex-131) adds timer origin/attempt and spawn_edges.outcome', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const timerCols = db.prepare("PRAGMA table_info('conversation_timers')").all() as Array<{ name: string; dflt_value: string | null }>;
    const origin = timerCols.find((c) => c.name === 'origin');
    const attempt = timerCols.find((c) => c.name === 'attempt');
    expect(origin).toBeDefined();
    expect(String(origin!.dflt_value)).toMatch(/operator/);
    expect(attempt).toBeDefined();
    expect(Number(attempt!.dflt_value)).toBe(1);

    const edgeCols = db.prepare("PRAGMA table_info('spawn_edges')").all() as Array<{ name: string; dflt_value: string | null }>;
    const outcome = edgeCols.find((c) => c.name === 'outcome');
    expect(outcome).toBeDefined();
    expect(outcome!.dflt_value).toBeNull();

    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'p', '/tmp', 0)").run();
    db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c1', 'p1', 't', 0, 0)").run();
    db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c2', 'p1', 't2', 0, 0)").run();
    db.prepare(
      "INSERT INTO spawn_edges (id, parent_conversation_id, child_conversation_id, notify_parent, created_at) VALUES ('e1', 'c1', 'c2', 1, 0)",
    ).run();
    const edge = db.prepare("SELECT outcome FROM spawn_edges WHERE id = 'e1'").get() as { outcome: string | null };
    expect(edge.outcome).toBeNull();

    db.prepare(
      "INSERT INTO conversation_timers (id, conversation_id, prompt, profile_id, fire_at_ms, created_at) VALUES ('t1', 'c1', 'p', 'claude-code:x', 1, 0)",
    ).run();
    const timer = db.prepare("SELECT origin, attempt FROM conversation_timers WHERE id = 't1'").get() as { origin: string; attempt: number };
    expect(timer.origin).toBe('operator');
    expect(timer.attempt).toBe(1);
  });

  it('baseline (ex-132) caps one pending non-operator timer per conversation (adversary S2-7)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'p', '/tmp', 0)").run();
    db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c1', 'p1', 't', 0, 0)").run();
    const ins = (id: string, origin: string, extra = '') => db.prepare(
      `INSERT INTO conversation_timers (id, conversation_id, prompt, profile_id, fire_at_ms, created_at, origin${extra ? ', ' + extra : ''})
       VALUES (?, 'c1', 'p', 'claude-code:x', 1, 0, ?${extra ? ', ?' : ''})`,
    ).run(id, origin, ...(extra ? [5] : []));
    // First pending agent-resume timer is fine.
    ins('t1', 'agent-resume');
    // Second pending non-operator timer for the same conversation → constraint.
    expect(() => ins('t2', 'agent-resume')).toThrowError(/UNIQUE/);
    // Operator timers are exempt — multiple pending operator timers coexist.
    ins('o1', 'operator');
    ins('o2', 'operator');
    // Fired / cancelled non-operator rows don't count against the cap.
    ins('t3', 'agent-resume', 'fired_at');
    ins('t4', 'auto-resume', 'cancelled_at');
    const pending = db.prepare(
      "SELECT id FROM conversation_timers WHERE conversation_id = 'c1' AND origin <> 'operator' AND fired_at IS NULL AND cancelled_at IS NULL",
    ).all() as { id: string }[];
    expect(pending.map((r) => r.id)).toEqual(['t1']);
  });

  it('baseline (ex-135) adds conversation_timers.notify_parent (null default)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = db.prepare("PRAGMA table_info('conversation_timers')").all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'notify_parent');
    expect(col).toBeDefined();
    expect(col!.dflt_value).toBeNull();

    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'p', '/tmp', 0)").run();
    db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c1', 'p1', 't', 0, 0)").run();
    db.prepare(
      "INSERT INTO conversation_timers (id, conversation_id, prompt, profile_id, fire_at_ms, created_at) VALUES ('t1', 'c1', 'p', 'claude-code:x', 1, 0)",
    ).run();
    const row = db.prepare("SELECT notify_parent FROM conversation_timers WHERE id = 't1'").get() as { notify_parent: number | null };
    expect(row.notify_parent).toBeNull();
  });

  it('baseline (ex-138) creates global_tasks with SET NULL conversation FK and CASCADE project FK', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const cols = (db.prepare('PRAGMA table_info(global_tasks)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id','project_id','conversation_id','session_id','conversation_title','title','description','testing','progress','status','completed_by','created_at','updated_at','completed_at','hidden_at']));
    const fks = db.prepare('PRAGMA foreign_key_list(global_tasks)').all() as { table: string; on_delete: string }[];
    expect(fks.find((f) => f.table === 'projects')?.on_delete).toBe('CASCADE');
    expect(fks.find((f) => f.table === 'conversations')?.on_delete).toBe('SET NULL');
  });

  it('migration 141 adds conversations.permission_mode (null default, setConversationPermissionMode validation)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'permission_mode');
    expect(col).toBeDefined();
    expect(col!.dflt_value).toBeNull();

    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'p', '/tmp', 0)").run();
    db.prepare("INSERT INTO conversations (id, project_id, title, permission_mode, created_at, updated_at) VALUES ('c1', 'p1', 't', 'prompt', 0, 0)").run();
    const row = db.prepare("SELECT permission_mode FROM conversations WHERE id = 'c1'").get() as { permission_mode: string | null };
    expect(row.permission_mode).toBe('prompt');

    setConversationPermissionMode(db, 'c1', 'questions');
    expect(getConversation(db, 'c1')?.permissionMode).toBe('questions');

    setConversationPermissionMode(db, 'c1', null);
    expect(getConversation(db, 'c1')?.permissionMode).toBeUndefined();

    // Invalid value rejected by repository
    expect(() => {
      setConversationPermissionMode(db, 'c1', 'invalid' as any);
    }).toThrow();
  });

  it('migration 142 adds conversations.pending_handoff_mode (null default, allows fresh and summary)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'pending_handoff_mode');
    expect(col).toBeDefined();
    expect(col!.dflt_value).toBeNull();

    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'p', '/tmp', 0)").run();
    db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c1', 'p1', 't', 0, 0)").run();
    const unset = db.prepare("SELECT pending_handoff_mode FROM conversations WHERE id = 'c1'").get() as { pending_handoff_mode: string | null };
    expect(unset.pending_handoff_mode).toBeNull();

    db.prepare("UPDATE conversations SET pending_handoff_mode = 'fresh' WHERE id = 'c1'").run();
    expect((db.prepare("SELECT pending_handoff_mode FROM conversations WHERE id = 'c1'").get() as { pending_handoff_mode: string }).pending_handoff_mode).toBe('fresh');
    db.prepare("UPDATE conversations SET pending_handoff_mode = 'summary' WHERE id = 'c1'").run();
    expect((db.prepare("SELECT pending_handoff_mode FROM conversations WHERE id = 'c1'").get() as { pending_handoff_mode: string }).pending_handoff_mode).toBe('summary');
  });

  it('migration 143 adds projects.rules and conversations.rules (null default)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const projectCol = (db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string; dflt_value: string | null }>)
      .find((c) => c.name === 'rules');
    const convCol = (db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string; dflt_value: string | null }>)
      .find((c) => c.name === 'rules');
    expect(projectCol).toBeDefined();
    expect(projectCol!.dflt_value).toBeNull();
    expect(convCol).toBeDefined();
    expect(convCol!.dflt_value).toBeNull();

    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'p', '/tmp', 0)").run();
    db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c1', 'p1', 't', 0, 0)").run();
    expect((db.prepare("SELECT rules FROM projects WHERE id = 'p1'").get() as { rules: string | null }).rules).toBeNull();
    expect((db.prepare("SELECT rules FROM conversations WHERE id = 'c1'").get() as { rules: string | null }).rules).toBeNull();
  });

  it('migration 144 adds rule_presets and rule_preset_ids columns', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = (db.prepare("PRAGMA table_info('rule_presets')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'project_id', 'name', 'description', 'content', 'created_at', 'updated_at']));
    const proj = (db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>).map((c) => c.name);
    const conv = (db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(proj).toContain('rule_preset_ids');
    expect(conv).toContain('rule_preset_ids');
  });

  it('migration 145 adds remote_hosts and projects.remote_host_id', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = (db.prepare("PRAGMA table_info('remote_hosts')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'name', 'status', 'enroll_token_hash', 'hub_origin', 'hello',
      'transport', 'allow_mcp_secrets', 'created_at', 'updated_at',
    ]));
    const proj = (db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(proj).toContain('remote_host_id');
  });

  it('migration 148 adds conversations.sandbox and projects.sandbox (null default)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const convCol = (db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string; dflt_value: string | null }>)
      .find((c) => c.name === 'sandbox');
    const projCol = (db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string; dflt_value: string | null }>)
      .find((c) => c.name === 'sandbox');
    expect(convCol?.dflt_value).toBeNull();
    expect(projCol?.dflt_value).toBeNull();

    const project = createProject(db, { name: 'p', rootPath: '/tmp' });
    const conv = createConversation(db, { projectId: project.id, title: 'c' });

    setConversationSandbox(db, conv.id, 'on');
    expect(getConversation(db, conv.id)?.sandbox).toBe('on');
    setConversationSandbox(db, conv.id, null);
    expect(getConversation(db, conv.id)?.sandbox).toBeUndefined();
    expect(() => setConversationSandbox(db, conv.id, 'bogus' as 'on')).toThrow();

    updateProject(db, project.id, { sandbox: 'on' });
    expect(getProject(db, project.id)?.sandbox).toBe('on');
    updateProject(db, project.id, { sandbox: null });
    expect(getProject(db, project.id)?.sandbox).toBeUndefined();
    updateProject(db, project.id, { name: 'p2' });
    expect(getProject(db, project.id)?.sandbox).toBeUndefined();

    const sandboxed = createConversation(db, { projectId: project.id, title: 'src', sandbox: 'on' });
    db.prepare("INSERT INTO sessions (id, conversation_id, created_at, updated_at) VALUES ('s1', ?, 0, 0)").run(sandboxed.id);
    db.prepare("INSERT INTO events (id, session_id, type, payload, sender, seq, ts) VALUES ('e1', 's1', 'message', '{}', 'agent', 0, 1)").run();
    const forked = forkConversation(db, sandboxed.id, 'e1');
    expect(forked.sandbox).toBe('on');
    const dup = duplicateConversation(db, sandboxed.id);
    expect(dup.sandbox).toBe('on');
  });

  it('migration 151 adds remote_hosts.description', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const cols = (db.prepare("PRAGMA table_info('remote_hosts')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('description');
  });

  it('migration 149 moves compaction.sandbox into settings.sandbox and adds projects.sandbox_paths', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sandbox'").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ global: false, defaults: [], hostPaths: {} });
    const proj = (db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(proj).toContain('sandbox_paths');
  });

  it('migration 155 adds projects.agent_search_scope (null default, CHECK)', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const col = (db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string; dflt_value: string | null }>)
      .find((c) => c.name === 'agent_search_scope');
    expect(col).toBeDefined();
    expect(col!.dflt_value).toBeNull();

    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'p', '/tmp', 0)").run();
    expect((db.prepare("SELECT agent_search_scope FROM projects WHERE id = 'p1'").get() as { agent_search_scope: string | null }).agent_search_scope).toBeNull();
    db.prepare("UPDATE projects SET agent_search_scope = 'all' WHERE id = 'p1'").run();
    expect((db.prepare("SELECT agent_search_scope FROM projects WHERE id = 'p1'").get() as { agent_search_scope: string | null }).agent_search_scope).toBe('all');
    expect(() => db.prepare("UPDATE projects SET agent_search_scope = 'bogus' WHERE id = 'p1'").run())
      .toThrow();
  });
});
