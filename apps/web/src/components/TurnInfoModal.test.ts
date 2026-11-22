import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TurnInfoModal,
  extractFileInfo,
  extractCommand,
  extractQuery,
  extractUrl,
  summarizeToolInput,
  getToolCategory,
  extractDiffPairFromToolInput,
  resolveFileChangeToolInput,
} from './TurnInfoModal.js';
import type { PromptTurn } from '../groupTurns.js';

if (typeof globalThis.document === 'undefined') {
  (globalThis as any).document = {
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

describe('TurnInfoModal helpers', () => {
  describe('extractDiffPairFromToolInput', () => {
    it('returns before/after from old_string + new_string (StrReplace shape)', () => {
      expect(
        extractDiffPairFromToolInput({
          path: 'a.ts',
          old_string: 'foo',
          new_string: 'bar',
        }),
      ).toEqual({ before: 'foo', after: 'bar' });
    });

    it('returns before/after from TargetContent + ReplacementContent', () => {
      expect(
        extractDiffPairFromToolInput({
          TargetFile: '/x.ts',
          TargetContent: 'old line',
          ReplacementContent: 'new line',
        }),
      ).toEqual({ before: 'old line', after: 'new line' });
    });

    it('treats Write content as all-additions (empty before)', () => {
      expect(
        extractDiffPairFromToolInput({
          file_path: '/x.ts',
          content: 'hello\nworld',
        }),
      ).toEqual({ before: '', after: 'hello\nworld' });
    });

    it('treats Antigravity write_to_file CodeContent as all-additions', () => {
      expect(
        extractDiffPairFromToolInput({
          TargetFile: '/x.ts',
          CodeContent: ' consoles.log(1)\n',
        }),
      ).toEqual({ before: '', after: ' consoles.log(1)\n' });
    });

    it('treats Contents alias as all-additions', () => {
      expect(
        extractDiffPairFromToolInput({
          TargetFile: '/x.ts',
          Contents: 'body\n',
        }),
      ).toEqual({ before: '', after: 'body\n' });
    });

    it('treats Cursor streamContent as all-additions (empty before)', () => {
      expect(
        extractDiffPairFromToolInput({
          path: '/x.ts',
          streamContent: 'const bar = 1;\n',
        }),
      ).toEqual({ before: '', after: 'const bar = 1;\n' });
    });

    it('extracts diff from Kiro oldStr and newStr', () => {
      expect(
        extractDiffPairFromToolInput({
          path: '/x.ts',
          oldStr: 'const foo = 1;',
          newStr: 'const foo = 2;',
        }),
      ).toEqual({ before: 'const foo = 1;', after: 'const foo = 2;' });
    });

    it('extracts diff from Kiro diff array content', () => {
      expect(
        extractDiffPairFromToolInput({
          command: 'create',
          content: [
            {
              type: 'diff',
              path: '/a/b.ts',
              oldText: 'original code',
              newText: 'updated code',
            },
          ],
        }),
      ).toEqual({ before: 'original code', after: 'updated code' });
    });

    it('extracts diff from Copilot patch string', () => {
      const patch = '*** Begin Patch\n*** Update File: src/main.ts\n@@\n-const a = 1;\n+const a = 2;\n*** End Patch\n';
      expect(
        extractDiffPairFromToolInput({ patch }, 'src/main.ts'),
      ).toEqual({ before: 'const a = 1;', after: 'const a = 2;' });
    });

    it('extracts diff from unified git diff string', () => {
      const diff = 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
      expect(
        extractDiffPairFromToolInput({ diff }, 'src/main.ts'),
      ).toEqual({ before: 'const a = 1;', after: 'const a = 2;' });
    });

    it('returns null when input has no diffable fields', () => {
      expect(extractDiffPairFromToolInput(null)).toBeNull();
      expect(extractDiffPairFromToolInput({ path: '/x.ts' })).toBeNull();
      expect(extractDiffPairFromToolInput({ command: 'ls' })).toBeNull();
    });
  });

  describe('resolveFileChangeToolInput', () => {
    it('prefers toolUseId lookup over path', () => {
      const byId = new Map([['t1', { old_string: 'a', new_string: 'b' }]]);
      const byPath = new Map([['/x.ts', { streamContent: 'other' }]]);
      expect(
        resolveFileChangeToolInput({ path: '/x.ts', toolUseId: 't1' }, byId, byPath),
      ).toEqual({ old_string: 'a', new_string: 'b' });
    });

    it('falls back to path when toolUseId is missing (Cursor legacy)', () => {
      const byId = new Map<string, Record<string, unknown>>();
      const byPath = new Map([['/x.ts', { path: '/x.ts', streamContent: 'hi' }]]);
      expect(
        resolveFileChangeToolInput({ path: '/x.ts' }, byId, byPath),
      ).toEqual({ path: '/x.ts', streamContent: 'hi' });
    });

    it('returns undefined when neither id nor path matches', () => {
      expect(
        resolveFileChangeToolInput({ path: '/missing.ts' }, new Map(), new Map()),
      ).toBeUndefined();
    });
  });

  describe('extractFileInfo', () => {
    it('extracts TargetFile with lines and instruction', () => {
      const res = extractFileInfo({
        TargetFile: '/home/user/project/src/index.ts',
        StartLine: 10,
        EndLine: 25,
        Instruction: 'Update export',
      });
      expect(res).toEqual({
        path: '/home/user/project/src/index.ts',
        startLine: 10,
        endLine: 25,
        instruction: 'Update export',
        description: undefined,
      });
    });

    it('extracts AbsolutePath', () => {
      const res = extractFileInfo({
        AbsolutePath: '/etc/hosts',
      });
      expect(res?.path).toBe('/etc/hosts');
    });

    it('returns null for inputs without file paths', () => {
      expect(extractFileInfo(null)).toBeNull();
      expect(extractFileInfo({})).toBeNull();
      expect(extractFileInfo({ command: 'ls' })).toBeNull();
    });
  });

  describe('extractCommand', () => {
    it('extracts command from CommandLine or command', () => {
      expect(extractCommand({ CommandLine: 'npm run test' })).toBe('npm run test');
      expect(extractCommand({ command: 'git status' })).toBe('git status');
      expect(extractCommand({ cmd: 'echo hi' })).toBe('echo hi');
      expect(extractCommand({})).toBeNull();
    });
  });

  describe('extractQuery', () => {
    it('extracts query and search path', () => {
      expect(extractQuery({ Query: 'findMe', SearchPath: '/src' })).toEqual({
        query: 'findMe',
        path: '/src',
      });
      expect(extractQuery({ Pattern: '*.json' })).toEqual({
        query: '*.json',
        path: undefined,
      });
      expect(extractQuery({})).toBeNull();
    });
  });

  describe('extractUrl', () => {
    it('extracts HTTP/HTTPS URLs', () => {
      expect(extractUrl({ Url: 'https://example.com' })).toBe('https://example.com');
      expect(extractUrl({ url: 'http://localhost:8788' })).toBe('http://localhost:8788');
      expect(extractUrl({ Url: 'not-a-url' })).toBeNull();
    });
  });

  describe('summarizeToolInput', () => {
    it('summarizes various tool inputs cleanly', () => {
      expect(summarizeToolInput('bash', { command: 'git diff' })).toBe('git diff');
      expect(summarizeToolInput('replace', { TargetFile: '/src/main.ts' })).toBe('/src/main.ts');
      expect(summarizeToolInput('grep', { Query: 'search' })).toBe('search');
      expect(summarizeToolInput('fetch', { Url: 'https://api.github.com' })).toBe('https://api.github.com');
      expect(summarizeToolInput('custom', { foo: 'bar' })).toBe('foo: bar');
    });
  });

  describe('getToolCategory', () => {
    it('correctly maps tool names to categories', () => {
      expect(getToolCategory('run_command')).toBe('command');
      expect(getToolCategory('bash')).toBe('command');
      expect(getToolCategory('write_to_file')).toBe('file');
      expect(getToolCategory('replace_file_content')).toBe('file');
      expect(getToolCategory('grep_search')).toBe('search');
      expect(getToolCategory('read_url_content')).toBe('web');
      expect(getToolCategory('custom_agent')).toBe('generic');
    });
  });
});

describe('TurnInfoModal layout', () => {
  const dummyTurn: PromptTurn = {
    id: 'turn-1',
    prompt: {
      event: {
        id: 'p-1',
        seq: 1,
        type: 'prompt',
        ts: 1700000000000,
        sessionId: 's-1',
        payload: { text: 'Fix the layout of the modal' },
      },
    },
    events: [
      {
        event: {
          id: 'tc-1',
          seq: 2,
          type: 'tool_call',
          ts: 1700000001000,
          sessionId: 's-1',
          payload: {
            name: 'run_command',
            toolUseId: 'tu-1',
            input: { CommandLine: 'git status' },
          },
        },
      },
      {
        event: {
          id: 'fc-1',
          seq: 3,
          type: 'file_change',
          ts: 1700000002000,
          sessionId: 's-1',
          payload: {
            path: 'src/index.css',
            kind: 'modified',
            additions: 12,
            deletions: 4,
          },
        },
      },
    ],
  };

  it('renders header with title icon, agent model badge, and live running indicator', () => {
    const html = renderToStaticMarkup(
      React.createElement(TurnInfoModal, {
        turn: dummyTurn,
        agentModel: 'Claude Code · Haiku 4.5',
        elapsedMs: 151000, // 2m 31s
        isTurnActive: true,
        onClose: () => {},
      })
    );

    expect(html).toContain('turn-modal-title');
    expect(html).toContain('Turn Information');
    expect(html).toContain('turn-modal-badge--agent');
    expect(html).toContain('Claude Code · Haiku 4.5');
    expect(html).toContain('turn-modal-badge--running');
    expect(html).toContain('turn-status-pulse');
    expect(html).toContain('Running 2m 31s');
    expect(html).toContain('modal-close-btn');
    expect(html).toContain('turn-overview-card--agent');
    expect(html).toContain('turn-stat-value--agent');
  });

  it('renders settled badge with duration when turn is not active', () => {
    const html = renderToStaticMarkup(
      React.createElement(TurnInfoModal, {
        turn: dummyTurn,
        agentModel: 'Claude 3.5 Sonnet',
        elapsedMs: 45000,
        isTurnActive: false,
        onClose: () => {},
      })
    );

    expect(html).toContain('turn-modal-badge--settled');
    expect(html).toContain('45s');
    expect(html).not.toContain('turn-modal-badge--running');
  });

  it('renders subHeader tabs outside and before modal-body with proper count badges', () => {
    const html = renderToStaticMarkup(
      React.createElement(TurnInfoModal, {
        turn: dummyTurn,
        agentModel: 'Claude Code',
        onClose: () => {},
      })
    );

    expect(html).toContain('turn-modal-subnav');
    expect(html).toContain('turn-modal-tab-bar');
    expect(html).toContain('turn-tab-label--desktop');
    expect(html).toContain('All Details');
    expect(html).toContain('Overview');
    expect(html).toContain('Tools');
    expect(html).toContain('Files');
    expect(html).toContain('turn-tab-count');

    // Tool count is 1, file count is 1 from dummyTurn
    expect(html).toContain('>1</span>');

    // Ensure turn-modal-subnav is placed before modal-body, not inside it
    const subnavIdx = html.indexOf('turn-modal-subnav');
    const modalBodyIdx = html.indexOf('modal-body');
    expect(subnavIdx).toBeGreaterThan(-1);
    expect(modalBodyIdx).toBeGreaterThan(subnavIdx);
  });

  describe('token and cache rendering', () => {
    it('renders tokens and cache read hint when cacheReadTokens is present', () => {
      const turnWithCache: PromptTurn = {
        ...dummyTurn,
        events: [
          ...dummyTurn.events,
          {
            event: {
              id: 'st-1',
              seq: 4,
              type: 'status',
              ts: 1700000003000,
              sessionId: 's-1',
              payload: {
                status: 'done',
                inputTokens: 1200,
                outputTokens: 450,
                cacheReadTokens: 1500,
              },
            },
          },
        ],
      };

      const html = renderToStaticMarkup(
        React.createElement(TurnInfoModal, {
          turn: turnWithCache,
          onClose: () => {},
        })
      );

      expect(html).toContain('Tokens (In / Out)');
      expect(html).toContain('1,200 / 450');
      expect(html).toContain('Cache read: 1,500');
    });

    it('renders tokens with read and write cache hints when both are present', () => {
      const turnWithBothCache: PromptTurn = {
        ...dummyTurn,
        events: [
          ...dummyTurn.events,
          {
            event: {
              id: 'st-1',
              seq: 4,
              type: 'status',
              ts: 1700000003000,
              sessionId: 's-1',
              payload: {
                status: 'done',
                inputTokens: 2000,
                outputTokens: 500,
                cacheReadTokens: 1500,
                cacheCreationTokens: 300,
              },
            },
          },
        ],
      };

      const html = renderToStaticMarkup(
        React.createElement(TurnInfoModal, {
          turn: turnWithBothCache,
          onClose: () => {},
        })
      );

      expect(html).toContain('Tokens (In / Out)');
      expect(html).toContain('2,000 / 500');
      expect(html).toContain('Cache read: 1,500 · write: 300');
    });

    it('renders cache write hint when only cacheCreationTokens is present', () => {
      const turnWithWriteCache: PromptTurn = {
        ...dummyTurn,
        events: [
          ...dummyTurn.events,
          {
            event: {
              id: 'st-1',
              seq: 4,
              type: 'status',
              ts: 1700000003000,
              sessionId: 's-1',
              payload: {
                status: 'done',
                inputTokens: 2000,
                outputTokens: 500,
                cacheCreationTokens: 300,
              },
            },
          },
        ],
      };

      const html = renderToStaticMarkup(
        React.createElement(TurnInfoModal, {
          turn: turnWithWriteCache,
          onClose: () => {},
        })
      );

      expect(html).toContain('Tokens (In / Out)');
      expect(html).toContain('2,000 / 500');
      expect(html).toContain('Cache write: 300');
    });

    it('omits cache hint when status payload does not include cache tokens', () => {
      const turnNoCache: PromptTurn = {
        ...dummyTurn,
        events: [
          ...dummyTurn.events,
          {
            event: {
              id: 'st-1',
              seq: 4,
              type: 'status',
              ts: 1700000003000,
              sessionId: 's-1',
              payload: {
                status: 'done',
                inputTokens: 800,
                outputTokens: 200,
              },
            },
          },
        ],
      };

      const html = renderToStaticMarkup(
        React.createElement(TurnInfoModal, {
          turn: turnNoCache,
          onClose: () => {},
        })
      );

      expect(html).toContain('Tokens (In / Out)');
      expect(html).toContain('800 / 200');
      expect(html).not.toContain('Cache read');
      expect(html).not.toContain('Cache write');
    });
  });
});
