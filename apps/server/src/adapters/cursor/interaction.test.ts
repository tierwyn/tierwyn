import { describe, it, expect } from 'vitest';
import { detectPermissionBlock, detectCursorFatalStderr } from './index.js';

describe('cursor permission-block detection', () => {
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
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'This change is awaiting approval by the operator' }] },
    });
    expect(detectPermissionBlock(jsonMessage)).toBeNull();

    const jsonToolResult = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      detail: { result: 'error: permission denied' },
    });
    expect(detectPermissionBlock(jsonToolResult)).toBeNull();
  });
});

describe('detectCursorFatalStderr', () => {
  it('flags an Error:-prefixed line', () => {
    expect(detectCursorFatalStderr('Error: invalid model "nope"')).toBe('Error: invalid model "nope"');
  });
  it('flags an auth-expiry line', () => {
    expect(detectCursorFatalStderr('  Your authentication has expired, please log in again  '))
      .toBe('Your authentication has expired, please log in again');
  });
  it('flags a rate-limit line', () => {
    expect(detectCursorFatalStderr('You have hit your rate limit for this model')).toContain('rate limit');
  });
  it('flags a session-limit line', () => {
    expect(detectCursorFatalStderr('You hit your session limit')).toContain('session limit');
  });
  it('returns null for chatty progress output', () => {
    expect(detectCursorFatalStderr('Loading workspace index...')).toBeNull();
    expect(detectCursorFatalStderr('   ')).toBeNull();
  });
  it('[S2-3] harmless "credit" chatter is not fatal — the real limit line still surfaces', () => {
    // A line merely mentioning "credit" must not classify (and thus must not
    // latch _fatalStderrEmitted in the stream/oneShot paths); the later real
    // fatal line has to be the one that surfaces.
    expect(detectCursorFatalStderr('Your credit balance is healthy — no action needed')).toBeNull();
    expect(detectCursorFatalStderr('Error: usage limit reached for this session')).toContain('usage limit');
  });
  it('[S2-3] genuine quota-limit stderr still classifies fatal', () => {
    expect(detectCursorFatalStderr('too many requests, slow down')).toContain('too many requests');
    expect(detectCursorFatalStderr('quota exceeded for model')).toContain('quota exceeded');
    expect(detectCursorFatalStderr('hit your session limit')).toContain('session limit');
  });
});
