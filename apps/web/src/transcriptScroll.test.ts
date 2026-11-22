import { describe, it, expect } from 'vitest';
import { isPinnedToBottom, shouldPinOnContentResize } from './transcriptScroll.js';

describe('isPinnedToBottom', () => {
  it('treats the viewport as pinned when remaining scroll is within slack', () => {
    expect(isPinnedToBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 80, slack: 80 })).toBe(true);
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 80, slack: 80 })).toBe(false);
  });
});

describe('shouldPinOnContentResize', () => {
  it('pins during the sticky window after a conversation load', () => {
    expect(shouldPinOnContentResize({
      now: 1000,
      stickyUntil: 1600,
      autoScroll: true,
      agentStatus: 'idle',
      heightGrew: true,
    })).toBe(true);
  });

  it('pins while the agent is running and auto-scroll is on', () => {
    expect(shouldPinOnContentResize({
      now: 5000,
      stickyUntil: 0,
      autoScroll: true,
      agentStatus: 'running',
      heightGrew: true,
    })).toBe(true);
  });

  it('does not pin an idle conversation after the sticky window — image load must not yank the pane', () => {
    expect(shouldPinOnContentResize({
      now: 5000,
      stickyUntil: 1600,
      autoScroll: true,
      agentStatus: 'idle',
      heightGrew: true,
    })).toBe(false);
  });

  it('does not pin when content height did not grow (avoids scrollbar oscillation)', () => {
    expect(shouldPinOnContentResize({
      now: 1000,
      stickyUntil: 1600,
      autoScroll: true,
      agentStatus: 'running',
      heightGrew: false,
    })).toBe(false);
  });

  it('does not pin when auto-scroll is off, even while running', () => {
    expect(shouldPinOnContentResize({
      now: 1000,
      stickyUntil: 0,
      autoScroll: false,
      agentStatus: 'running',
      heightGrew: true,
    })).toBe(false);
  });

  it('does not pin when prependGuard is active, even during sticky window or running with growth', () => {
    expect(shouldPinOnContentResize({
      now: 1000,
      stickyUntil: 1600,
      autoScroll: true,
      agentStatus: 'running',
      heightGrew: true,
      prependGuard: true,
    })).toBe(false);
  });
});
