import { describe, expect, it } from 'vitest';
import { silentSuccessAckFor } from './silentSuccessCommands.js';

describe('silentSuccessAckFor', () => {
  it('returns ack for /compact', () => {
    expect(silentSuccessAckFor('/compact')).toBe('Context compacted successfully.');
    expect(silentSuccessAckFor('/compact ')).toBe('Context compacted successfully.');
    expect(silentSuccessAckFor('  /compact extra')).toBe('Context compacted successfully.');
  });

  it('returns ack for /always-approve', () => {
    expect(silentSuccessAckFor('/always-approve')).toBe('Always-approve mode updated.');
    expect(silentSuccessAckFor('/always-approve on')).toBe('Always-approve mode updated.');
  });

  it('returns null for unknown slash commands', () => {
    expect(silentSuccessAckFor('/grill-me')).toBeNull();
    expect(silentSuccessAckFor('/unknown')).toBeNull();
  });

  it('returns null for non-slash text', () => {
    expect(silentSuccessAckFor('hello')).toBeNull();
    expect(silentSuccessAckFor('')).toBeNull();
  });
});
