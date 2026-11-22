import { describe, it, expect } from 'vitest';
import type { PromptCollectionEntry } from '@tierwyn/shared';
import { filterPrompts, buildSearchRegex, matchesWords } from './promptSearch.js';

const mockPrompts: PromptCollectionEntry[] = [
  {
    id: 'preset-code-review',
    name: 'Code review this diff',
    description: 'Correctness, contracts, concurrency and security.',
    body: 'Review the following git diff carefully.',
    origin: 'preset',
  },
  {
    id: 'preset-write-tests',
    name: 'Write tests',
    description: 'Unit and contract tests that fail when behavior breaks.',
    body: 'Generate unit tests covering edge cases.',
    origin: 'preset',
  },
  {
    id: 'custom-auth-debug',
    name: 'Debug auth token',
    description: 'Investigate token expiration and refresh flow.',
    body: 'Check JWT expiry and session store.',
    origin: 'custom',
  },
];

describe('promptSearch', () => {
  describe('buildSearchRegex', () => {
    it('returns null regex for empty query', () => {
      expect(buildSearchRegex('').re).toBeNull();
      expect(buildSearchRegex('').invalid).toBe(false);
    });

    it('builds valid regex', () => {
      const res = buildSearchRegex('^Code.*diff$');
      expect(res.invalid).toBe(false);
      expect(res.re).toBeInstanceOf(RegExp);
      expect(res.re?.test('Code review this diff')).toBe(true);
    });

    it('catches invalid regex', () => {
      const res = buildSearchRegex('(?+');
      expect(res.invalid).toBe(true);
      expect(res.re).toBeNull();
    });
  });

  describe('matchesWords', () => {
    it('matches all words in target', () => {
      const entry = mockPrompts[0];
      expect(matchesWords(entry, ['code', 'diff'])).toBe(true);
      expect(matchesWords(entry, ['review', 'security'])).toBe(true);
      expect(matchesWords(entry, ['review', 'missingword'])).toBe(false);
    });
  });

  describe('filterPrompts in words mode', () => {
    it('returns all when query is empty', () => {
      const { visible, regexInvalid } = filterPrompts(mockPrompts, '', 'words');
      expect(visible).toHaveLength(3);
      expect(regexInvalid).toBe(false);
    });

    it('matches multiple space-separated words (AND logic)', () => {
      const { visible } = filterPrompts(mockPrompts, 'tests unit', 'words');
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe('preset-write-tests');
    });

    it('matches across different fields', () => {
      // 'debug' in name, 'JWT' in body
      const { visible } = filterPrompts(mockPrompts, 'debug jwt', 'words');
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe('custom-auth-debug');
    });

    it('returns empty list when no prompts match all words', () => {
      const { visible } = filterPrompts(mockPrompts, 'diff jwt', 'words');
      expect(visible).toHaveLength(0);
    });
  });

  describe('filterPrompts in regex mode', () => {
    it('matches with regex alternation', () => {
      const { visible } = filterPrompts(mockPrompts, 'jwt|concurrency', 'regex');
      expect(visible).toHaveLength(2);
      expect(visible.map((v) => v.id)).toEqual(['preset-code-review', 'custom-auth-debug']);
    });

    it('handles invalid regex gracefully', () => {
      const { visible, regexInvalid } = filterPrompts(mockPrompts, '[unclosed', 'regex');
      expect(visible).toHaveLength(3);
      expect(regexInvalid).toBe(true);
    });
  });

  describe('origin filtering', () => {
    it('filters by preset origin', () => {
      const { visible } = filterPrompts(mockPrompts, '', 'words', 'preset');
      expect(visible).toHaveLength(2);
      expect(visible.every((p) => p.origin === 'preset')).toBe(true);
    });

    it('filters by custom origin with search query', () => {
      const { visible } = filterPrompts(mockPrompts, 'auth', 'words', 'custom');
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe('custom-auth-debug');
    });
  });

  describe('variable names and labels', () => {
    const withVars: PromptCollectionEntry = {
      id: 'custom-ticket',
      name: 'File a ticket',
      description: 'Open a tracking item.',
      body: 'File {{ticket}} against the current change.',
      origin: 'custom',
      variables: [
        { name: 'ticket', label: 'Jira key', default: 'unsearchable-xyzzy' },
      ],
    };

    it('word-matches a variable label that is not in name/description/body', () => {
      const { visible } = filterPrompts([withVars], 'jira', 'words');
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe('custom-ticket');
    });

    it('word-matches a variable name', () => {
      const { visible } = filterPrompts([withVars], 'ticket', 'words');
      expect(visible).toHaveLength(1);
    });

    it('does not word-match a variable default', () => {
      const { visible } = filterPrompts([withVars], 'unsearchable-xyzzy', 'words');
      expect(visible).toHaveLength(0);
    });

    it('regex-matches a variable name', () => {
      const { visible } = filterPrompts([withVars], 'ticket', 'regex');
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe('custom-ticket');
    });
  });
});
