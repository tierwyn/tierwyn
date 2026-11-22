import { describe, expect, it } from 'vitest';
import { modelResourcePath } from './cataloguePaths.js';

describe('modelResourcePath', () => {
  it('encodes slashes so Express :id stays one segment', () => {
    expect(modelResourcePath('kilocode:kilo/anthropic/claude-opus-4')).toBe(
      '/models/kilocode%3Akilo%2Fanthropic%2Fclaude-opus-4',
    );
  });

  it('encodes tabs/spaces left by pre-split agy model lines', () => {
    const id = 'antigravity:gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)';
    expect(modelResourcePath(id)).toBe(
      '/models/antigravity%3Agemini-3.6-flash-medium%09Gemini%203.6%20Flash%20(Medium)',
    );
    // Unencoded fetch URLs strip the tab and look up a non-existent id.
    expect(new URL(`/models/${id}`, 'http://127.0.0.1').pathname).not.toBe(
      new URL(modelResourcePath(id), 'http://127.0.0.1').pathname,
    );
  });
});
