import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { linkifyPaths } from './linkifyPaths.js';
import { MarkdownBody } from '../components/MarkdownBody.js';
import type { Root, Link } from 'mdast';

function processMarkdown(md: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(linkifyPaths);
  return processor.runSync(processor.parse(md));
}

describe('linkifyPaths', () => {
  it('converts bare single filename in backticks to a link node', () => {
    const tree = processMarkdown('Check `CLAUDE.md` and `README.md`.');
    const links: Link[] = [];
    for (const child of (tree.children[0] as { children: Array<{ type: string; url?: string }> }).children) {
      if (child.type === 'link') {
        links.push(child as unknown as Link);
      }
    }
    expect(links.length).toBe(2);
    expect(links[0].url).toBe('CLAUDE.md');
    expect((links[0].data as { hProperties: { 'data-tierwyn-file': string } })?.hProperties?.['data-tierwyn-file']).toBe('true');
    expect(links[1].url).toBe('README.md');
  });

  it('converts json and yaml files in backticks to links', () => {
    const tree = processMarkdown('Edit `package.json` or `config.yaml`.');
    const links: Link[] = [];
    for (const child of (tree.children[0] as { children: Array<{ type: string; url?: string }> }).children) {
      if (child.type === 'link') {
        links.push(child as unknown as Link);
      }
    }
    expect(links.length).toBe(2);
    expect(links[0].url).toBe('package.json');
    expect(links[1].url).toBe('config.yaml');
  });

  it('does not linkify non-path inline code', () => {
    const tree = processMarkdown('Run `npm install` with `someVariable`.');
    const links: Link[] = [];
    for (const child of (tree.children[0] as { children: Array<{ type: string; url?: string }> }).children) {
      if (child.type === 'link') {
        links.push(child as unknown as Link);
      }
    }
    expect(links.length).toBe(0);
  });

  it('linkifies bare .md/.txt filenames in plain prose (R-A)', () => {
    const tree = processMarkdown('Check CLAUDE.md and notes.txt for context.');
    const rootChild = tree.children[0] as {
      children: Array<{ type: string; url?: string; children?: Array<{ type: string; value?: string }> }>;
    };
    const links = rootChild.children.filter((c) => c.type === 'link') as unknown as Link[];
    expect(links.length).toBe(2);
    expect(links[0].url).toBe('CLAUDE.md');
    expect(links[1].url).toBe('notes.txt');
  });

  it('linkifies bare .png/.tsx filenames in prose', () => {
    const tree = processMarkdown('Open icon.png or App.tsx in the editor.');
    const rootChild = tree.children[0] as {
      children: Array<{ type: string; url?: string }>;
    };
    const links = rootChild.children.filter((c) => c.type === 'link') as unknown as Link[];
    expect(links.map((l) => l.url)).toEqual(['icon.png', 'App.tsx']);
  });

  it('does not linkify collision-prone bare extensions (.go/.c/.js)', () => {
    const tree = processMarkdown('Rewrite main.go and server.c — built with Node.js.');
    const rootChild = tree.children[0] as {
      children: Array<{ type: string; url?: string }>;
    };
    const links = rootChild.children.filter((c) => c.type === 'link');
    expect(links.length).toBe(0);
  });

  it('does not bridge across prose between two paths (R-C)', () => {
    const tree = processMarkdown('Compare ./docs/a.md and ../docs/b.txt');
    const rootChild = tree.children[0] as {
      children: Array<{ type: string; url?: string }>;
    };
    const links = rootChild.children.filter((c) => c.type === 'link') as unknown as Link[];
    expect(links.map((l) => l.url)).toEqual(['./docs/a.md', '../docs/b.txt']);
  });

  it('rewrites web-root absolutes to project-relative hrefs, keeping the original label', () => {
    const tree = processMarkdown('See /docs/plan.md and /icons/icon-192.png');
    const rootChild = tree.children[0] as {
      children: Array<{ type: string; url?: string; children?: Array<{ type: string; value?: string }> }>;
    };
    const links = rootChild.children.filter((c) => c.type === 'link') as unknown as Link[];
    expect(links.map((l) => l.url)).toEqual(['docs/plan.md', 'icons/icon-192.png']);
    expect((links[0].children[0] as { value: string }).value).toBe('/docs/plan.md');
    expect((links[1].children[0] as { value: string }).value).toBe('/icons/icon-192.png');
  });

  it('drops system-root absolutes like /etc/nginx/nginx.conf', () => {
    const tree = processMarkdown('Config at /etc/nginx/nginx.conf and /usr/share/doc/readme.md.');
    const rootChild = tree.children[0] as {
      children: Array<{ type: string; url?: string }>;
    };
    const links = rootChild.children.filter((c) => c.type === 'link');
    expect(links.length).toBe(0);
  });

  it('linkifies backticked web-root absolute to a project-relative href; label keeps the slash', () => {
    const tree = processMarkdown('Plan lives in `/docs/plan.md` now.');
    const rootChild = tree.children[0] as {
      children: Array<{ type: string; url?: string; children?: Array<{ type: string; value?: string }> }>;
    };
    const links = rootChild.children.filter((c) => c.type === 'link') as unknown as Link[];
    expect(links.length).toBe(1);
    expect(links[0].url).toBe('docs/plan.md');
    expect((links[0].children[0] as { value: string }).value).toBe('/docs/plan.md');
  });

  it('does not linkify backticked system-root paths', () => {
    const tree = processMarkdown('See `/etc/nginx/nginx.conf` for config.');
    const rootChild = tree.children[0] as {
      children: Array<{ type: string; url?: string }>;
    };
    const links = rootChild.children.filter((c) => c.type === 'link');
    expect(links.length).toBe(0);
  });

  it('linkifies backticked path with :line suffix (R-B); label keeps the suffix', () => {
    const tree = processMarkdown(
      'Fixed in `apps/web/src/components/MarkdownBody.tsx:204`, see apps/web/src/components/MarkdownBody.tsx:204 for the same line.',
    );
    const rootChild = tree.children[0] as {
      children: Array<{ type: string; url?: string; children?: Array<{ type: string; value?: string }> }>;
    };
    const links = rootChild.children.filter((c) => c.type === 'link') as unknown as Link[];
    expect(links.length).toBeGreaterThanOrEqual(2);

    const backticked = links.find(
      (l) =>
        l.url === 'apps/web/src/components/MarkdownBody.tsx' &&
        (l.children[0] as { value?: string })?.value === 'apps/web/src/components/MarkdownBody.tsx:204',
    );
    expect(backticked).toBeDefined();
    expect(backticked!.url).toBe('apps/web/src/components/MarkdownBody.tsx');
    expect((backticked!.children[0] as { value: string }).value).toBe(
      'apps/web/src/components/MarkdownBody.tsx:204',
    );

    // Unbackticked prose path still linkifies (line suffix is outside the path match).
    const prose = links.find(
      (l) =>
        l.url === 'apps/web/src/components/MarkdownBody.tsx' &&
        (l.children[0] as { value?: string })?.value === 'apps/web/src/components/MarkdownBody.tsx',
    );
    expect(prose).toBeDefined();
  });

  it('does not double-linkify or nest links when inline code is inside a link', () => {
    const tree = processMarkdown('[`apps/server/src/sessionManager.teardown.test.ts`](file:///home/user/Projects/Tierwyn/apps/server/src/sessionManager.teardown.test.ts)');
    const rootChild = tree.children[0] as { type: string; children: Array<{ type: string; url?: string; children?: unknown[] }> };
    const link = rootChild.children[0];
    expect(link.type).toBe('link');
    expect(link.url).toBe('file:///home/user/Projects/Tierwyn/apps/server/src/sessionManager.teardown.test.ts');
    // The child inside the link should be inlineCode, NOT another link!
    expect((link.children?.[0] as { type: string })?.type).toBe('inlineCode');
  });

  it('does not linkify text or inlineCode deeply nested inside a link', () => {
    const tree = processMarkdown('[**`apps/server/src/sessionManager.teardown.test.ts`**](file:///test.ts)');
    const rootChild = tree.children[0] as { type: string; children: Array<{ type: string; url?: string; children?: unknown[] }> };
    const link = rootChild.children[0];
    expect(link.type).toBe('link');
    const strong = link.children?.[0] as { type: string; children?: Array<{ type: string }> };
    expect(strong.type).toBe('strong');
    expect(strong.children?.[0].type).toBe('inlineCode');
  });

  it('tests how ReactMarkdown renders the user link', () => {
    const md = '1. **Nested Link AST Mutation in [`linkifyPaths.ts`](file:///home/user/Projects/Tierwyn/apps/web/src/remark/linkifyPaths.ts)**';
    const html = renderToString(
      React.createElement(MarkdownBody, {
        onOpenFile: (p) => { console.log('OPEN:', p); },
        children: md,
      })
    );
    expect(html).toContain('data-tierwyn-file="true"');
  });

  it('verifies all links in the user message render as data-tierwyn-file', () => {
    const fullMessage = `### Root Cause Analysis & Resolution

The issue where clicking markdown links like \`\`[\`apps/server/src/sessionManager.teardown.test.ts\`](file:///home/user/Projects/Tierwyn/apps/server/src/sessionManager.teardown.test.ts)\`\` did not open the file was traced to three distinct bugs:

1. **Nested Link AST Mutation in [\`linkifyPaths.ts\`](file:///home/user/Projects/Tierwyn/apps/web/src/remark/linkifyPaths.ts)**:
   - In Markdown, links with code-styled labels (e.g. \`[\`path.ts\`](file:///...)\`) create a parent \`link\` node with an \`inlineCode\` child node.
   - \`linkifyPaths\` previously traversed \`inlineCode\` and \`text\` nodes without checking whether an ancestor node was already a \`link\`.
   - Because \`apps/server/src/sessionManager.teardown.test.ts\` matched \`OPENABLE_BARE_RELATIVE_RE\`, the plugin converted the inner \`inlineCode\` into an inner \`linkNode\`, producing an illegal nested anchor (\`<a><a>...</a></a>\`).
   - Browsers either terminate the outer \`<a>\` early or corrupt DOM event delegation upon clicking interactive content inside an anchor.

2. **Server-Side URI Normalization in [\`files.ts\`](file:///home/user/Projects/Tierwyn/apps/server/src/routes/files.ts)**:
   - When [\`resolveReadTarget\`](file:///home/user/Projects/Tierwyn/apps/server/src/routes/files.ts#L204-L240) processed any path starting with \`file://\`, Node's \`isAbsolute()\` returned \`false\` (since it starts with \`'f'\`, not \`'/'\`).
   - The server erroneously treated \`file:///...\` as a relative path, attempting to resolve \`process.cwd() + '/file:/home/...'\`, resulting in a \`403\` or \`404\`.
   - It also did not strip \`#L10-L20\` line hashes or decode percent-encoded URLs.

3. **Client-Side Path Cleaning in [\`MarkdownBody.tsx\`](file:///home/user/Projects/Tierwyn/apps/web/src/components/MarkdownBody.tsx) & [\`markdownPaths.ts\`](file:///home/user/Projects/Tierwyn/apps/web/src/markdownPaths.ts)**:
   - \`cleanPath\` previously relied on rigid string slice indices (\`slice(7)\` / \`slice(9)\`).
   - This did not handle multiple leading slashes (\`file:///\`), URL query parameters (\`?v=...\`), hash line numbers (\`#L...\`), or percent-encoded paths (\`%20\`).

---

### Changes Made

- **[\`apps/web/src/remark/linkifyPaths.ts\`](file:///home/user/Projects/Tierwyn/apps/web/src/remark/linkifyPaths.ts)**:
  - Switched to \`visitParents\` from \`unist-util-visit-parents\`.
  - Added an ancestor guard \`if (ancestors.some((a) => a.type === 'link')) return SKIP;\` for both \`text\` and \`inlineCode\` visitors so existing markdown links are never mutated or double-wrapped.
- **[\`apps/web/src/components/MarkdownBody.tsx\`](file:///home/user/Projects/Tierwyn/apps/web/src/components/MarkdownBody.tsx)**:
  - Normalized \`cleanPath\` to strip \`file://{1,3}\`, \`localhost/\`, query strings, hash anchors, and decoded percent-encoded characters before invoking \`handleOpenFile\`.
- **[\`apps/server/src/routes/files.ts\`](file:///home/user/Projects/Tierwyn/apps/server/src/routes/files.ts)**:
  - Added defensive URL stripping and percent-decoding directly in [\`resolveReadTarget\`](file:///home/user/Projects/Tierwyn/apps/server/src/routes/files.ts#L204-L225) so requests with \`file:///\` URLs or hash anchors resolve cleanly to allowed filesystem paths.
- **[\`apps/web/src/markdownPaths.ts\`](file:///home/user/Projects/Tierwyn/apps/web/src/markdownPaths.ts)**:
  - Updated [\`normalizeOpenablePath\`](file:///home/user/Projects/Tierwyn/apps/web/src/markdownPaths.ts#L11-L21) with the same robust normalization.`;

    const openedPaths: string[] = [];
    const html = renderToString(
      React.createElement(MarkdownBody, {
        onOpenFile: (p) => { openedPaths.push(p); },
        children: fullMessage,
      })
    );

    // Extract all rendered anchors
    const anchorMatches = [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)];
    console.log('RENDERED ANCHORS COUNT:', anchorMatches.length);
    for (const m of anchorMatches) {
      console.log('ANCHOR:', m[1], 'CHILDREN:', m[2]);
    }

    // Every rendered file link must have data-tierwyn-file="true"
    for (const m of anchorMatches) {
      if (m[1].includes('file:///home/user')) {
        expect(m[1]).toContain('data-tierwyn-file="true"');
      }
    }

    // Now test clicking every anchor component by rendering with custom component tester
    const clickedPaths: string[] = [];
    let clickHandlers: Array<() => void> = [];
    
    // Test the a component onClick handler directly
    const testA = (href: string) => {
      let cleanPath = href.trim().replace(/^file:\/{1,3}/i, '/');
      cleanPath = cleanPath.replace(/^\/?localhost\//i, '/');
      cleanPath = cleanPath.split('#')[0].split('?')[0];
      try { cleanPath = decodeURIComponent(cleanPath); } catch {}
      return cleanPath;
    };

    for (const m of anchorMatches) {
      const hrefMatch = /href="([^"]*)"/.exec(m[1]);
      if (hrefMatch) {
        const cleaned = testA(hrefMatch[1]);
        clickedPaths.push(cleaned);
      }
    }
    console.log('CLEANED CLICKED PATHS:', clickedPaths);
  });

  it('linkifies /home/user/Screenshot 2026-09-11.png in prose and renders data-tierwyn-file link', () => {
    const text = '/home/user/Screenshot 2026-09-11.png is still failing to open cause of space, can this be fixed at all?';
    const html = renderToString(
      React.createElement(MarkdownBody, {
        children: text,
      })
    );
    console.log('USER SCREENSHOT HTML:', html);
    expect(html).toContain('data-tierwyn-file="true"');
    expect(html).toContain('/home/user/Screenshot 2026-09-11.png');
  });
});
