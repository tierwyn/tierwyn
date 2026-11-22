import { describe, it, expect, afterEach } from 'vitest';
import { issueSpawnToken, revokeSpawnTokensForConversation } from '../spawn/tokens.js';
import { issueRunToken, revokeRunToken } from '../schedules/runTokens.js';
import { _setMcpRedactNeedles } from './mcpRedact.js';
import { redactAll, setExtraRedactor } from './redactAll.js';

describe('redactAll', () => {
  afterEach(() => {
    setExtraRedactor(undefined);
    _setMcpRedactNeedles([]);
    revokeSpawnTokensForConversation('redact-all-conv');
  });

  it('redacts a live spawn token, a run token, and an MCP secret in one pass', () => {
    const spawn = issueSpawnToken('redact-all-conv', 'sess-redact');
    const run = issueRunToken({ jobId: 'j1', runId: 'r1', conversationId: 'c1' });
    _setMcpRedactNeedles(['mcp-secret-value-xx']);
    const text = `Bearer ${spawn} and ${run} and mcp-secret-value-xx leftover`;
    expect(redactAll(text)).toBe('Bearer [REDACTED] and [REDACTED] and [REDACTED] leftover');
    revokeRunToken(run);
  });

  it('applies setExtraRedactor after the built-in chain', () => {
    setExtraRedactor((t) => t.replaceAll('vault-secret-abcdefgh', '[REDACTED]'));
    expect(redactAll('keep vault-secret-abcdefgh gone')).toBe('keep [REDACTED] gone');
  });
});
