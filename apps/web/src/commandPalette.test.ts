import { describe, it, expect } from 'vitest';
import type { Conversation, Project } from '@tierwyn/shared';
import type { ConversationSearchHit } from './api.js';
import {
  isPaletteHotkey,
  isMessageSearchHotkey,
  parseMessagePrefix,
  resolveMessageScopeProjectId,
  highlightSegments,
  groupMessageHits,
  shouldIgnoreHotkeyTarget,
  scoreConversation,
  filterPaletteItems,
  wrapPaletteIndex,
  groupPaletteItems,
  getRecentSearches,
  saveRecentSearch,
  removeRecentSearch,
  clearRecentSearches,
  CORE_ACTIONS,
  type PaletteConversationItem,
  type PaletteProjectItem,
} from './commandPalette.js';

function makeConv(partial: Partial<Conversation> & { id: string; projectId: string; title: string }): Conversation {
  return {
    id: partial.id,
    projectId: partial.projectId,
    title: partial.title,
    description: partial.description,
    createdAt: partial.createdAt ?? 1000,
    updatedAt: partial.updatedAt ?? 1000,
    pinned: partial.pinned,
    tags: partial.tags,
  };
}

function makeProj(id: string, name: string): Project {
  return { id, name, rootPath: `/tmp/${id}`, createdAt: 1000 };
}

describe('isPaletteHotkey', () => {
  it('recognizes Ctrl+k / Ctrl+K and Meta+k / Meta+K', () => {
    expect(isPaletteHotkey({ key: 'k', ctrlKey: true })).toBe(true);
    expect(isPaletteHotkey({ key: 'K', ctrlKey: true })).toBe(true);
    expect(isPaletteHotkey({ key: 'k', metaKey: true })).toBe(true);
    expect(isPaletteHotkey({ key: 'K', metaKey: true })).toBe(true);
  });

  it('rejects when Shift or Alt is also pressed', () => {
    expect(isPaletteHotkey({ key: 'k', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isPaletteHotkey({ key: 'k', metaKey: true, altKey: true })).toBe(false);
    expect(isPaletteHotkey({ key: 'k', ctrlKey: true, altKey: true })).toBe(false);
  });

  it('rejects unrelated keys or missing modifiers', () => {
    expect(isPaletteHotkey({ key: 'k' })).toBe(false);
    expect(isPaletteHotkey({ key: 'f', ctrlKey: true })).toBe(false);
    expect(isPaletteHotkey({ key: 'p', metaKey: true })).toBe(false);
  });

  it('rejects during IME composition', () => {
    expect(isPaletteHotkey({ key: 'k', ctrlKey: true, isComposing: true })).toBe(false);
  });
});

describe('shouldIgnoreHotkeyTarget', () => {
  it('returns false for null, body or generic containers', () => {
    expect(shouldIgnoreHotkeyTarget(null)).toBe(false);
    const div = { tagName: 'DIV', closest: () => null } as unknown as EventTarget;
    expect(shouldIgnoreHotkeyTarget(div)).toBe(false);
  });

  it('returns false for prompt input / textarea outside of modal-overlay', () => {
    const input = {
      tagName: 'INPUT',
      closest: (sel: string) => (sel === '.modal-overlay' ? null : null),
    } as unknown as EventTarget;
    expect(shouldIgnoreHotkeyTarget(input)).toBe(false);

    const textarea = {
      tagName: 'TEXTAREA',
      closest: (sel: string) => (sel === '.modal-overlay' ? null : null),
    } as unknown as EventTarget;
    expect(shouldIgnoreHotkeyTarget(textarea)).toBe(false);
  });

  it('returns true for input / textarea inside an active modal-overlay', () => {
    const modalEl = {};
    const inputInModal = {
      tagName: 'INPUT',
      closest: (sel: string) => {
        if (sel === '.modal-overlay') return modalEl;
        if (sel === '.command-palette-overlay') return null;
        return null;
      },
    } as unknown as EventTarget;
    expect(shouldIgnoreHotkeyTarget(inputInModal)).toBe(true);
  });

  it('returns false for input inside command-palette-overlay (allows re-focusing/selecting query)', () => {
    const modalEl = {};
    const paletteEl = {};
    const inputInPalette = {
      tagName: 'INPUT',
      closest: (sel: string) => {
        if (sel === '.command-palette-overlay') return paletteEl;
        if (sel === '.modal-overlay') return modalEl;
        return null;
      },
    } as unknown as EventTarget;
    expect(shouldIgnoreHotkeyTarget(inputInPalette)).toBe(false);
  });
});

describe('scoreConversation', () => {
  const conv = makeConv({
    id: 'c1',
    projectId: 'p1',
    title: 'Deploy Production Worker',
    description: 'Fixing redis cache latency',
    updatedAt: 5000,
  });

  it('scores title starts-with highest (tier 3)', () => {
    expect(scoreConversation(conv, 'deploy')).toBe(3);
    expect(scoreConversation(conv, 'dep')).toBe(3);
  });

  it('scores title includes as tier 2', () => {
    expect(scoreConversation(conv, 'production')).toBe(2);
    expect(scoreConversation(conv, 'worker')).toBe(2);
  });

  it('scores description includes as tier 1', () => {
    expect(scoreConversation(conv, 'redis')).toBe(1);
    expect(scoreConversation(conv, 'latency')).toBe(1);
  });

  it('scores no match as tier 0', () => {
    expect(scoreConversation(conv, 'database')).toBe(0);
  });
});

describe('filterPaletteItems', () => {
  const projects: Project[] = [
    makeProj('p1', 'Alpha Project'),
    makeProj('p2', 'Beta Project'),
  ];
  const conversations: Conversation[] = [
    makeConv({ id: 'c1', projectId: 'p1', title: 'Refactor auth middleware', description: 'JWT rotation', updatedAt: 3000 }),
    makeConv({ id: 'c2', projectId: 'p1', title: 'Auth rate limiter', description: 'Token bucket', updatedAt: 2000 }),
    makeConv({ id: 'c3', projectId: 'p2', title: 'Database migrations', description: 'Auth schema updates', updatedAt: 4000 }),
    makeConv({ id: 'c4', projectId: 'p2', title: 'Changelog release', updatedAt: 1000 }),
  ];

  it('returns bounded defaults when query is empty (3 actions, up to 8 convos by updatedAt desc, all projects)', () => {
    const extra: Conversation[] = [
      makeConv({ id: 'c5', projectId: 'p1', title: 'Fifth', updatedAt: 900 }),
      makeConv({ id: 'c6', projectId: 'p1', title: 'Sixth', updatedAt: 800 }),
      makeConv({ id: 'c7', projectId: 'p2', title: 'Seventh', updatedAt: 700 }),
      makeConv({ id: 'c8', projectId: 'p2', title: 'Eighth', updatedAt: 600 }),
      makeConv({ id: 'c9', projectId: 'p2', title: 'Ninth (over cap)', updatedAt: 500 }),
    ];
    const result = filterPaletteItems({
      query: '',
      projects,
      conversations: [...conversations, ...extra],
    });
    expect(result.actions).toHaveLength(3);
    expect(result.actions.map((a) => a.label)).toEqual(['New chat', 'Open schedules', 'Open settings']);
    expect(result.conversations).toHaveLength(8);
    // Ordered by updatedAt desc; c9 (500) is the 9th and must be dropped.
    expect(result.conversations.map((c) => c.id)).toEqual(['c3', 'c1', 'c2', 'c4', 'c5', 'c6', 'c7', 'c8']);
    expect(result.projects).toHaveLength(2);
  });

  it('filters and sorts conversations by tier (starts-with > title-includes > desc-includes) and tie-breaks by updatedAt', () => {
    const result = filterPaletteItems({
      query: 'auth',
      projects,
      conversations,
    });
    // c2 starts-with "Auth" (tier 3, updatedAt 2000)
    // c1 includes "auth" in title (tier 2, updatedAt 3000)
    // c3 includes "Auth" in desc (tier 1, updatedAt 4000)
    expect(result.conversations.map((c) => c.id)).toEqual(['c2', 'c1', 'c3']);
  });

  it('filters actions matching the query', () => {
    const result = filterPaletteItems({
      query: 'open sett',
      projects,
      conversations,
    });
    expect(result.actions.map((a) => a.label)).toEqual(['Open settings']);
  });

  it('matches settings tabs and ⋮-menu actions when queried', () => {
    const voice = filterPaletteItems({ query: 'voice', projects, conversations });
    expect(voice.actions.map((a) => a.label)).toContain('Settings: Voice');

    const recordings = filterPaletteItems({ query: 'record', projects, conversations });
    expect(recordings.actions.map((a) => a.actionType)).toEqual(['open_recordings']);

    const agentUsage = filterPaletteItems({ query: 'agent usage', projects, conversations });
    expect(agentUsage.actions.map((a) => a.actionType)).toEqual(['open_agent_usage']);

    const markdown = filterPaletteItems({ query: 'markdown', projects, conversations });
    expect(markdown.actions.map((a) => a.actionType).sort()).toEqual(['export_markdown', 'open_markdown']);
  });

  it('filters projects matching the query', () => {
    const result = filterPaletteItems({
      query: 'alph',
      projects,
      conversations,
    });
    expect(result.projects.map((p) => p.name)).toEqual(['Alpha Project']);
  });

  it('deduplicates content search hits that are already in matched conversations', () => {
    const contentHits: ConversationSearchHit[] = [
      { id: 'c2', projectId: 'p1', title: 'Auth rate limiter', updatedAt: 2000, eventId: 'e1', snippet: 'hit in c2' },
      { id: 'c4', projectId: 'p2', title: 'Changelog release', updatedAt: 1000, eventId: 'e2', snippet: 'hit in c4' },
    ];
    const result = filterPaletteItems({
      query: 'auth',
      projects,
      conversations,
      contentHits,
    });
    // c2 is already in result.conversations; c4 is not
    expect(result.conversations.map((c) => c.id)).toContain('c2');
    expect(result.contentHits.map((h) => h.conversationId)).toEqual(['c4']);
  });

  it('surfaces the schedule calendar action for calendar/month queries', () => {
    const byName = filterPaletteItems({ query: 'schedule calendar', projects, conversations });
    expect(byName.actions.map((a) => a.actionType)).toContain('open_schedule_calendar');

    const byKeyword = filterPaletteItems({ query: 'month grid', projects, conversations });
    expect(byKeyword.actions.map((a) => a.actionType)).toEqual(['open_schedule_calendar']);
  });
});

describe('groupPaletteItems & totalCap', () => {
  const actions = CORE_ACTIONS;
  const conversations: PaletteConversationItem[] = [
    { kind: 'conversation', id: 'c1', conversationId: 'c1', projectId: 'p1', title: 'Chat 1', updatedAt: 100 },
  ];
  const projects: PaletteProjectItem[] = [
    { kind: 'project', id: 'p1', projectId: 'p1', name: 'Project 1' },
  ];

  it('groups items into respective sections with correct order', () => {
    const { sections, flatItems } = groupPaletteItems({
      actions: [...actions],
      conversations,
      projects,
    });
    expect(sections.map((s) => s.title)).toEqual(['Actions', 'Conversations', 'Projects']);
    expect(flatItems).toHaveLength(5);
  });

  it('enforces total cap across sections', () => {
    const manyConvs: PaletteConversationItem[] = Array.from({ length: 60 }, (_, i) => ({
      kind: 'conversation',
      id: `c-${i}`,
      conversationId: `c-${i}`,
      projectId: 'p1',
      title: `Chat ${i}`,
      updatedAt: 100 + i,
    }));
    const { flatItems } = groupPaletteItems({
      actions: [...actions],
      conversations: manyConvs,
      projects,
      totalCap: 50,
    });
    expect(flatItems).toHaveLength(50);
  });
});

describe('wrapPaletteIndex', () => {
  it('handles wrap forward and backward', () => {
    expect(wrapPaletteIndex(0, 1, 4)).toBe(1);
    expect(wrapPaletteIndex(3, 1, 4)).toBe(0);
    expect(wrapPaletteIndex(0, -1, 4)).toBe(3);
    expect(wrapPaletteIndex(2, -1, 4)).toBe(1);
  });

  it('handles negative or invalid initial index', () => {
    expect(wrapPaletteIndex(-1, 1, 4)).toBe(0);
    expect(wrapPaletteIndex(-1, -1, 4)).toBe(3);
    expect(wrapPaletteIndex(0, 1, 0)).toBe(-1);
  });
});

describe('recent searches storage and grouping', () => {
  it('saves, dedupes, caps at 5, removes, and clears recent searches', () => {
    clearRecentSearches();
    expect(getRecentSearches()).toEqual([]);

    saveRecentSearch('agent usage');
    saveRecentSearch('schedules');
    saveRecentSearch('auth');
    saveRecentSearch('agent usage'); // should dedupe and move to front
    expect(getRecentSearches()).toEqual(['agent usage', 'auth', 'schedules']);

    saveRecentSearch('s4');
    saveRecentSearch('s5');
    saveRecentSearch('s6'); // caps at 5
    expect(getRecentSearches()).toHaveLength(5);
    expect(getRecentSearches()[0]).toBe('s6');

    removeRecentSearch('auth');
    expect(getRecentSearches()).not.toContain('auth');

    clearRecentSearches();
    expect(getRecentSearches()).toEqual([]);
  });

  it('includes Recent Searches section when query is empty and recentSearches are provided', () => {
    const result = filterPaletteItems({
      query: '',
      projects: [],
      conversations: [],
      recentSearches: ['redis cache', 'docker setup'],
    });
    expect(result.recentSearches).toHaveLength(2);
    expect(result.recentSearches.map((r) => r.query)).toEqual(['redis cache', 'docker setup']);

    const grouped = groupPaletteItems({
      recentSearches: result.recentSearches,
      actions: result.actions,
      conversations: result.conversations,
      projects: result.projects,
    });
    expect(grouped.sections[0]?.title).toBe('Recent Searches');
    expect(grouped.sections[0]?.items).toHaveLength(2);
    expect(grouped.flatItems[0]?.kind).toBe('recent');
  });

  it('hides Recent Searches section when query is non-empty', () => {
    const result = filterPaletteItems({
      query: 'docker',
      projects: [],
      conversations: [],
      recentSearches: ['redis cache', 'docker setup'],
    });
    expect(result.recentSearches).toHaveLength(0);
  });

  it('routes the BTW settings action to Sidecar LLMs via label and keywords', () => {
    const result = filterPaletteItems({
      query: 'btw',
      projects: [],
      conversations: [],
    });
    const btw = result.actions.find((a) => a.id === 'action-settings-btw');
    expect(btw).toBeDefined();
    expect(btw?.label).toBe('Settings: BTW side question');
    expect(btw?.keywords).toMatch(/sidecar/);
  });
});

describe('isMessageSearchHotkey', () => {
  it('accepts Ctrl/Cmd+Shift+F in either case', () => {
    expect(isMessageSearchHotkey({ key: 'F', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isMessageSearchHotkey({ key: 'f', metaKey: true, shiftKey: true })).toBe(true);
  });
  it('rejects plain Ctrl+F, Alt, missing modifier, and IME composition', () => {
    expect(isMessageSearchHotkey({ key: 'f', ctrlKey: true })).toBe(false);
    expect(isMessageSearchHotkey({ key: 'F', ctrlKey: true, shiftKey: true, altKey: true })).toBe(false);
    expect(isMessageSearchHotkey({ key: 'F', shiftKey: true })).toBe(false);
    expect(isMessageSearchHotkey({ key: 'F', ctrlKey: true, shiftKey: true, isComposing: true })).toBe(false);
  });
  it('does not collide with the Ctrl+K palette hotkey', () => {
    expect(isPaletteHotkey({ key: 'F', ctrlKey: true, shiftKey: true })).toBe(false);
  });
});

describe('parseMessagePrefix', () => {
  it('strips "? " and ignores anything else', () => {
    expect(parseMessagePrefix('? foo')).toBe('foo');
    expect(parseMessagePrefix('? ')).toBe('');
    expect(parseMessagePrefix('?foo')).toBeNull();
    expect(parseMessagePrefix('foo ? bar')).toBeNull();
  });
});

describe('resolveMessageScopeProjectId', () => {
  it('only scopes when project scope and an active project exist', () => {
    expect(resolveMessageScopeProjectId('project', 'p1')).toBe('p1');
    expect(resolveMessageScopeProjectId('project', null)).toBeUndefined();
    expect(resolveMessageScopeProjectId('all', 'p1')).toBeUndefined();
  });
});

describe('highlightSegments', () => {
  it('marks every case-insensitive occurrence and round-trips the text', () => {
    const segs = highlightSegments('Marmalade and more marmalade', 'marmalade');
    expect(segs).toEqual([
      { text: 'Marmalade', hit: true }, { text: ' and more ', hit: false }, { text: 'marmalade', hit: true },
    ]);
    expect(segs.map((s) => s.text).join('')).toBe('Marmalade and more marmalade');
  });
  it('matches a prefix of the last token (as-you-type) and prefers longer tokens', () => {
    expect(highlightSegments('regenerate it', 'regen')).toEqual([{ text: 'regen', hit: true }, { text: 'erate it', hit: false }]);
    expect(highlightSegments('foobar', 'foo foobar')).toEqual([{ text: 'foobar', hit: true }]);
  });
  it('escapes regex metacharacters and survives punctuation-only queries', () => {
    expect(highlightSegments('a.b (c)', '.*( ')).toEqual([{ text: 'a.b (c)', hit: false }]);
    expect(highlightSegments('a+b', 'a+b').some((s) => s.hit)).toBe(false); // token becomes "ab"
  });
  it('handles empty text, duplicate tokens and non-ASCII letters', () => {
    expect(highlightSegments('', 'foo')).toEqual([]);
    expect(highlightSegments('foo bar', 'foo FOO foo')).toEqual([{ text: 'foo', hit: true }, { text: ' bar', hit: false }]);
    expect(highlightSegments('Ärger über', 'über')).toEqual([{ text: 'Ärger ', hit: false }, { text: 'über', hit: true }]);
  });
});

describe('groupMessageHits', () => {
  it('makes one section per conversation and one item per match', () => {
    const hits: ConversationSearchHit[] = [
      { id: 'c1', projectId: 'p1', title: 'One', updatedAt: 5, eventId: 'e2', snippet: 's2',
        matches: [{ eventId: 'e2', snippet: 's2', ts: 2, sender: 'agent' }, { eventId: 'e1', snippet: 's1', ts: 1, sender: 'user' }] },
      { id: 'c2', projectId: 'p2', title: 'Two', updatedAt: 4, eventId: 'e9', snippet: 's9' },
    ];
    const { sections, flatItems } = groupMessageHits(hits, [makeProj('p1', 'Alpha'), makeProj('p2', 'Beta')]);
    expect(sections.map((s) => [s.title, s.projectName, s.items.length])).toEqual([['One', 'Alpha', 2], ['Two', 'Beta', 1]]);
    expect(flatItems.map((i) => i.id)).toEqual(['msg-c1-e2', 'msg-c1-e1', 'msg-c2-e9']);
    expect(flatItems[1]).toMatchObject({
      kind: 'content', eventId: 'e1', conversationId: 'c1', projectId: 'p1', title: 'One',
      projectName: 'Alpha', snippet: 's1', ts: 1, sender: 'user',
    });
    expect(flatItems[2]).toMatchObject({ eventId: 'e9', snippet: 's9', ts: 4, sender: 'agent' });
  });
  it('keeps two same-titled conversations as separate sections', () => {
    const mk = (id: string): ConversationSearchHit => ({ id, projectId: 'p1', title: 'Untitled', updatedAt: 1, eventId: `e-${id}`, snippet: 's' });
    const { sections } = groupMessageHits([mk('a'), mk('b')], [makeProj('p1', 'Alpha')]);
    expect(sections.map((s) => s.conversationId)).toEqual(['a', 'b']);
  });

  it('preserves helper sender on message hits', () => {
    const hits: ConversationSearchHit[] = [{
      id: 'c1', projectId: 'p1', title: 'One', updatedAt: 5, eventId: 'eH', snippet: 'Explore list files',
      matches: [{ eventId: 'eH', snippet: 'Explore list files', ts: 3, sender: 'helper' }],
    }];
    const { flatItems } = groupMessageHits(hits, [makeProj('p1', 'Alpha')]);
    expect(flatItems[0]).toMatchObject({ sender: 'helper', eventId: 'eH' });
  });
});
