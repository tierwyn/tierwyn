import { describe, it, expect } from 'vitest';
import { mapPiEvent } from './mapping.js';

describe('mapPiEvent permission frame', () => {
  it('maps a Pi permission_request to interaction_request', () => {
    const out = mapPiEvent({
      type: 'permission_request',
      id: 'pi-perm-1',
      toolName: 'shell',
      args: { command: 'rm test.txt' },
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('interaction_request');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (out[0] as any).payload;
    expect(p.kind).toBe('permission');
    expect(p.toolName).toBe('shell');
    expect(p.requestId).toBe('pi-perm-1');
  });
});
