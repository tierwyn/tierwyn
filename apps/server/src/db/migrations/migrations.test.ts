import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { migrations } from './index.js';

const EXPECTED_TABLES = [
  'agent_commands', 'agent_model_overrides', 'agent_models', 'agents',
  'btw_queries', 'checkpoints',
  'conversations', 'conversation_timers', 'decision_usage', 'draft_prompts',
  'event_fts', 'event_fts_buffer', 'event_fts_config', 'event_fts_data',
  'event_fts_docsize', 'event_fts_idx',
  'events', 'git_commit_drafts', 'global_tasks', 'handoffs', 'plugin_invocations', 'plugin_secrets', 'projects',
  'push_subscriptions',
  'schedule_jobs', 'schedule_packs', 'schedule_runs', 'schedule_steps', 'sessions', 'settings',
  'mcp_servers', 'memories', 'memories_fts', 'memories_fts_config', 'memories_fts_content',
  'memories_fts_data', 'memories_fts_docsize', 'memories_fts_idx',
  'mesh_edges', 'mesh_messages', 'remote_hosts', 'rule_presets',
  'shell_allow', 'spawn_edges', 'spawn_requests', 'summaries', 'tts_recordings',
];

function fresh() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}
const cols = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe('baseline schema', () => {
  it('creates exactly the expected table set', () => {
    const names = (fresh().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as { name: string }[]).map((r) => r.name).sort();
    expect(names).toEqual([...EXPECTED_TABLES, 'schema_migrations'].sort());
  });

  it('is idempotent — re-applying the SQL directly changes nothing', () => {
    const db = fresh();
    const snap = () => JSON.stringify(db.prepare(
      'SELECT type, name, sql FROM sqlite_master ORDER BY type, name'
    ).all());
    const before = snap();
    db.exec(migrations[0].sql);           // simulate re-run against a populated DB
    expect(snap()).toBe(before);
  });

  it('enforces the events → sessions foreign key', () => {
    const db = fresh();
    expect(() => db.prepare(
      'INSERT INTO events (id, session_id, type, payload, sender, ts) VALUES (?,?,?,?,?,?)'
    ).run('e1', 'no-such-session', 'message', '{}', 'agent', Date.now())).toThrow();
  });

  // Columns added by legacy migrations 009/012/016/017/031 — asserted here so the
  // squash cannot silently drop one.
  it('carries the columns the squashed chain accumulated', () => {
    const db = fresh();
    expect(cols(db, 'agent_models')).toEqual(expect.arrayContaining([
      'source', 'max_concurrent_spawns', 'max_grandchild_spawns', 'context_window',
    ]));
    expect(cols(db, 'sessions')).toContain('tokens_estimated');
    expect(cols(db, 'conversations')).toEqual(expect.arrayContaining([
      'parent_conversation_id', 'template_name', 'workdir_path', 'spawn_workdir',
      'last_viewed_at', 'kind', 'schedule_job_id', 'tags', 'designation',
    ]));
    expect(cols(db, 'draft_prompts')).toEqual(expect.arrayContaining([
      'auto_send', 'auto_send_profile_id', 'auto_send_agent', 'auto_send_model', 'profile_id',
    ]));
    expect(cols(db, 'projects')).toContain('system');
  });

  // FW-15 (migration 111): the column must exist AND default to an empty JSON
  // array, because the repository mapper JSON.parses it on every list row.
  it('adds conversations.tags defaulting to an empty JSON array', () => {
    const db = fresh();
    const col = (db.prepare('PRAGMA table_info(conversations)').all() as {
      name: string; type: string; notnull: number; dflt_value: string | null;
    }[]).find((c) => c.name === 'tags');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toBe("'[]'");
    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p','P','/p',1)").run();
    db.prepare(
      'INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)'
    ).run('c', 'p', 'C', 1, 1);
    expect(
      (db.prepare('SELECT tags FROM conversations WHERE id = ?').get('c') as { tags: string }).tags,
    ).toBe('[]');
  });

  // Columns legacy migration 032 dropped — negative assertions guard against a
  // baseline regenerated from a drifted source reintroducing them.
  it('does not carry the columns migration 032 dropped', () => {
    const db = fresh();
    expect(cols(db, 'agent_models')).not.toContain('default_workdir');
    expect(cols(db, 'spawn_requests')).not.toContain('cwd');
    // prod.db carries an orphan conversations.preferred_profile_id that no code
    // reads; it must not be canonicalised into fresh installs.
    expect(cols(db, 'conversations')).not.toContain('preferred_profile_id');
  });

  it('creates spawn_requests with its full column set and both indexes', () => {
    const db = fresh();
    expect(cols(db, 'spawn_requests')).toEqual(expect.arrayContaining([
      'id', 'parent_conversation_id', 'parent_session_id', 'role', 'profile_id',
      'prompt', 'workdir', 'wait', 'notify_parent', 'designation', 'status',
      'child_conversation_id', 'created_at', 'decided_at', 'decided_by', 'error',
    ]));
    const idx = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='spawn_requests'"
    ).all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining([
      'idx_spawn_requests_parent', 'idx_spawn_requests_pending',
    ]));
  });

  // Legacy 028 — the FK must be ON DELETE CASCADE, not merely present.
  it('cascades spawn_requests on parent conversation delete', () => {
    const db = fresh();
    db.prepare('INSERT INTO projects (id,name,root_path,created_at) VALUES (?,?,?,?)')
      .run('p', 'p', '/tmp', Date.now());
    db.prepare('INSERT INTO conversations (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('c', 'p', 't', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO spawn_requests (id, parent_conversation_id, parent_session_id, prompt, status, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run('sr', 'c', 'sess', 'x', 'pending', Date.now());
    db.prepare('DELETE FROM conversations WHERE id = ?').run('c');
    expect((db.prepare("SELECT COUNT(*) c FROM spawn_requests WHERE id='sr'").get() as { c: number }).c).toBe(0);
  });

  // Legacy 042 — project_id is the durable home; conversation_id is optional.
  it('tts_recordings requires project_id and allows a null conversation_id', () => {
    const db = fresh();
    db.prepare('INSERT INTO projects (id,name,root_path,created_at) VALUES (?,?,?,?)')
      .run('p', 'P', '/p', Date.now());
    db.prepare(
      `INSERT INTO tts_recordings
         (id, project_id, conversation_id, created_at, source, mode, provider, voice, title, spoken_text, path, bytes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('r1', 'p', null, Date.now(), 'file', 'as-is', 'piper', 'v', 't', 't', 'a.wav', 4);
    expect((db.prepare('SELECT conversation_id FROM tts_recordings WHERE id=?')
      .get('r1') as { conversation_id: string | null }).conversation_id).toBeNull();

    expect(() => db.prepare(
      `INSERT INTO tts_recordings
         (id, project_id, conversation_id, created_at, source, mode, provider, voice, title, spoken_text, path, bytes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('r2', null, null, Date.now(), 'file', 'as-is', 'piper', 'v', 't', 't', 'b.wav', 4)).toThrow();
  });

  // Legacy 038 — schedule_kind CHECK must accept 'once'.
  it("schedule_jobs accepts schedule_kind 'once' and rejects garbage", () => {
    const db = fresh();
    const kinds = db.prepare("SELECT sql FROM sqlite_master WHERE name='schedule_jobs'").get() as { sql: string };
    expect(kinds.sql).toContain("schedule_kind IN ('interval','cron','once')");
  });

  // FW-7 (migration 110): context_window must be a NULLABLE integer with no
  // default — NULL means "window unknown", and a 0 default would be
  // indistinguishable from a real (impossible) zero-size window.
  it('adds a nullable integer agent_models.context_window with no default', () => {
    const db = fresh();
    const col = (db.prepare("PRAGMA table_info(agent_models)").all() as {
      name: string; type: string; notnull: number; dflt_value: string | null;
    }[]).find((c) => c.name === 'context_window');
    expect(col).toBeDefined();
    expect(col!.type).toBe('INTEGER');
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();

    // A row may be inserted without it, and it reads back as NULL.
    db.prepare("INSERT INTO agents (id,type,label,description,executable_path,env_vars,created_at) VALUES ('pi','pi','Pi','',NULL,'{}',0)").run();
    db.prepare(
      `INSERT INTO agent_models (id, agent_id, model_name, label, provider, vision_flag, steer_flag, enabled_flag, description, source, created_at)
       VALUES ('pi:x','pi','x','Pi · x',NULL,0,0,1,'','discovered',0)`
    ).run();
    const row = db.prepare("SELECT context_window FROM agent_models WHERE id='pi:x'")
      .get() as { context_window: number | null };
    expect(row.context_window).toBeNull();
  });

  // Migration 124: timers die with their conversation (FK cascade, not a manual
  // DELETE in repositories/conversations.ts).
  it('cascades conversation_timers on conversation delete', () => {
    const db = fresh();
    db.prepare('INSERT INTO projects (id,name,root_path,created_at) VALUES (?,?,?,?)')
      .run('p', 'P', '/tmp', Date.now());
    db.prepare('INSERT INTO conversations (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('c', 'p', 't', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO conversation_timers (id, conversation_id, prompt, profile_id, fire_at_ms, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('t1', 'c', 'ping', 'claude-code:x', Date.now() + 60_000, Date.now());
    db.prepare('DELETE FROM conversations WHERE id = ?').run('c');
    expect((db.prepare("SELECT COUNT(*) c FROM conversation_timers").get() as { c: number }).c).toBe(0);
  });

  // Schema the 101-127 chain accumulated (squashed 2026-09-26).
  it('carries the columns the 101-127 chain accumulated', () => {
    const db = fresh();
    expect(cols(db, 'btw_queries')).toContain('forked_conv_id');
    expect(cols(db, 'sessions')).toContain('preamble_fp');
    expect(cols(db, 'schedule_jobs')).toContain('variables');
    expect(cols(db, 'schedule_jobs')).toContain('capability_profile');
    expect(cols(db, 'plugin_secrets')).toContain('key_id');
    expect(cols(db, 'agents')).toContain('enabled_flag');
    expect(cols(db, 'conversations')).toEqual(expect.arrayContaining(['pinned', 'archived', 'description', 'description_source']));
    expect(cols(db, 'conversation_timers')).toEqual(expect.arrayContaining([
      'id', 'conversation_id', 'prompt', 'profile_id', 'fire_at_ms', 'created_at',
      'cancelled_at', 'fired_at', 'error', 'effort', 'options', 'attachments', 'handoff_override',
    ]));
    expect(db.pragma('foreign_key_list(mesh_edges)')).toEqual([]);
    expect(db.pragma('foreign_key_list(mesh_messages)')).toEqual([]);
  });
  describe('139 handoffs fresh requested_mode', () => {
    const ins = (db: Database.Database, id: string, mode: string) => db.prepare(
      "INSERT INTO handoffs (id, conversation_id, from_profile_id, to_profile_id, requested_mode, resolved_mode, anchor_event_id, created_at) VALUES (?, 'c', 'a', 'b', ?, 'fresh', 'e', 1)"
    ).run(id, mode);
    const seed = (db: Database.Database) => {
      db.prepare("INSERT INTO projects (id,name,root_path,created_at) VALUES ('p','P','/p',1)").run();
      db.prepare('INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)').run('c', 'p', 't', 1, 1);
    };

    it('accepts fresh, still rejects bogus, keeps both indexes', () => {
      const db = fresh();
      seed(db);
      ins(db, 'h1', 'fresh');
      expect(() => ins(db, 'h2', 'bogus')).toThrow(/CHECK/);
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='handoffs'").all() as { name: string }[]).map((r) => r.name);
      expect(idx).toEqual(expect.arrayContaining(['idx_handoffs_anchor', 'idx_handoffs_conversation']));
    });

  });

  describe('145 remote_hosts', () => {
    it("creates remote_hosts with allow_mcp_secrets default 1 and transport default 'wss'", () => {
      const db = fresh();
      db.prepare("INSERT INTO remote_hosts (id, name, created_at, updated_at) VALUES ('h','H',1,1)").run();
      const row = db.prepare('SELECT allow_mcp_secrets, transport FROM remote_hosts WHERE id=?')
        .get('h') as { allow_mcp_secrets: number; transport: string };
      expect(row.allow_mcp_secrets).toBe(1);
      expect(row.transport).toBe('wss');
    });

    it('projects.remote_host_id exists', () => {
      expect(cols(fresh(), 'projects')).toContain('remote_host_id');
    });
  });

  describe('146 mcp placement', () => {
    it("adds mcp_servers.placement defaulting to 'auto', CHECK-constrained", () => {
      const db = fresh();
      const col = (db.prepare('PRAGMA table_info(mcp_servers)').all() as {
        name: string; dflt_value: string | null;
      }[]).find((c) => c.name === 'placement');
      expect(col?.dflt_value).toBe("'auto'");
      // a row that existed before 146 (no placement value supplied) reads back 'auto'
      db.prepare(
        "INSERT INTO mcp_servers (id, transport, created_at, updated_at) VALUES ('s1', 'stdio', 1, 1)",
      ).run();
      expect(db.prepare('SELECT placement FROM mcp_servers WHERE id = ?').get('s1'))
        .toEqual({ placement: 'auto' });
      expect(() => db.prepare(
        "INSERT INTO mcp_servers (id, transport, created_at, updated_at, placement) VALUES ('s2', 'stdio', 1, 1, 'cloud')",
      ).run()).toThrow(/CHECK|constraint/i);
    });
  });

  describe('147 project trust_repo_config', () => {
    it('adds projects.trust_repo_config defaulting to 0', () => {
      const db = fresh();
      expect(cols(db, 'projects')).toContain('trust_repo_config');
      db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'P1', '/tmp/p1', 1)").run();
      const row = db.prepare('SELECT trust_repo_config FROM projects WHERE id = ?').get('p1') as { trust_repo_config: number };
      expect(row.trust_repo_config).toBe(0);
    });
  });

  describe('148 sandbox', () => {
    it('adds conversations.sandbox and projects.sandbox defaulting to null', () => {
      const db = fresh();
      expect(cols(db, 'conversations')).toContain('sandbox');
      expect(cols(db, 'projects')).toContain('sandbox');
      db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'P1', '/tmp/p1', 1)").run();
      db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c1', 'p1', 't', 1, 1)").run();
      expect((db.prepare('SELECT sandbox FROM projects WHERE id = ?').get('p1') as { sandbox: string | null }).sandbox).toBeNull();
      expect((db.prepare('SELECT sandbox FROM conversations WHERE id = ?').get('c1') as { sandbox: string | null }).sandbox).toBeNull();
    });
  });

  describe('149 sandbox wave 2', () => {

    it('fresh DB seeds a default sandbox settings row', () => {
      const db = fresh();
      const row = db.prepare("SELECT value FROM settings WHERE key = 'sandbox'").get() as { value: string };
      expect(JSON.parse(row.value)).toEqual({ global: false, defaults: [], hostPaths: {} });
    });

    it('re-run is a no-op (already stamped)', () => {
      const db = fresh();
      const before = db.prepare("SELECT value FROM settings WHERE key = 'sandbox'").get();
      runMigrations(db, migrations);
      expect(db.prepare("SELECT value FROM settings WHERE key = 'sandbox'").get()).toEqual(before);
    });
  });

  describe('150 remote_hosts.auto_trust', () => {
    it('adds auto_trust NOT NULL DEFAULT 1', () => {
      const db = fresh();
      const col = (db.prepare('PRAGMA table_info(remote_hosts)').all() as {
        name: string; type: string; notnull: number; dflt_value: string | null;
      }[]).find((c) => c.name === 'auto_trust');
      expect(col).toBeDefined();
      expect(col!.type).toBe('INTEGER');
      expect(col!.notnull).toBe(1);
      expect(col!.dflt_value).toBe('1');
    });
  });

  describe('151 remote_hosts.description', () => {
    it('adds a nullable description column', () => {
      const db = fresh();
      const col = (db.prepare('PRAGMA table_info(remote_hosts)').all() as {
        name: string; type: string; notnull: number; dflt_value: string | null;
      }[]).find((c) => c.name === 'description');
      expect(col).toBeDefined();
      expect(col!.type).toBe('TEXT');
      expect(col!.notnull).toBe(0);
      expect(col!.dflt_value).toBeNull();
    });
  });

  describe('152 remote_hosts.allow_agent_env_secrets', () => {
    it('adds a NOT NULL DEFAULT 0 toggle', () => {
      const db = fresh();
      const col = (db.prepare('PRAGMA table_info(remote_hosts)').all() as {
        name: string; type: string; notnull: number; dflt_value: string | null;
      }[]).find((c) => c.name === 'allow_agent_env_secrets');
      expect(col).toBeDefined();
      expect(col!.type).toBe('INTEGER');
      expect(col!.notnull).toBe(1);
      expect(col!.dflt_value).toBe('0');
    });

    it('pre-existing rows default to 0', () => {
      const db = fresh();
      db.prepare("INSERT INTO remote_hosts (id, name, created_at, updated_at) VALUES ('h1', 'box', 0, 0)").run();
      const row = db.prepare('SELECT allow_agent_env_secrets FROM remote_hosts LIMIT 1').get() as
        { allow_agent_env_secrets: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.allow_agent_env_secrets).toBe(0);
    });
  });

  describe('153 memories', () => {
    it('creates memories with AUTOINCREMENT and memories_fts', () => {
      const db = fresh();
      expect(cols(db, 'memories')).toEqual(expect.arrayContaining([
        'id', 'project_id', 'kind', 'text', 'status', 'superseded_by',
        'rule_suggestion', 'rule_reason', 'flag_reason',
        'created_by_agent', 'created_by_conversation', 'created_at',
      ]));
      const names = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memories%'",
      ).all() as { name: string }[]).map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(['memories', 'memories_fts']));
    });
  });

  describe('154 events startup indexes', () => {
    const plan = (db: Database.Database, sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join('\n');

    it('closeStaleSessions and listOrphanShellToolCalls never full-scan events', () => {
      const db = fresh();
      const stale = plan(db, `SELECT e.session_id FROM events e JOIN sessions s ON s.id = e.session_id
        WHERE e.type = 'status' AND json_extract(e.payload, '$.status') = 'running'
          AND NOT EXISTS (SELECT 1 FROM events e2 WHERE e2.session_id = e.session_id AND e2.type = 'status'
            AND json_extract(e2.payload, '$.status') IN ('done', 'error', 'idle'))
        GROUP BY e.session_id`);
      expect(stale).toContain('idx_events_status_session');
      const orphan = plan(db, `SELECT json_extract(c.payload,'$.toolUseId') FROM events c JOIN sessions s ON s.id = c.session_id
        WHERE c.type = 'tool_call' AND c.sender = 'user' AND json_extract(c.payload,'$.name') = 'shell'
          AND json_extract(c.payload,'$.toolUseId') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM events r WHERE r.type = 'tool_result'
            AND json_extract(r.payload,'$.toolUseId') = json_extract(c.payload,'$.toolUseId'))`);
      expect(orphan).toContain('idx_events_user_tool_call');
      expect(orphan).toContain('idx_events_tool_result_use_id');
      expect(orphan).not.toMatch(/SCAN (c|r)$/m);
    });
  });

  describe('155 project agent_search_scope', () => {
    it('adds projects.agent_search_scope nullable TEXT', () => {
      const db = fresh();
      const col = (db.prepare("PRAGMA table_info('projects')").all() as {
        name: string; type: string; notnull: number; dflt_value: string | null;
      }[]).find((c) => c.name === 'agent_search_scope');
      expect(col).toBeDefined();
      expect(col!.type).toBe('TEXT');
      expect(col!.notnull).toBe(0);
      expect(col!.dflt_value).toBeNull();
    });
  });

  describe('156 conversation effort', () => {
    it('adds conversations.effort nullable TEXT', () => {
      const db = fresh();
      const col = (db.prepare("PRAGMA table_info('conversations')").all() as {
        name: string; type: string; notnull: number;
      }[]).find((c) => c.name === 'effort');
      expect(col).toMatchObject({ type: 'TEXT', notnull: 0 });
    });
  });
});
