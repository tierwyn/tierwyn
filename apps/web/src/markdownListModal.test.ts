import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownListModal } from './components/MarkdownListModal.js';

describe('MarkdownListModal markup', () => {
  it('renders a search field, esc hint, and listed filenames', () => {
    const html = renderToStaticMarkup(createElement(MarkdownListModal, {
      paths: [
        '/internal/docs/plans/fw-69-screen-lock.md',
        '/home/user/Projects/Tierwyn/README.md',
      ],
      onSelect: () => {},
      onClose: () => {},
    }));

    expect(html).toContain('aria-label="Filter markdown files"');
    expect(html).toContain('Filter by name or contents');
    expect(html).toContain('fw-69-screen-lock.md');
    expect(html).toContain('README.md');
    expect(html).toContain('esc');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('is-active');
  });
});
