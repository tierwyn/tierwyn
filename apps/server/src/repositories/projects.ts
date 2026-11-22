import { randomUUID } from 'crypto';
import { join } from 'path';
import type { Database } from 'better-sqlite3';
import type { AgentSearchScopeSetting, Project, SandboxPath, SandboxSetting } from '@tierwyn/shared';
import { parseSandboxPathList } from '@tierwyn/shared';

import { parsePresetIdCell, serialisePresetIds } from './rulePresets.js';
import { getTtsRecordingsDir } from './ttsRecordings.js';
import { dropMeshEdgesTouching, noteConversationsChanged } from './conversations.js';

interface Row {
  id: string;
  name: string;
  root_path: string;
  created_at: number;
  system?: number;
  rules?: string | null;
  rule_preset_ids?: string | null;
  remote_host_id?: string | null;
  trust_repo_config?: number | null;
  sandbox?: string | null;
  sandbox_paths?: string | null;
  agent_search_scope?: string | null;
}

function toProject(r: Row): Project {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    createdAt: r.created_at,
    system: r.system === 1 ? true : undefined,
    ...(r.rules ? { rules: r.rules } : {}),
    ...(() => {
      const ids = parsePresetIdCell(r.rule_preset_ids);
      return ids ? { rulePresetIds: ids } : {};
    })(),
    ...(r.remote_host_id ? { remoteHostId: r.remote_host_id } : {}),
    trustRepoConfig: r.trust_repo_config === 1,
    ...(r.sandbox === 'on' || r.sandbox === 'off' ? { sandbox: r.sandbox } : {}),
    ...(r.agent_search_scope === 'off' || r.agent_search_scope === 'project' || r.agent_search_scope === 'all'
      ? { agentSearchScope: r.agent_search_scope } : {}),
    ...(() => {
      if (!r.sandbox_paths) return {};
      try {
        const parsed = parseSandboxPathList(JSON.parse(r.sandbox_paths));
        return parsed.ok && parsed.paths?.length ? { sandboxPaths: parsed.paths } : {};
      } catch {
        return {};
      }
    })(),
  };
}

export function createProject(db: Database, input: { name: string; rootPath: string; remoteHostId?: string }): Project {
  const row: Row = {
    id: randomUUID(),
    name: input.name,
    root_path: input.rootPath,
    created_at: Date.now(),
    remote_host_id: input.remoteHostId ?? null,
  };
  // `system` is not listed: a request body carrying `"system": true` is ignored
  // and the column defaults to 0. Only ensureRemoteAgentsProject() sets it.
  db.prepare('INSERT INTO projects (id, name, root_path, created_at, remote_host_id) VALUES (?,?,?,?,?)')
    .run(row.id, row.name, row.root_path, row.created_at, row.remote_host_id ?? null);
  return toProject(row);
}

export function listProjects(db: Database): Project[] {
  return (db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Row[]).map(toProject);
}

export function getProject(db: Database, id: string): Project | undefined {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
  return r ? toProject(r) : undefined;
}

/**
 * Patch a project's name and/or root_path. `created_at` stays immutable.
 * Returns undefined when the id does not exist (route layer turns that into 404).
 * ponytail: no updated_at column exists and none is added.
 */
export function updateProject(
  db: Database,
  id: string,
  patch: { name?: string; rootPath?: string; rules?: string | null; rulePresetIds?: string[] | null; trustRepoConfig?: boolean | null; sandbox?: SandboxSetting | null; sandboxPaths?: SandboxPath[] | null; agentSearchScope?: AgentSearchScopeSetting | null },
): Project | undefined {
  const existing = getProject(db, id);
  if (!existing) return undefined;
  const name = patch.name ?? existing.name;
  const rootPath = patch.rootPath ?? existing.rootPath;
  const rules = Object.prototype.hasOwnProperty.call(patch, 'rules')
    ? (patch.rules ?? null)
    : (existing.rules ?? null);
  const rulePresetIds = Object.prototype.hasOwnProperty.call(patch, 'rulePresetIds')
    ? serialisePresetIds(patch.rulePresetIds)
    : serialisePresetIds(existing.rulePresetIds);
  const trustRepoConfig = Object.prototype.hasOwnProperty.call(patch, 'trustRepoConfig')
    ? (patch.trustRepoConfig ? 1 : 0)
    : (existing.trustRepoConfig ? 1 : 0);
  const sandbox = Object.prototype.hasOwnProperty.call(patch, 'sandbox')
    ? (patch.sandbox ?? null)
    : (existing.sandbox ?? null);
  const sandboxPaths = Object.prototype.hasOwnProperty.call(patch, 'sandboxPaths')
    ? (patch.sandboxPaths ? JSON.stringify(patch.sandboxPaths) : null)
    : (existing.sandboxPaths ? JSON.stringify(existing.sandboxPaths) : null);
  const agentSearchScope = Object.prototype.hasOwnProperty.call(patch, 'agentSearchScope')
    ? (patch.agentSearchScope ?? null)
    : (existing.agentSearchScope ?? null);
  db.prepare('UPDATE projects SET name = ?, root_path = ?, rules = ?, rule_preset_ids = ?, trust_repo_config = ?, sandbox = ?, sandbox_paths = ?, agent_search_scope = ? WHERE id = ?')
    .run(name, rootPath, rules, rulePresetIds, trustRepoConfig, sandbox, sandboxPaths, agentSearchScope, id);
  return getProject(db, id);
}

/** Rename-only wrapper kept for existing call sites. */
export function updateProjectName(db: Database, id: string, name: string): Project | undefined {
  return updateProject(db, id, { name });
}

/**
 * Atomic move of a project's root_path, rewriting prefixed workdir_paths for its
 * conversations and prefixed cwds in git_commit_drafts.
 * Throws if root_path changed concurrently.
 */
export function moveProjectRoot(db: Database, id: string, from: string, to: string): Project | undefined {
  const existing = getProject(db, id);
  if (!existing) return undefined;
  if (existing.rootPath !== from) {
    throw new Error('root_path changed concurrently');
  }

  const tx = db.transaction(() => {
    const pRes = db.prepare(
      'UPDATE projects SET root_path = ? WHERE id = ? AND root_path = ?'
    ).run(to, id, from);
    if (pRes.changes === 0) {
      throw new Error('root_path changed concurrently');
    }

    const n = from.length;
    db.prepare(`
      UPDATE conversations
      SET workdir_path = ? || substr(workdir_path, ? + 1)
      WHERE project_id = ?
        AND (workdir_path = ? OR substr(workdir_path, 1, ? + 1) = ? || '/')
    `).run(to, n, id, from, n, from);

    const fromKey = existing.remoteHostId ? `remote:${existing.remoteHostId}:${from}` : from;
    const toKey = existing.remoteHostId ? `remote:${existing.remoteHostId}:${to}` : to;
    const nKey = fromKey.length;

    db.prepare(`
      UPDATE OR REPLACE git_commit_drafts
      SET cwd = ? || substr(cwd, ? + 1)
      WHERE cwd = ? OR substr(cwd, 1, ? + 1) = ? || '/'
    `).run(toKey, nKey, fromKey, nKey, fromKey);

    noteConversationsChanged([id], {});
  });

  tx();
  return getProject(db, id);
}

export interface DeleteProjectResult {
  ok: boolean;
  /** TTS WAV absolute paths to unlink after the DB tx (rows already gone). */
  ttsWavPaths: string[];
}

/**
 * Delete a project and every conversation under it, plus all cascaded child
 * rows. Explicit transaction cascade so the result is correct regardless of
 * the PRAGMA foreign_keys state (defense-in-depth alongside the FK CASCADE
 * clauses). `spawn_requests.parent_conversation_id` has no ON DELETE clause
 * in the original schema (migration 025) — migration 028 adds CASCADE, but
 * the explicit DELETE here keeps this safe even pre-migration / on a DB
 * where the pragma is off.
 *
 * Also reclaims project-scoped TTS recordings (including project-only rows
 * with NULL conversation_id that conversation deletes would miss).
 *
 * On-disk project directory is intentionally NOT touched.
 */
export function deleteProject(db: Database, id: string): DeleteProjectResult {
  // Collect WAV paths before rows vanish (project_id CASCADE + explicit DELETE).
  let ttsWavPaths: string[] = [];
  try {
    const rows = db.prepare(
      'SELECT id FROM tts_recordings WHERE project_id = ?',
    ).all(id) as { id: string }[];
    const dir = getTtsRecordingsDir();
    ttsWavPaths = rows.map((r) => join(dir, `${r.id}.wav`));
  } catch {
    ttsWavPaths = [];
  }

  const convIds = (db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(id) as { id: string }[])
    .map((r) => r.id);

  const tx = db.transaction(() => {
    // Explicit TTS reclaim (includes project-only rows) before conversations go.
    try {
      db.prepare('DELETE FROM tts_recordings WHERE project_id = ?').run(id);
    } catch { /* pre-migration */ }
    if (convIds.length) {
      const placeholders = convIds.map(() => '?').join(',');
      // Tables whose FK has NO ON DELETE clause — clear first.
      db.prepare(`DELETE FROM spawn_requests WHERE parent_conversation_id IN (${placeholders})`).run(...convIds);
      // schedule_jobs.home/bound_conversation_id, schedule_runs.conversation_id
      // and spawn_edges reference conversations with NO ON DELETE — a project
      // with a schedule (or any spawn) used to throw FOREIGN KEY here, roll the
      // tx back and crash the hub from the async route. Jobs go first
      // (runs + steps cascade); then detach cross-project leftovers.
      db.prepare('DELETE FROM schedule_jobs WHERE project_id = ?').run(id);
      db.prepare(`UPDATE schedule_runs SET conversation_id = NULL WHERE conversation_id IN (${placeholders})`).run(...convIds);
      db.prepare(`UPDATE schedule_jobs SET bound_conversation_id = NULL WHERE bound_conversation_id IN (${placeholders})`).run(...convIds);
      db.prepare(`DELETE FROM spawn_edges WHERE parent_conversation_id IN (${placeholders}) OR child_conversation_id IN (${placeholders})`)
        .run(...convIds, ...convIds);
      dropMeshEdgesTouching(db, convIds);
      // The rest would cascade via FK, but explicit is safer + matches
      // deleteConversation's style.
      db.prepare(`DELETE FROM checkpoints WHERE conversation_id IN (${placeholders})`).run(...convIds);
      db.prepare(`DELETE FROM handoffs WHERE conversation_id IN (${placeholders})`).run(...convIds);
      db.prepare(`DELETE FROM summaries WHERE conversation_id IN (${placeholders})`).run(...convIds);
      db.prepare(`DELETE FROM btw_queries WHERE parent_conv_id IN (${placeholders}) OR child_conv_id IN (${placeholders})`)
        .run(...convIds, ...convIds);
      db.prepare(`DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE conversation_id IN (${placeholders}))`)
        .run(...convIds);
      db.prepare(`DELETE FROM sessions WHERE conversation_id IN (${placeholders})`).run(...convIds);
      db.prepare('DELETE FROM conversations WHERE project_id = ?').run(id);
    }
    // shell_allow is keyed by project_id (not conversation); a project with zero
    // conversations can still hold rules — delete outside the convIds guard.
    db.prepare('DELETE FROM shell_allow WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM global_tasks WHERE project_id = ?').run(id);
    try {
      db.prepare('DELETE FROM rule_presets WHERE project_id = ?').run(id);
    } catch { /* pre-migration 144 */ }
    const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return info.changes > 0;
  });
  const ok = tx();
  if (ok) noteConversationsChanged([id], { deleted: convIds });
  return { ok, ttsWavPaths: ok ? ttsWavPaths : [] };
}

/** Number of conversations under a project. Used by the route layer for diagnostics. */
export function countConversations(db: Database, projectId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_id = ?').get(projectId) as { n: number }).n;
}
