/**
 * Boot capture of `TIERWYN_MCP_*` env vars (MCP secret fallback).
 * Values are moved into a module map and deleted from process.env so no agent
 * child inherits them (childEnv.ts also prefix-scrubs). Injection placeholders
 * use `TIERWYN_MCPV_` so this prefix scan never matches them.
 */
const captured = new Map<string, string>();

function isMcpSecretKey(k: string): boolean {
  return k.startsWith('TIERWYN_MCP_');
}

export function captureMcpEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = Object.keys(env).filter(isMcpSecretKey);
  for (const k of keys) {
    const v = env[k];
    if (typeof v === 'string' && v.length > 0) captured.set(k, v);
    delete env[k];
  }
  return keys;
}

export function getCapturedMcpEnv(name: string): string | undefined {
  return captured.get(name);
}

export function capturedMcpEnvValues(): string[] {
  return [...captured.values()];
}

/** Test seam. */
export function _resetCapturedMcpEnv(): void {
  captured.clear();
}
