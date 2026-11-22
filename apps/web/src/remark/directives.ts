import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

/**
 * Inline directives (semantic tokens):
 *   :color[text]{.ok}  :mark[text]{.warn}  :kbd[Ctrl+S]  :badge[v2]{.info}
 * Tokens: ok | warn | error | info | muted. Anything else (style, id, hex) is dropped.
 * Agent prose is colon-heavy (`host:port`, `key:value[0]`), so every unknown
 * text/leaf directive is restored verbatim from the source. Container
 * callouts (`:::note|info|tip|important|warning|caution|danger`) render as
 * GitHub-style alerts; any other `:::name` is restored the same way.
 */
const TOKENS = new Set(['ok', 'warn', 'error', 'info', 'muted']);
const TAGS: Record<string, string> = { color: 'span', mark: 'mark', kbd: 'kbd', badge: 'span' };
/** `:::name` callouts → GitHub-alert kind. */
const CALLOUTS: Record<string, string> = { note: 'note', info: 'note', tip: 'tip', important: 'important', warning: 'warning', caution: 'caution', danger: 'caution' };

type DirNode = {
  type: string;
  name: string;
  attributes?: Record<string, string | null | undefined> | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

export const remarkDirectives: Plugin<[], Root> = () => (tree, file) => {
  const src = String(file);
  visit(tree, (node, index, parent) => {
    if (node.type !== 'textDirective' && node.type !== 'leafDirective' && node.type !== 'containerDirective') return;
    const d = node as unknown as DirNode;
    const name = d.name.toLowerCase();
    if (node.type === 'containerDirective' && name in CALLOUTS) {
      // Reuse the GitHub-alert markup/CSS. `:::tip[Custom title]` label wins; colour overrides ({.purple}) ignored.
      const kids = (node as unknown as { children: Array<{ data?: { directiveLabel?: boolean }; children?: unknown[] }> }).children;
      const label = kids[0]?.data?.directiveLabel ? kids.shift()!.children : undefined;
      kids.unshift({ type: 'paragraph', data: { hProperties: { className: 'markdown-alert-title' } }, children: label ?? [{ type: 'text', value: name[0]!.toUpperCase() + name.slice(1) }] } as never);
      d.data = { hName: 'blockquote', hProperties: { className: `markdown-alert markdown-alert-${CALLOUTS[name]}` } };
      return;
    }
    // `cfg:color[red]` is prose, not markup: a known tag glued to a word is restored too.
    const glued = /[\p{L}\p{N}_]/u.test(src[(d.position?.start.offset ?? 0) - 1] ?? '');
    if (node.type === 'containerDirective' || !(name in TAGS) || glued) {
      const s = d.position?.start.offset;
      const e = d.position?.end.offset;
      if (!parent || index === undefined || s === undefined || e === undefined) return;
      const value = src.slice(s, e);
      parent.children.splice(index, 1, (node.type === 'textDirective'
        ? { type: 'text', value }
        : { type: 'paragraph', children: [{ type: 'text', value }] }) as never);
      return [SKIP, index + 1];
    }
    const cls = String(d.attributes?.class ?? '').toLowerCase().split(/\s+/);
    const tint = name === 'kbd' ? undefined : cls.find((t) => TOKENS.has(t));
    d.data = { hName: TAGS[name], hProperties: { className: `md-${name}${tint ? ` md-${name}-${tint}` : ''}` } };
  });
};
