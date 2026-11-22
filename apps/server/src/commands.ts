import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { CommandSourceDetail } from '@tierwyn/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the file-driven built-in slash-verb source. */
export const COMMANDS_PATH = join(here, '..', 'agent-commands.json');

export interface SeedCommandEntry {
  agentType: string;
  name: string;
  label: string;
  description?: string;
  sourceDetail?: CommandSourceDetail;
}

interface CommandsConfig {
  commands: SeedCommandEntry[];
}

/**
 * Read and parse agent-commands.json. Throws on missing file, invalid JSON,
 * or missing/non-array `commands` field — callers (seedCommands at boot) must
 * NOT silently fall through to a prune step with an empty list.
 */
export function readCommands(): SeedCommandEntry[] {
  const raw = readFileSync(COMMANDS_PATH, 'utf-8');
  const config: CommandsConfig = JSON.parse(raw);
  if (!Array.isArray(config.commands)) {
    throw new Error('agent-commands.json: missing or non-array "commands" field');
  }
  return config.commands;
}
