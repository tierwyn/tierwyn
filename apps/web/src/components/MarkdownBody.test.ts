import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody } from './MarkdownBody.js';

describe('MarkdownBody list rendering', () => {
  it('renders numbered lists with bold headings without leading whitespace in li', () => {
    const text = `I have four bugs to fix:

1. **Shift+Tab in a focused terminal steals focus.** When a terminal has focus and I press Shift+Tab.

2. **Split separator is off-center.** The separator between two groups doesn't appear in the middle.`;

    const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, text));
    // <li> must directly contain the <p> without a leading newline text node breaking the list marker
    expect(html).toContain('<li><p><strong>Shift+Tab in a focused terminal steals focus.</strong>');
    expect(html).toContain('<li><p><strong>Split separator is off-center.</strong>');
  });

  it('renders tight lists cleanly', () => {
    const text = `1. First item
2. Second item`;

    const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, text));
    expect(html).toContain('<li>First item</li>');
    expect(html).toContain('<li>Second item</li>');
  });

  it('renders soft breaks inside paragraphs', () => {
    const text = `Line 1
Line 2`;

    const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, text));
    expect(html).toContain('<p>Line 1\nLine 2</p>');
  });

  it('renders nested lists without whitespace-only text nodes between li elements', () => {
    const text = `* Outer item:
  * Sub-item 1
  * Sub-item 2
* Second outer item`;

    const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, text));
    // Nested ul should not have newline text nodes between <li> elements
    expect(html).toContain('<ul><li>Sub-item 1</li><li>Sub-item 2</li></ul>');
    // Outer li should not have trailing newline text node after nested ul
    expect(html).toContain('Outer item:<ul><li>Sub-item 1</li><li>Sub-item 2</li></ul></li>');
  });

  it('renders fenced code blocks inside list items without spurious newlines', () => {
    const text = `* Step 1:
  \`\`\`bash
  npm test
  \`\`\``;

    const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, text));
    expect(html).toContain('<li>Step 1:<div class="code-block">');
  });
});
