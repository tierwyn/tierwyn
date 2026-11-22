import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromptOptionsBadge } from './PromptOptionsBadge.js';
import { promptOptionsFor } from '@tierwyn/shared';

describe('PromptOptionsBadge', () => {
  const agyDescriptors = promptOptionsFor('antigravity');

  it('renders nothing when descriptors are empty', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: [],
        options: {},
        count: 0,
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(html).toBe('');
  });

  it('renders idle options button when count is 0', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: agyDescriptors,
        options: {},
        count: 0,
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(html).toContain('prompt-options-pill-idle');
    expect(html).toContain('Options');
    expect(html).toContain('🎛');
  });

  it('renders armed badge with ⚡ and active tags when options staged', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: agyDescriptors,
        options: { mode: 'plan', sandbox: true },
        count: 2,
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(html).toContain('prompt-options-pill-armed');
    expect(html).toContain('⚡');
    expect(html).toContain('plan · sandbox');
    expect(html).toContain('prompt-options-unstage-btn');
    expect(html).toContain('aria-label="Clear staged prompt options"');
  });

  it('renders compact label on mobile view', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: agyDescriptors,
        options: { mode: 'plan', sandbox: true, disableSlashCommands: true },
        count: 3,
        compact: true,
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(html).toContain('prompt-options-pill-armed');
    expect(html).toContain('plan +2');
  });

  it('renders disabled state with disabledReason tooltip when running', () => {
    const reason = 'Options apply to a new turn — this message will be steered into the running one';
    const html = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: agyDescriptors,
        options: { mode: 'plan' },
        count: 1,
        disabled: true,
        disabledReason: reason,
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(html).toContain('is-disabled');
    expect(html).toContain(`title="${reason}"`);
  });

  it('renders error state when error is provided (MAJOR-6)', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: agyDescriptors,
        options: { jsonSchema: 'invalid' },
        count: 1,
        error: 'Option "jsonSchema" must be a valid JSON object',
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(html).toContain('prompt-options-pill-error');
    expect(html).toContain('⚠️');
    expect(html).toContain('Prompt options error: Option &quot;jsonSchema&quot; must be a valid JSON object');
    expect(html).toContain('prompt-options-unstage-btn');
  });

  it('maps autoReview toggle to auto-review tag', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: promptOptionsFor('cursor'),
        options: { autoReview: true },
        count: 1,
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(html).toContain('auto-review');
    expect(html).not.toContain('autoReview');
  });

  it('maps copilot toolsPolicy and assistedApproval to friendly tags', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: promptOptionsFor('copilot'),
        options: { toolsPolicy: 'readOnly', assistedApproval: true },
        count: 2,
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(html).toContain('read-only');
    expect(html).toContain('assisted');
    expect(html).not.toContain('toolsPolicy');
    expect(html).not.toContain('assistedApproval');
    expect(html).not.toContain('readOnly');
  });

  it('does not violate rules of hooks when transitioning between non-empty and empty descriptors (MAJOR-5)', () => {
    // Calling both states verifies all hooks run unconditionally before any early return
    const armed = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: agyDescriptors,
        options: { sandbox: true },
        count: 1,
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(armed).toContain('sandbox');

    const empty = renderToStaticMarkup(
      React.createElement(PromptOptionsBadge, {
        descriptors: [],
        options: { sandbox: true },
        count: 1,
        onOpenModal: () => {},
        onClear: () => {},
      })
    );
    expect(empty).toBe('');
  });

  describe('asMenuItem mutation', () => {
    it('mutates from pill button to popover item when idle (count === 0)', () => {
      const html = renderToStaticMarkup(
        React.createElement(PromptOptionsBadge, {
          descriptors: agyDescriptors,
          options: {},
          count: 0,
          asMenuItem: true,
          compact: true,
          onOpenModal: () => {},
          onClear: () => {},
        })
      );
      expect(html).toContain('attach-menu-item');
      expect(html).toContain('prompt-options-menu-item');
      expect(html).not.toContain('prompt-options-pill');
      expect(html).toContain('<svg');
      expect(html).toContain('Options');
      expect(html).not.toContain('🎛');
    });

    it('renders "Prompt Options…" when not compact in idle menu item', () => {
      const html = renderToStaticMarkup(
        React.createElement(PromptOptionsBadge, {
          descriptors: agyDescriptors,
          options: {},
          count: 0,
          asMenuItem: true,
          compact: false,
          onOpenModal: () => {},
          onClear: () => {},
        })
      );
      expect(html).toContain('attach-menu-item');
      expect(html).toContain('Prompt Options…');
    });

    it('mutates to popover item with active badge and unstage button when armed', () => {
      const html = renderToStaticMarkup(
        React.createElement(PromptOptionsBadge, {
          descriptors: agyDescriptors,
          options: { mode: 'plan' },
          count: 1,
          asMenuItem: true,
          compact: true,
          onOpenModal: () => {},
          onClear: () => {},
        })
      );
      expect(html).toContain('attach-menu-item');
      expect(html).toContain('prompt-options-menu-item');
      expect(html).toContain('is-armed');
      expect(html).not.toContain('prompt-options-pill');
      expect(html).toContain('prompt-options-menu-badge');
      expect(html).toContain('⚡');
      expect(html).toContain('plan');
      expect(html).toContain('prompt-options-unstage-btn');
    });

    it('mutates to popover item with error badge when error present', () => {
      const html = renderToStaticMarkup(
        React.createElement(PromptOptionsBadge, {
          descriptors: agyDescriptors,
          options: { jsonSchema: 'invalid' },
          count: 1,
          error: 'Invalid schema',
          asMenuItem: true,
          onOpenModal: () => {},
          onClear: () => {},
        })
      );
      expect(html).toContain('attach-menu-item');
      expect(html).toContain('prompt-options-menu-item');
      expect(html).toContain('is-error');
      expect(html).not.toContain('prompt-options-pill');
      expect(html).toContain('prompt-options-menu-badge-error');
      expect(html).toContain('⚠️');
      expect(html).toContain('prompt-options-unstage-btn');
    });

    it('still renders as a button pill when outside more button (asMenuItem is false/omitted)', () => {
      const html = renderToStaticMarkup(
        React.createElement(PromptOptionsBadge, {
          descriptors: agyDescriptors,
          options: {},
          count: 0,
          asMenuItem: false,
          onOpenModal: () => {},
          onClear: () => {},
        })
      );
      expect(html).toContain('prompt-options-pill');
      expect(html).not.toContain('attach-menu-item');
      expect(html).toContain('🎛');
    });
  });
});
