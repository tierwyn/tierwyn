import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import {
  GrokRpc,
  formatGrokRpcError,
  humanizeGrokError,
  GROK_CREDITS_EXHAUSTED_MESSAGE,
} from './protocol.js';

/** Drive a GrokRpc with in-memory streams; helper to write inbound lines. */
function harness() {
  const childIn = new PassThrough(); // adapter writes here (GrokRpc's stdin)
  const childOut = new PassThrough(); // we write here (GrokRpc's stdout = child's)
  const rpc = new GrokRpc(childIn, childOut);
  return { rpc, childIn, childOut };
}

describe('formatGrokRpcError', () => {
  it('keeps string data appended (legacy shape)', () => {
    expect(formatGrokRpcError({ code: -32602, message: 'Invalid params', data: 'unknown model id' }))
      .toBe('Invalid params: unknown model id');
  });

  it('JSON-stringifies object data instead of [object Object]', () => {
    expect(formatGrokRpcError({
      code: -32000,
      message: 'Internal error',
      data: { foo: 1, bar: 'x' },
    })).toBe('Internal error: {"foo":1,"bar":"x"}');
  });

  it('rewrites 402 usage-balance exhaustion to a clear notice', () => {
    // Live capture 2026-09-21/22: grok logs
    // "API error (status 402 Payment Required): Grok Build usage balance exhausted"
    // and ACP surfaces message "Internal error" with structured data.
    expect(formatGrokRpcError({
      code: -32000,
      message: 'Internal error',
      data: {
        status_code: 402,
        message: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
      },
    })).toBe(GROK_CREDITS_EXHAUSTED_MESSAGE);
  });

  it('humanizeGrokError catches already-flattened 402 strings', () => {
    expect(humanizeGrokError('API error (status 402 Payment Required): Grok Build usage balance exhausted'))
      .toBe(GROK_CREDITS_EXHAUSTED_MESSAGE);
    expect(humanizeGrokError('something else')).toBe('something else');
  });
});

describe('GrokRpc', () => {
  it('resolves send() with the matching result', async () => {
    const { rpc, childOut } = harness();
    const p = rpc.send('initialize', { protocolVersion: 1 });
    childOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + '\n');
    await expect(p).resolves.toEqual({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  });

  it('rejects send() on an error result', async () => {
    const { rpc, childOut } = harness();
    const p = rpc.send('session/new', {});
    childOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope', data: 'detail' } }) + '\n');
    await expect(p).rejects.toThrow('nope: detail');
  });

  it('rejects object error.data without [object Object] and rewrites credit exhaustion', async () => {
    const { rpc, childOut } = harness();
    const p = rpc.send('session/prompt', {});
    childOut.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32000,
        message: 'Internal error',
        data: {
          status_code: 402,
          message: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
        },
      },
    }) + '\n');
    await expect(p).rejects.toThrow(GROK_CREDITS_EXHAUSTED_MESSAGE);
  });

  it('routes notifications to on() handlers', () => {
    const { rpc, childOut } = harness();
    const handler = vi.fn();
    rpc.on('session/update', handler);
    childOut.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } }) + '\n');
    expect(handler).toHaveBeenCalledWith({ update: { sessionUpdate: 'agent_message_chunk' } });
  });

  it('routes server→client requests to onServerRequest', () => {
    const { rpc, childIn, childOut } = harness();
    const handler = vi.fn();
    rpc.onServerRequest(handler);
    childOut.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { options: [] } }) + '\n');
    expect(handler).toHaveBeenCalledWith('session/request_permission', 99, { options: [] });
    rpc.respond(99, { outcome: { outcome: 'cancelled' } });
    // Verify the response was written to the child's stdin
    expect(childIn.read()?.toString()).toContain('"id":99');
  });

  it('initialize() sends the no-fs/no-terminal clientCapabilities', async () => {
    const { rpc, childIn, childOut } = harness();
    const p = rpc.initialize();
    const written = childIn.read()?.toString();
    expect(written).toContain('"method":"initialize"');
    expect(written).toContain('"readTextFile":false');
    expect(written).toContain('"writeTextFile":false');
    expect(written).toContain('"terminal":false');
    childOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + '\n');
    await expect(p).resolves.toBeTruthy();
  });

  it('drainPending rejects all in-flight sends', async () => {
    const { rpc } = harness();
    const p1 = rpc.send('session/prompt', {});
    const p2 = rpc.send('session/prompt', {});
    rpc.drainPending('closed');
    await expect(p1).rejects.toThrow('closed');
    await expect(p2).rejects.toThrow('closed');
  });

  it('ignores non-JSON lines without throwing', () => {
    const { rpc, childOut } = harness();
    const handler = vi.fn();
    rpc.on('session/update', handler);
    expect(() => childOut.write('not json\n')).not.toThrow();
    childOut.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }) + '\n');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
