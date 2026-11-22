import { describe, it, expect } from 'vitest';
import { detectPermissionBlock } from './index.js';

describe('antigravity permission-block detection', () => {
  it('flags a permission-denied result line', () => {
    const msg = detectPermissionBlock('Error: tool "bash" requires approval (permission denied)');
    expect(msg).toContain('needed approval');
  });
  it('returns null for normal output', () => {
    expect(detectPermissionBlock('Creating file index.ts')).toBeNull();
  });
  it('flags needs your approval', () => {
    expect(detectPermissionBlock('This action needs your approval')).toContain('needed approval');
  });
  it('does not flag structured JSON frames containing approval or permission phrases', () => {
    const jsonMessage = JSON.stringify({
      event: 'step_update',
      step: { content: 'There is 1 proposed feature awaiting approval' },
    });
    expect(detectPermissionBlock(jsonMessage)).toBeNull();

    const jsonToolResult = JSON.stringify({
      event: 'tool_result',
      content: 'tcpdump / nmap: permission denied (NET_RAW)',
    });
    expect(detectPermissionBlock(jsonToolResult)).toBeNull();
  });
});
