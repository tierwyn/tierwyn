import { homedir } from 'os';
import { join } from 'path';

export const BRAND = 'tierwyn';

/** `$XDG_CONFIG_HOME/tierwyn` (default `~/.config/tierwyn`). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), BRAND);
}

export function runDir(): string {
  return join(homedir(), `.${BRAND}`, 'run');
}

/** Per-project state dir (`.tierwyn/`). */
export const PROJECT_STATE_DIR = `.${BRAND}`;
