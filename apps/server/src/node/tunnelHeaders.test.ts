import { describe, expect, it } from 'vitest';
import {
  BRIDGE_HEADER,
  MCP_KEY_HEADER,
  NODE_HEADER,
  NODE_SECRET_HEADER,
  TUNNEL_STREAM_HEADER,
  isSpoofableBrandHeader,
} from './brandHeaders.js';
import { buildReplayHeaders, dropRequestHeader } from './tunnelHeaders.js';

describe('dropRequestHeader brand strip', () => {
  it('strips x-tierwyn-* headers (node identity, stream, other)', () => {
    for (const key of [
      'x-tierwyn-node',
      'X-Tierwyn-Node',
      'x-tierwyn-node-auth',
      'x-tierwyn-node-id',
      'x-tierwyn-tunnel-stream',
      'x-tierwyn-build-id',
      'x-tierwyn-package-sha256',
    ]) {
      expect(dropRequestHeader(key), key).toBe(true);
      expect(isSpoofableBrandHeader(key), key).toBe(true);
    }
  });

  it('does not strip MCP bridge keys (agent-carried proof)', () => {
    expect(dropRequestHeader(MCP_KEY_HEADER)).toBe(false);
    expect(dropRequestHeader(BRIDGE_HEADER)).toBe(false);
    expect(isSpoofableBrandHeader(MCP_KEY_HEADER)).toBe(false);
  });

  it('still drops hop-by-hop and x-forwarded-*', () => {
    expect(dropRequestHeader('cookie')).toBe(true);
    expect(dropRequestHeader('x-forwarded-for')).toBe(true);
    expect(dropRequestHeader('content-type')).toBe(false);
  });
});

describe('buildReplayHeaders', () => {
  it('replaces forged identity', () => {
    const out = buildReplayHeaders('host-abc', {
      'x-tierwyn-node': 'forged',
      'x-tierwyn-node-auth': 'forged-secret',
      'x-tierwyn-tunnel-stream': '1',
      'content-type': 'text/plain',
      [MCP_KEY_HEADER]: 'keep-me',
    }, 'real-secret');
    expect(out[NODE_HEADER]).toBe('host-abc');
    expect(out[NODE_SECRET_HEADER]).toBe('real-secret');
    expect(out[TUNNEL_STREAM_HEADER]).toBeUndefined();
    expect(out['content-type']).toBe('text/plain');
    expect(out[MCP_KEY_HEADER]).toBe('keep-me');
  });

  it('emits the stream marker when streaming', () => {
    const out = buildReplayHeaders('h', {}, 's', { stream: true });
    expect(out[TUNNEL_STREAM_HEADER]).toBe('1');
  });
});
