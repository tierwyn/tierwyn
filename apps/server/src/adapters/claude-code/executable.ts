import { PACKAGED } from '../../installSource.js';
import { resolveOnPath } from '../../discovery.js';

export function claudeExecutableOpt(
  packaged = PACKAGED,
  resolve = resolveOnPath,
): { pathToClaudeCodeExecutable?: string } {
  if (!packaged) return {};
  const path = resolve('claude');
  return path ? { pathToClaudeCodeExecutable: path } : {};
}
