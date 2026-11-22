/**
 * Pure per-adapter builders. Core rule: secret values never land on argv.
 * claude-code: `${TIERWYN_MCPV_n}` placeholders expanded by the CLI from
 * its own child env (V1/V2 verified). codex: env-name indirection (`env_vars`,
 * `env_http_headers`). ACP: literal values over stdin JSON-RPC.
 */
import type { ResolvedMcpServer } from '@tierwyn/shared';

type Placeholders = { env: Record<string, string>; next: (value: string) => string };

function placeholders(): Placeholders {
  const env: Record<string, string> = {};
  let n = 0;
  return {
    env,
    next(value) {
      const name = `TIERWYN_MCPV_${n++}`;
      env[name] = value;
      return name;
    },
  };
}

function mapVars(vars: Record<string, string>, secretKeys: string[], ph: Placeholders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = secretKeys.includes(k) ? `\${${ph.next(v)}}` : v;
  return out;
}

export type ClaudeMcpConfig =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string> };

/** claude-code SDK `options.mcpServers` + the env to merge into buildChildEnv. */
export function toClaudeSdkMcp(servers: ResolvedMcpServer[]): {
  mcpServers: Record<string, ClaudeMcpConfig>;
  env: Record<string, string>;
} {
  const ph = placeholders();
  const mcpServers: Record<string, ClaudeMcpConfig> = {};
  for (const s of servers) {
    // ponytail: claude's MCP config has no cwd; registry cwd is honoured by codex only.
    mcpServers[s.id] = s.transport === 'stdio'
      ? { type: 'stdio', command: s.command ?? '', args: s.args, env: mapVars(s.env, s.secretEnvKeys, ph) }
      : { type: s.transport, url: s.url ?? '', headers: mapVars(s.headers, s.secretHeaderKeys, ph) };
  }
  return { mcpServers, env: ph.env };
}

const tomlStr = (s: string) => JSON.stringify(s);
const tomlTable = (o: Record<string, string>) =>
  `{${Object.entries(o).map(([k, v]) => `${tomlStr(k)}=${tomlStr(v)}`).join(',')}}`;

/** codex `app-server` `-c mcp_servers.<id>.*` overrides + env. sse is filtered by the resolver. */
export function toCodexArgs(servers: ResolvedMcpServer[]): { args: string[]; env: Record<string, string> } {
  const ph = placeholders();
  const args: string[] = [];
  const env: Record<string, string> = {};
  const c = (id: string, key: string, value: string) => args.push('-c', `mcp_servers.${id}.${key}=${value}`);
  for (const s of servers) {
    if (s.transport === 'stdio') {
      c(s.id, 'command', tomlStr(s.command ?? ''));
      c(s.id, 'args', JSON.stringify(s.args));
      if (s.cwd) c(s.id, 'cwd', tomlStr(s.cwd));
      const plain = Object.fromEntries(Object.entries(s.env).filter(([k]) => !s.secretEnvKeys.includes(k)));
      if (Object.keys(plain).length) c(s.id, 'env', tomlTable(plain));
      if (s.secretEnvKeys.length) {
        // codex forwards these by name from its own env (V4: env_vars). The resolver
        // rejects cross-server collisions (secret_env_unsupported).
        c(s.id, 'env_vars', JSON.stringify(s.secretEnvKeys));
        for (const k of s.secretEnvKeys) env[k] = s.env[k];
      }
    } else if (s.transport === 'http') {
      c(s.id, 'url', tomlStr(s.url ?? ''));
      const plain = Object.fromEntries(Object.entries(s.headers).filter(([k]) => !s.secretHeaderKeys.includes(k)));
      if (Object.keys(plain).length) c(s.id, 'http_headers', tomlTable(plain));
      if (s.secretHeaderKeys.length) {
        c(s.id, 'env_http_headers', tomlTable(Object.fromEntries(
          s.secretHeaderKeys.map((k) => [k, ph.next(s.headers[k])]),
        )));
      }
    }
  }
  return { args, env: { ...env, ...ph.env } };
}

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: 'http' | 'sse'; name: string; url: string; headers: { name: string; value: string }[] };

/**
 * Build a `dsh --profile sdk --patch` YAML overlay mounting one
 * `@deepseek-ai/dsh-mcp-client` entry per selected registry server (stdio +
 * streamable-http; sse is skipped by the resolver). Secret env/header values
 * never land in the YAML file — they are referenced via `!!js process.env.TIERWYN_MCPV_n`
 * and passed only in the child process environment.
 */
export function toDeepSeekMcpPatch(servers: ResolvedMcpServer[]): { yaml: string; env: Record<string, string> } {
  const ph = placeholders();
  const entries: string[] = [];
  for (const s of servers) {
    if (s.transport !== 'stdio' && s.transport !== 'http') continue;
    const lines: string[] = [
      `    - id: ${JSON.stringify(`tierwyn-mcp-${s.id}`)}`,
      `      name: '@deepseek-ai/dsh-mcp-client'`,
      `      config:`,
      `        serverName: ${JSON.stringify(s.id)}`,
    ];
    if (s.transport === 'stdio') {
      lines.push(`        transport: stdio`);
      lines.push(`        command: ${JSON.stringify(s.command ?? '')}`);
      if (s.args.length) lines.push(`        args: ${JSON.stringify(s.args)}`);
      if (s.cwd) lines.push(`        cwd: ${JSON.stringify(s.cwd)}`);
      const envEntries = Object.entries(s.env);
      if (envEntries.length) {
        lines.push(`        env:`);
        for (const [k, v] of envEntries) {
          const val = s.secretEnvKeys.includes(k)
            ? `!!js process.env.${ph.next(v)}`
            : JSON.stringify(v);
          lines.push(`          ${JSON.stringify(k)}: ${val}`);
        }
      }
    } else {
      lines.push(`        transport: streamable-http`);
      lines.push(`        url: ${JSON.stringify(s.url ?? '')}`);
      const headerEntries = Object.entries(s.headers);
      if (headerEntries.length) {
        lines.push(`        headers:`);
        for (const [k, v] of headerEntries) {
          const val = s.secretHeaderKeys.includes(k)
            ? `!!js process.env.${ph.next(v)}`
            : JSON.stringify(v);
          lines.push(`          ${JSON.stringify(k)}: ${val}`);
        }
      }
    }
    entries.push(lines.join('\n'));
  }
  if (!entries.length) return { yaml: '', env: {} };
  const yaml = [
    '# Auto-generated by Tierwyn — registry MCP servers for dsh-mcp-client.',
    '- insert:',
    ...entries,
    '',
  ].join('\n');
  return { yaml, env: ph.env };
}

/** ACP `session/new` / `session/load` mcpServers. Values literal (stdin, not argv). */
export function toAcpMcpServers(
  servers: ResolvedMcpServer[] | undefined,
  caps: { http?: boolean; sse?: boolean } | undefined,
): AcpMcpServer[] {
  const pairs = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
  return (servers ?? []).flatMap((s): AcpMcpServer[] => {
    if (s.transport === 'stdio') return [{ name: s.id, command: s.command ?? '', args: s.args, env: pairs(s.env) }];
    return caps?.[s.transport] ? [{ type: s.transport, name: s.id, url: s.url ?? '', headers: pairs(s.headers) }] : [];
  });
}

/** `initialize` result → agentCapabilities.mcpCapabilities (untyped across ACP clients). */
export function acpMcpCaps(init: unknown): { http?: boolean; sse?: boolean } | undefined {
  const c = (init as { agentCapabilities?: { mcpCapabilities?: unknown } } | undefined)?.agentCapabilities?.mcpCapabilities;
  if (!c || typeof c !== 'object') return undefined;
  const o = c as Record<string, unknown>;
  return { http: o.http === true, sse: o.sse === true };
}
