import { describe, expect, it } from 'vitest';
import { MCP_ENV_FALLBACK_RE, validateMcpServerInput } from './mcp.js';

describe('MCP_ENV_FALLBACK_RE (C11)', () => {
  it('accepts TIERWYN_MCP_*', () => {
    expect(MCP_ENV_FALLBACK_RE.test('TIERWYN_MCP_TOKEN')).toBe(true);
    expect(MCP_ENV_FALLBACK_RE.test('OTHER_MCP_TOKEN')).toBe(false);
    expect(MCP_ENV_FALLBACK_RE.test('TIERWYN_MCPV_0')).toBe(false);
    expect(MCP_ENV_FALLBACK_RE.test('NOPE')).toBe(false);
  });

  it('validateMcpServerInput checks the prefix', () => {
    expect(
      validateMcpServerInput({
        id: 'a',
        transport: 'stdio',
        command: 'x',
        env: [{ key: 'K', secret: true, envFallback: 'TIERWYN_MCP_K' }],
      }).ok,
    ).toBe(true);
    expect(
      validateMcpServerInput({
        id: 'a',
        transport: 'stdio',
        command: 'x',
        env: [{ key: 'K', secret: true, envFallback: 'OTHER_MCP_K' }],
      }).ok,
    ).toBe(false);
    expect(
      validateMcpServerInput({
        id: 'a',
        transport: 'stdio',
        command: 'x',
        env: [{ key: 'K', secret: true, envFallback: 'NOPE' }],
      }).ok,
    ).toBe(false);
  });
});
