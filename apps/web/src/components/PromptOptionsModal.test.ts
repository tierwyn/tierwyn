import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromptOptionsModal } from './PromptOptionsModal.js';
import { promptOptionsFor } from '@tierwyn/shared';

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

describe('PromptOptionsModal', () => {
  const agyDescriptors = promptOptionsFor('antigravity');

  it('renders modal with pinned footer outside modal-body', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptOptionsModal, {
        agentLabel: 'Antigravity · Gemini 3.8 Flash (Medium)',
        agentType: 'antigravity',
        descriptors: agyDescriptors,
        stagedOptions: { mode: 'plan', sandbox: true },
        stagedSticky: false,
        onClose: () => {},
        onApply: () => {},
      })
    );

    expect(html).toContain('Antigravity · Gemini 3.8 Flash (Medium) Prompt Options');
    expect(html).toContain('prompt-options-modal');
    expect(html).toContain('modal-body');
    expect(html).toContain('prompt-options-footer');
    expect(html).toContain('Clear All');
    expect(html).toContain('Cancel');
    expect(html).toContain('Apply');
    expect(html).toContain('Next message only');
    expect(html).toContain('Sticky for this agent here');

    // Ensure prompt-options-footer is rendered after modal-body, not inside it
    const modalBodyEnd = html.indexOf('</div><div class="modal-footer prompt-options-footer">');
    expect(modalBodyEnd).toBeGreaterThan(-1);
  });
});
