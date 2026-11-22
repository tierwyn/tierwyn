import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavePromptModal } from './SavePromptModal.js';

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

describe('SavePromptModal', () => {
  it('renders modal with save-prompt-modal class and proper modal-field structure', () => {
    const html = renderToStaticMarkup(
      React.createElement(SavePromptModal, {
        initialBody: 'Test prompt body',
        onClose: () => {},
      })
    );

    expect(html).toContain('Save to Prompt Collection');
    expect(html).toContain('prompt-collection-modal save-prompt-modal');
    expect(html).toContain('prompt-collection-form');

    // All form labels should have the modal-field class for flex-column layout
    const modalFieldCount = (html.match(/class="modal-field"/g) || []).length;
    expect(modalFieldCount).toBe(3);

    // Textarea should have modal-input and prompt-collection-textarea classes for theme consistency
    expect(html).toContain('class="modal-input prompt-collection-textarea"');
    expect(html).toContain('Test prompt body');

    // Name and Description inputs should have modal-input class
    expect(html).toContain('placeholder="e.g. Code Review Checklist"');
    expect(html).toContain('placeholder="e.g. Detailed correctness and security checklist for code changes"');

    // Modal footer with buttons
    expect(html).toContain('Cancel');
    expect(html).toContain('Save to Collection');
  });
});
