import { describe, expect, it } from 'vitest';
import { CREDENTIAL_KEY_PREFIX_BLOCKLIST, isCredentialKeyAllowed } from './plugins.js';

describe('CREDENTIAL_KEY_PREFIX_BLOCKLIST (C6)', () => {
  it('blocks the TIERWYN_ prefix', () => {
    expect(CREDENTIAL_KEY_PREFIX_BLOCKLIST).toEqual(expect.arrayContaining(['TIERWYN_']));
    expect(isCredentialKeyAllowed('TIERWYN_PLUGIN_VAULT_KEY')).toBe(false);
    expect(isCredentialKeyAllowed('ZAI_API_KEY')).toBe(true);
  });
});
