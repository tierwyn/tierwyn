import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { validateMcpServerInput } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { upsertMcpServer } from './registry.js';
import { resolveSessionMcp } from './resolve.js';

let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrations);
});

function addRow(spec: Record<string, unknown>): void {
  const row = validateMcpServerInput(spec);
  if (!row.ok) throw new Error(row.error);
  upsertMcpServer(db, row.value);
}

const base = { agentType: 'claude-code', delegating: false };

describe('resolveSessionMcp remote hub placement', () => {
  it('skips a hub-placed stdio row without remoteStreaming', () => {
    addRow({ id: 'stdio-hub', transport: 'stdio', command: 'echo', placement: 'hub' });
    const r = resolveSessionMcp({
      ...base,
      db,
      conv: { mcpServers: ['stdio-hub'] },
      template: undefined,
      remoteHostId: 'rh-1',
    });
    expect(r.inject).toEqual([]);
    expect(r.skipped).toEqual([{ id: 'stdio-hub', reason: 'hub_placement_unsupported' }]);
  });

  it('resolves hub-placed stdio rows for remote sessions with remoteStreaming', () => {
    addRow({ id: 'stdio-hub', transport: 'stdio', command: 'echo', args: ['-y', 'srv'], placement: 'hub' });
    addRow({ id: 'sse-hub', transport: 'sse', url: 'http://127.0.0.1:9999/sse', placement: 'hub' });
    const r = resolveSessionMcp({
      ...base,
      db,
      conv: { mcpServers: ['stdio-hub', 'sse-hub'] },
      template: undefined,
      remoteHostId: 'rh-1',
      remoteStreaming: true,
    });
    expect(r.skipped).toEqual([]);
    expect(r.inject.map((s) => s.id)).toEqual(['stdio-hub', 'sse-hub']);
    expect(r.inject.every((s) => s.placement === 'hub')).toBe(true);
  });

  it('still resolves http hub rows when the host cannot stream (buffered fallback)', () => {
    addRow({ id: 'http-hub', transport: 'http', url: 'http://127.0.0.1:9999/mcp', placement: 'hub' });
    const r = resolveSessionMcp({
      ...base,
      db,
      conv: { mcpServers: ['http-hub'] },
      template: undefined,
      remoteHostId: 'rh-1',
    });
    expect(r.skipped).toEqual([]);
    expect(r.inject).toHaveLength(1);
  });

  it('skips hub stdio rows whose args/cwd reference ${TIERWYN_CWD} as hub_cwd_unresolvable', () => {
    addRow({ id: 'stdio-cwd', transport: 'stdio', command: 'echo', args: ['--root', '${TIERWYN_CWD}'], placement: 'hub' });
    addRow({ id: 'stdio-cwd2', transport: 'stdio', command: 'echo', cwd: '${TIERWYN_CWD}', placement: 'hub' });
    const r = resolveSessionMcp({
      ...base,
      db,
      conv: { mcpServers: ['stdio-cwd', 'stdio-cwd2'] },
      template: undefined,
      remoteHostId: 'rh-1',
      remoteStreaming: true,
    });
    expect(r.inject).toEqual([]);
    expect(r.skipped).toEqual([
      { id: 'stdio-cwd', reason: 'hub_cwd_unresolvable' },
      { id: 'stdio-cwd2', reason: 'hub_cwd_unresolvable' },
    ]);
  });

  it('expands ${TIERWYN_CWD} in args and cwd on local inject when agentCwd is set', () => {
    addRow({ id: 'cwd-new', transport: 'stdio', command: 'echo', args: ['--root', '${TIERWYN_CWD}/src'] });
    addRow({ id: 'cwd-old', transport: 'stdio', command: 'echo', cwd: '${TIERWYN_CWD}' });
    const r = resolveSessionMcp({
      ...base,
      db,
      conv: { mcpServers: ['cwd-new', 'cwd-old'] },
      template: undefined,
      agentCwd: '/work/proj',
    });
    expect(r.skipped).toEqual([]);
    expect(r.inject[0]!.args).toEqual(['--root', '/work/proj/src']);
    expect(r.inject[1]!.cwd).toBe('/work/proj');
  });

  it('local sessions keep stdio hub rows regardless of remoteStreaming', () => {
    addRow({ id: 'stdio-hub', transport: 'stdio', command: 'echo', placement: 'hub' });
    const r = resolveSessionMcp({
      ...base,
      db,
      conv: { mcpServers: ['stdio-hub'] },
      template: undefined,
    });
    expect(r.skipped).toEqual([]);
    expect(r.inject).toHaveLength(1);
    expect(r.inject[0]!.placement).toBeUndefined();
  });
});
