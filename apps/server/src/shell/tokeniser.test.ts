import { describe, it, expect } from 'vitest';
import { tokenise } from './tokeniser.js';

describe('tokenise', () => {
  it('splits on whitespace', () => {
    expect(tokenise('ls -la')).toEqual({ ok: true, argv: ['ls', '-la'] });
  });

  it('honours double quotes for args-with-spaces', () => {
    expect(tokenise('echo "hello world"')).toEqual({ ok: true, argv: ['echo', 'hello world'] });
  });

  it('refuses semicolon (shell metachar)', () => {
    expect(tokenise('echo a ; rm b').ok).toBe(false);
    expect(tokenise('echo a ; rm b')).toEqual({ ok: false, reason: 'shell_metachar' });
  });

  it('refuses $ even inside quotes', () => {
    expect(tokenise('cat "$(id)"').ok).toBe(false);
    expect(tokenise('cat "$(id)"')).toEqual({ ok: false, reason: 'shell_metachar' });
  });

  it('refuses pipe', () => {
    expect(tokenise('ls | grep x').ok).toBe(false);
  });

  it('refuses backtick', () => {
    expect(tokenise('echo `id`').ok).toBe(false);
  });

  it('refuses empty / whitespace-only', () => {
    expect(tokenise('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses unbalanced quotes', () => {
    expect(tokenise('grep "unterminated').ok).toBe(false);
  });

  it('passes globs literally (no expansion)', () => {
    expect(tokenise('ls *.ts')).toEqual({ ok: true, argv: ['ls', '*.ts'] });
  });

  it('honours single quotes', () => {
    expect(tokenise("echo 'a b'")).toEqual({ ok: true, argv: ['echo', 'a b'] });
  });

  it('refuses redirect and ampersand', () => {
    expect(tokenise('ls > out').ok).toBe(false);
    expect(tokenise('ls &').ok).toBe(false);
  });

  it('refuses braces, backslash, and null byte', () => {
    expect(tokenise('echo {a,b}').ok).toBe(false);
    expect(tokenise('echo a\\b').ok).toBe(false);
    expect(tokenise('ls\0rm').ok).toBe(false);
  });

  it('refuses empty-quoted argv[0]', () => {
    // `""` collapses to an empty token; argv[0]='' would ENOENT harmlessly,
    // but an empty leading token is malformed — fail closed.
    expect(tokenise('""').ok).toBe(false);
  });
});
