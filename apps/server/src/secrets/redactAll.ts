import { redactSpawnTokens } from '../spawn/tokens.js';
import { redactRunTokens } from '../schedules/runTokens.js';
import { redactMcpSecrets } from './mcpRedact.js';

let extra: ((t: string) => string) | undefined;

/** Boot seam for vault-value redaction (plugin vault / agent env vault) without DB imports here. */
export function setExtraRedactor(fn: ((t: string) => string) | undefined): void {
  extra = fn;
}

export function redactAll(text: string): string {
  const out = redactMcpSecrets(redactRunTokens(redactSpawnTokens(text)));
  return extra ? extra(out) : out;
}
