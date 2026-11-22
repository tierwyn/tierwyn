import { describe, expect, it } from 'vitest';
import {
  assembleAgentPromptText,
  bareChildResultPath,
  buildBareChildProtocolNote,
  buildBarePrimingHostNote,
} from './promptText.js';

describe('assembleAgentPromptText', () => {
  it('non-bare joins preamble, priming, and user text', () => {
    expect(assembleAgentPromptText({
      barePrompt: false,
      delegationPreamble: 'PREAMBLE',
      primingPrompt: 'PRIMING',
      userText: 'hello',
    })).toBe('PREAMBLE\n\nPRIMING\n\nhello');
  });

  it('bare without priming sends only user text (no preamble)', () => {
    expect(assembleAgentPromptText({
      barePrompt: true,
      delegationPreamble: 'PREAMBLE',
      userText: 'hello',
    })).toBe('hello');
  });

  it('bare with priming prepends priming but never the preamble', () => {
    expect(assembleAgentPromptText({
      barePrompt: true,
      delegationPreamble: 'PREAMBLE',
      primingPrompt: 'PRIMING',
      userText: 'hello',
    })).toBe('PRIMING\n\nhello');
  });

  it('bare with priming includes host note before priming', () => {
    expect(assembleAgentPromptText({
      barePrompt: true,
      primingPrompt: 'PRIMING',
      barePrimingNote: 'HOST NOTE',
      userText: 'hello',
    })).toBe('HOST NOTE\n\nPRIMING\n\nhello');
  });

  it('barePrimingNote is ignored when there is no priming', () => {
    expect(assembleAgentPromptText({
      barePrompt: true,
      barePrimingNote: 'HOST NOTE',
      userText: 'hello',
    })).toBe('hello');
  });

  it('bare prepends child note, then host note, priming, user; never the preamble', () => {
    expect(assembleAgentPromptText({
      barePrompt: true,
      bareChildNote: 'CHILD NOTE',
      barePrimingNote: 'HOST NOTE',
      primingPrompt: 'PRIMING',
      userText: 'hello',
      delegationPreamble: 'X',
    })).toBe('CHILD NOTE\n\nHOST NOTE\n\nPRIMING\n\nhello');
  });

  it('non-bare ignores bareChildNote', () => {
    expect(assembleAgentPromptText({
      barePrompt: false,
      bareChildNote: 'CHILD NOTE',
      userText: 'hello',
    })).toBe('hello');
  });

  it('prepends hostNote for non-bare, ignores it for bare', () => {
    expect(assembleAgentPromptText({
      barePrompt: false,
      hostNote: 'HOST',
      delegationPreamble: 'PREAMBLE',
      primingPrompt: 'PRIMING',
      recalledMemories: 'RECALL',
      userText: 'hello',
    })).toBe('HOST\n\nPREAMBLE\n\nPRIMING\n\nRECALL\n\nhello');
    expect(assembleAgentPromptText({
      barePrompt: true,
      recalledMemories: 'RECALL',
      userText: 'hello',
    })).toBe('hello');
    expect(assembleAgentPromptText({
      barePrompt: true,
      hostNote: 'HOST',
      primingPrompt: 'PRIMING',
      userText: 'hello',
    })).toBe('PRIMING\n\nhello');
  });
});

describe('bareChildResultPath', () => {
  it('slugs the role and takes the first 8 chars of the child id', () => {
    expect(bareChildResultPath('/p', 'Grok Bot Default', 'abcdef12-3456-7890-abcd-ef1234567890'))
      .toBe('/p/.tierwyn/delegates/grok-bot-default-abcdef12-RESULT.md');
  });

  it('falls back to grok-bot when role is undefined', () => {
    expect(bareChildResultPath('/p', undefined, 'abcdef12-3456-7890-abcd-ef1234567890'))
      .toBe('/p/.tierwyn/delegates/grok-bot-abcdef12-RESULT.md');
  });
});

describe('buildBareChildProtocolNote', () => {
  it('names hostname, cwd, resultPath, ## Result, and Host writes without spawn/HTTP/Tierwyn teaching', () => {
    const hostname = 'box-1';
    const cwd = '/tmp/proj';
    const resultPath = '/tmp/proj/.tierwyn/delegates/grok-bot-abcdef12-RESULT.md';
    const note = buildBareChildProtocolNote({ hostname, cwd, resultPath });
    expect(note).toContain(hostname);
    expect(note).toContain(cwd);
    expect(note).toContain(resultPath);
    expect(note).toContain('## Result');
    expect(note).toMatch(/Host writes:/);
    const scanned = note.replaceAll(resultPath, '').replaceAll(cwd, '');
    expect(scanned).not.toMatch(/spawn|bearer|token|curl|http|tierwyn|127\.0\.0\.1/i);
  });
});

describe('buildBarePrimingHostNote', () => {
  it('names hostname and conversation cwd', () => {
    const note = buildBarePrimingHostNote({
      hostname: 'tierwyn-box',
      cwd: '/home/user/Projects/Tierwyn',
    });
    expect(note).toContain('tierwyn-box');
    expect(note).toContain('/home/user/Projects/Tierwyn');
    expect(note).toMatch(/Host System/i);
    expect(note).toMatch(/CWD|working directory/i);
  });

  it('still names hostname when cwd is missing', () => {
    const note = buildBarePrimingHostNote({ hostname: 'tierwyn-box' });
    expect(note).toContain('tierwyn-box');
    expect(note).toMatch(/working directory/i);
  });
});
