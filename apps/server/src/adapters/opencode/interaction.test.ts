import { describe, it, expect } from 'vitest';
import { detectPermissionBlock } from './index.js';

describe('opencode permission-block detection', () => {
  it('flags a permission-denied result line', () => {
    const msg = detectPermissionBlock('Error: tool "bash" requires approval (permission denied)');
    expect(msg).toContain('needed approval');
  });
  it('returns null for normal output', () => {
    expect(detectPermissionBlock('Done. Edited 2 files.')).toBeNull();
  });
  it('flags awaiting approval', () => {
    expect(detectPermissionBlock('tool awaiting approval from user')).toContain('needed approval');
  });
  it('does not flag structured JSON frames containing approval or permission phrases', () => {
    const jsonMessage = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: 'There is 1 proposed feature awaiting approval' },
    });
    expect(detectPermissionBlock(jsonMessage)).toBeNull();

    const jsonToolResult = JSON.stringify({
      type: 'tool_result',
      part: { type: 'tool', output: 'permission denied' },
    });
    expect(detectPermissionBlock(jsonToolResult)).toBeNull();
  });
});
