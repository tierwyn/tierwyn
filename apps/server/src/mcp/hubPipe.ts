/**
 * Hub-side MCP pipes: one cached SDK transport pair per (bridge session, serverId).
 *
 * The bridge route hands raw MCP requests to `down` (a StreamableHTTPServerTransport);
 * `down`'s messages are forwarded to `up` — a real client transport spawned from the
 * registry row (stdio command on the hub, or sse/http-style event upstream). Nothing
 * here understands MCP: the hub is a byte pipe between the remote agent and the server
 * process, so secrets and tool traffic stay inside the upstream process.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpPublicVar } from '@tierwyn/shared';
import { buildChildEnv, isAlwaysScrubbed } from '../childEnv.js';
import type { McpServerRow } from './registry.js';

export interface HubPipe {
  /** Downstream half: mounted by the bridge route via handleRequest(req, res, body). */
  down: StreamableHTTPServerTransport;
  /** Upstream stdio child pid when there is one (tests, shutdown logs). */
  readonly upstreamPid: number | null;
  close(): Promise<void>;
}

/** Per bridge session: a runaway conversation must not farm hub processes unboundedly. */
export const MAX_PIPES_PER_SESSION = 8;

interface PipeRec extends HubPipe {
  upstream: Transport;
}

const keyOf = (k: { sessionId: string; serverId: string }): string => `${k.sessionId}\u0000${k.serverId}`;

const pipes = new Map<string, PipeRec>();
const inflight = new Map<string, Promise<HubPipe>>();
/** Bumped by closeHubPipesForSession so a create that started before revoke cannot land. */
const sessionEpoch = new Map<string, number>();

function epochOf(sessionId: string): number {
  return sessionEpoch.get(sessionId) ?? 0;
}

/** Test / state seam: the live pipe for a key, if any. */
export function peekHubPipe(key: { sessionId: string; serverId: string }): HubPipe | undefined {
  return pipes.get(keyOf(key));
}

/** Total live pipes (all sessions). */
export function hubPipeCount(): number {
  return pipes.size;
}

export async function getOrCreateHubPipe(
  key: { sessionId: string; serverId: string },
  spawn: () => Transport | Promise<Transport>,
): Promise<HubPipe> {
  const k = keyOf(key);
  const existing = pipes.get(k);
  if (existing) return existing;
  const pending = inflight.get(k);
  if (pending) return pending;
  const created = createPipe(key, spawn).finally(() => inflight.delete(k));
  inflight.set(k, created);
  return created;
}

async function createPipe(
  key: { sessionId: string; serverId: string },
  spawn: () => Transport | Promise<Transport>,
): Promise<HubPipe> {
  const k = keyOf(key);
  const epoch = epochOf(key.sessionId);
  let live = 0;
  for (const other of pipes.keys()) {
    if (other.split('\u0000')[0] === key.sessionId) live += 1;
  }
  if (live >= MAX_PIPES_PER_SESSION) throw new Error('too_many_pipes');

  const down = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: false,
  });
  const upstream = await spawn();

  let closed = false;
  const teardown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    pipes.delete(k);
    down.onmessage = undefined;
    down.onclose = undefined;
    upstream.onmessage = undefined;
    upstream.onclose = undefined;
    upstream.onerror = undefined;
    try { await down.close(); } catch { /* already dead */ }
    try { await upstream.close(); } catch { /* already dead */ }
  };
  const rec: PipeRec = {
    down,
    upstream,
    close: teardown,
    get upstreamPid(): number | null {
      return (upstream as { pid?: number | null }).pid ?? null;
    },
  };

  down.onmessage = (m) => { void upstream.send(m).catch(() => { void teardown(); }); };
  upstream.onmessage = (m) => { void down.send(m).catch(() => { void teardown(); }); };
  upstream.onerror = () => undefined;
  // Either half dying tears the whole pair down (upstream.close() kills the stdio child).
  down.onclose = () => { void teardown(); };
  upstream.onclose = () => { void teardown(); };

  await upstream.start();
  await down.start();
  if (epochOf(key.sessionId) !== epoch) {
    await teardown();
    throw new Error('session_revoked');
  }
  pipes.set(k, rec);
  if (epochOf(key.sessionId) !== epoch) {
    await teardown();
    throw new Error('session_revoked');
  }
  return rec;
}

/** Session teardown: revoke the bridge keys AND kill every pipe's upstream process. */
export async function closeHubPipesForSession(sessionId: string): Promise<void> {
  sessionEpoch.set(sessionId, epochOf(sessionId) + 1);
  for (const [k, rec] of [...pipes]) {
    if (k.split('\u0000')[0] === sessionId) await rec.close();
  }
}

export async function closeAllHubPipes(): Promise<void> {
  for (const rec of [...pipes.values()]) await rec.close();
}

/** Missing secret vars are skipped; the resolver gates them out before spawn. */
export function makeRowTransport(
  row: McpServerRow,
  readSecret?: (kind: 'env' | 'header', v: McpPublicVar) => string | undefined,
): Transport {
  if (row.transport === 'stdio') {
    const env: Record<string, string> = {};
    Object.assign(env, buildChildEnv());
    for (const v of row.env) {
      if (isAlwaysScrubbed(v.key)) {
        console.warn('[mcp] refusing to re-inject scrubbed env', v.key);
        continue;
      }
      const value = v.secret ? (readSecret?.('env', v) ?? '') : (v.value ?? '');
      if (value !== '') env[v.key] = value;
    }
    return new StdioClientTransport({
      command: row.command ?? '',
      args: row.args,
      cwd: row.cwd ?? homedir(),
      env,
      stderr: 'ignore',
    });
  }
  const headers: Record<string, string> = {};
  for (const v of row.headers) {
    const value = v.secret ? (readSecret?.('header', v) ?? '') : (v.value ?? '');
    if (value !== '') headers[v.key] = value;
  }
  const withHeaders = (init?: RequestInit): RequestInit => ({
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  return new SSEClientTransport(new URL(row.url ?? ''), {
    requestInit: withHeaders(),
    eventSourceInit: { fetch: (url, init) => fetch(url, withHeaders(init)) },
  });
}
