import { describe, expect, it } from 'vitest';
import { isValidEnvName } from './agentEnvName.js';

describe('isValidEnvName', () => {
  it('accepts typical secret names and rejects lowercase, hyphens, and empty', () => {
    expect(isValidEnvName('OPENAI_API_KEY')).toBe(true);
    expect(isValidEnvName('COPILOT_GITHUB_TOKEN')).toBe(true);
    expect(isValidEnvName('_PRIVATE')).toBe(true);
    expect(isValidEnvName('A')).toBe(true);
    expect(isValidEnvName('openai_api_key')).toBe(false);
    expect(isValidEnvName('OPENAI-API-KEY')).toBe(false);
    expect(isValidEnvName('1ABC')).toBe(false);
    expect(isValidEnvName('')).toBe(false);
  });
});
