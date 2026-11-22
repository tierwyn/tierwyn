import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoleMatchKeywordsEditor } from './RoleMatchKeywordsEditor.js';
import { DEFAULT_ROLE_MATCH_KEYWORDS } from '@tierwyn/shared';

describe('RoleMatchKeywordsEditor', () => {
  it('renders built-in stages and their keywords without Remove stage buttons', () => {
    const html = renderToStaticMarkup(
      <RoleMatchKeywordsEditor value={DEFAULT_ROLE_MATCH_KEYWORDS} onChange={() => {}} />
    );

    expect(html).toContain('plan');
    expect(html).toContain('implement');
    expect(html).toContain('review');
    expect(html).toContain('built-in');
    expect(html).not.toContain('Remove stage');
  });

  it('renders custom stages with a Remove stage button', () => {
    const value = {
      ...DEFAULT_ROLE_MATCH_KEYWORDS,
      translate: ['translate', 'translator'],
    };
    const html = renderToStaticMarkup(
      <RoleMatchKeywordsEditor value={value} onChange={() => {}} />
    );

    expect(html).toContain('translate');
    expect(html).toContain('translator');
    expect(html).toContain('Remove stage');
    expect(html).toContain('aria-label="Remove stage translate"');
  });

  it('renders keyword input with placeholder and Add stage controls', () => {
    const html = renderToStaticMarkup(
      <RoleMatchKeywordsEditor value={DEFAULT_ROLE_MATCH_KEYWORDS} onChange={() => {}} />
    );

    expect(html).toContain('placeholder="+ Add keyword"');
    expect(html).toContain('placeholder="New stage (e.g. test)"');
    expect(html).toContain('Add stage');
    expect(html).toContain('Reset to defaults');
  });
});
