import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchConversationContent } from './api.js';

describe('searchConversationContent scope', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('omits projectId when not given (Ctrl+K path)', async () => {
    await searchConversationContent('hello world');
    expect(fetchMock.mock.calls[0][0]).toBe('/conversations/search?q=hello%20world');
  });

  it('omits projectId when empty string', async () => {
    await searchConversationContent('hi', '');
    expect(fetchMock.mock.calls[0][0]).toBe('/conversations/search?q=hi');
  });

  it('appends an encoded projectId when given', async () => {
    await searchConversationContent('hi', 'p/1&x');
    expect(fetchMock.mock.calls[0][0]).toBe('/conversations/search?q=hi&projectId=p%2F1%26x');
  });

  it('returns [] on 400 (unindexable query)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    expect(await searchConversationContent('!!', 'p1')).toEqual([]);
  });

  it('adds matchesPerConversation and limit after projectId when opts given', async () => {
    await searchConversationContent('hi', 'p1', { matchesPerConversation: 5, limit: 20 });
    expect(fetchMock.mock.calls[0][0]).toBe('/conversations/search?q=hi&projectId=p1&matchesPerConversation=5&limit=20');
  });
});
