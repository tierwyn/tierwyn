import { readFileSync } from 'fs';
import { join } from 'path';
import { gitSync } from '../git/gitExec.js';

export function readBuildIdentity(root: string): { id: string; source: 'git' | 'package' } {
  try {
    const raw = readFileSync(join(root, 'BUILD_ID'), 'utf8').trim();
    if (raw) return { id: raw, source: 'package' };
  } catch {
    // missing or unreadable BUILD_ID — fall through
  }
  try {
    const id = gitSync(root, ['rev-parse', 'HEAD'], { skipConfigScan: true }).trim();
    if (id) return { id, source: 'git' };
  } catch {
    // not a git checkout
  }
  return { id: 'unknown', source: 'git' };
}
