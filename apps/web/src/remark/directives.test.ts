import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import { remarkDirectives } from './directives.js';

// ponytail: minimal hast → html (no rehype-stringify dep); text is not escaped.
type H = { type: string; value?: string; tagName?: string; properties?: { className?: string[] | string }; children?: H[] };
const toHtml = (n: H): string =>
  n.type === 'text' ? n.value ?? ''
    : n.type === 'element'
      ? `<${n.tagName}${n.properties?.className ? ` class="${[n.properties.className].flat().join(' ')}"` : ''}>${(n.children ?? []).map(toHtml).join('')}</${n.tagName}>`
      : (n.children ?? []).map(toHtml).join('');
const proc = unified().use(remarkParse).use(remarkDirective).use(remarkDirectives).use(remarkRehype);
const html = (md: string) => toHtml(proc.runSync(proc.parse(md), md) as H);

describe('remarkDirectives', () => {
  it('renders ::: callouts as GitHub alerts, label as title', () => {
    expect(html(':::danger\nCareful.\n:::')).toBe('<blockquote class="markdown-alert markdown-alert-caution"><p class="markdown-alert-title">Danger</p><p>Careful.</p></blockquote>');
    expect(html(':::tip[Pro move]{.purple}\nX\n:::')).toBe('<blockquote class="markdown-alert markdown-alert-tip"><p class="markdown-alert-title">Pro move</p><p>X</p></blockquote>');
  });

  it('renders known inline directives with whitelisted tokens only', () => {
    expect(html(':color[done]{.ok}')).toContain('<span class="md-color md-color-ok">done</span>');
    expect(html(':mark[hot]{.warn}')).toContain('<mark class="md-mark md-mark-warn">hot</mark>');
    expect(html(':kbd[Ctrl+S]')).toContain('<kbd class="md-kbd">Ctrl+S</kbd>');
    expect(html(':badge[v2]{.info}')).toContain('<span class="md-badge md-badge-info">v2</span>');
    expect(html(':color[x]{.hotpink style="color:red" #id}')).toContain('<span class="md-color">x</span>');
  });

  it('restores colon-heavy prose verbatim', () => {
    for (const s of ['cfg:color[red] x', 'note:kbd[x] y', 'host localhost:abc ok', 'see foo:bar[0] here', 'Error:thing{x=1} end', 'a::b']) {
      expect(html(s)).toContain(s);
    }
    expect(html('::foo[bar]')).toContain('::foo[bar]');
    expect(html(':::weird\nbody\n:::')).toContain(':::weird');
  });
});
