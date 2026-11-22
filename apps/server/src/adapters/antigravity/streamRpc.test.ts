import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  attachStdinGuard,
  buildUserEnvelope,
  closeStdin,
  contentWithPathRefs,
  createStreamPipe,
  writeUserTurn,
} from './streamRpc.js';

describe('streamRpc', () => {
  it('builds the agy {event:user} envelope, not Claude Code type:user', () => {
    const line = buildUserEnvelope('hello');
    expect(JSON.parse(line)).toEqual({
      event: 'user',
      message: { content: 'hello' },
    });
    expect(line).not.toContain('"type":"user"');
  });

  it('appends @<tempPath> refs inside content', () => {
    const content = contentWithPathRefs('see these', [
      { mediaType: 'image/png', tempPath: '/tmp/a.png' },
      { mediaType: 'application/pdf', tempPath: '/tmp/b.pdf' },
      { mediaType: 'audio/mpeg' },
    ]);
    expect(content).toContain('see these');
    expect(content).toContain('@/tmp/a.png');
    expect(content).toContain('@/tmp/b.pdf');
    expect(content).not.toContain('@undefined');
  });

  it('writeUserTurn writes envelope + newline and does not end stdin', () => {
    const stdin = new PassThrough();
    const pipe = createStreamPipe();
    expect(writeUserTurn(stdin, pipe, 'PING')).toBe(true);
    expect(stdin.read()?.toString()).toBe(
      '{"event":"user","message":{"content":"PING"}}\n',
    );
    expect(stdin.writableEnded).toBe(false);
    expect(pipe.stdinClosed).toBe(false);
  });

  it('closeStdin is idempotent and writeUserTurn then returns false', () => {
    const stdin = new PassThrough();
    const pipe = createStreamPipe();
    closeStdin(stdin, pipe);
    closeStdin(stdin, pipe);
    expect(pipe.stdinClosed).toBe(true);
    expect(stdin.writableEnded).toBe(true);
    expect(writeUserTurn(stdin, pipe, 'nope')).toBe(false);
  });

  it('stdin error sets the closed flag without throwing', () => {
    const stdin = new PassThrough();
    const pipe = createStreamPipe();
    attachStdinGuard(stdin, pipe);
    stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    expect(pipe.stdinClosed).toBe(true);
  });

  it('attachStdinGuard no-ops on missing stdin', () => {
    const pipe = createStreamPipe();
    attachStdinGuard(undefined, pipe);
    attachStdinGuard(null, pipe);
    expect(pipe.stdinClosed).toBe(false);
  });
});

describe('streamRpc EventEmitter stdin stand-in', () => {
  it('does not crash the process on an unhandled stdin error after guard', () => {
    const stdin = new EventEmitter() as EventEmitter & PassThrough;
    const pipe = createStreamPipe();
    attachStdinGuard(stdin as unknown as PassThrough, pipe);
    expect(() => stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(pipe.stdinClosed).toBe(true);
  });
});
