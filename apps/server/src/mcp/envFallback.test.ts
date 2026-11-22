import { afterEach, describe, expect, it } from 'vitest';
import { _resetCapturedMcpEnv, captureMcpEnv, getCapturedMcpEnv } from './envFallback.js';

describe('captureMcpEnv (C11)', () => {
  afterEach(() => _resetCapturedMcpEnv());

  it('captures TIERWYN_MCP_* and deletes them from env', () => {
    const env: NodeJS.ProcessEnv = {
      TIERWYN_MCP_A: 'aaaaaaaa',
      TIERWYN_MCP_B: 'bbbbbbbb',
      TIERWYN_MCPV_0: 'placeholder',
      TIERWYN_MCPV_1: 'placeholder-new',
      OTHER: '1',
    };
    const keys = captureMcpEnv(env);
    expect(keys.sort()).toEqual(['TIERWYN_MCP_A', 'TIERWYN_MCP_B']);
    expect(getCapturedMcpEnv('TIERWYN_MCP_A')).toBe('aaaaaaaa');
    expect(getCapturedMcpEnv('TIERWYN_MCP_B')).toBe('bbbbbbbb');
    expect(env.TIERWYN_MCP_A).toBeUndefined();
    expect(env.TIERWYN_MCP_B).toBeUndefined();
    expect(env.TIERWYN_MCPV_0).toBe('placeholder');
    expect(env.TIERWYN_MCPV_1).toBe('placeholder-new');
    expect(env.OTHER).toBe('1');
  });
});
