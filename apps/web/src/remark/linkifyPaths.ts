import type { Plugin } from 'unified';
import type { Root, Text, Link, InlineCode, Parent } from 'mdast';
import { visitParents, SKIP } from 'unist-util-visit-parents';
import {
  OPENABLE_PATH_RE,
  OPENABLE_RELATIVE_RE,
  OPENABLE_FILE_URI_RE,
  OPENABLE_BARE_RELATIVE_RE,
  OPENABLE_BARE_FILENAME_RE,
  findOpenablePaths,
  isPlausibleFsAbsolute,
  toProjectRelativePath,
} from '@tierwyn/shared';

/** Strip an optional trailing `:line` or `:line:col` suffix (agent citations). */
function stripLineSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, '');
}

/**
 * Rewrite a matched path into the href we fetch. Web-root absolutes
 * (`/docs/plan.md`) become project-relative targets — GET /files resolves
 * those against the conversation's workdir / project root — while system
 * roots (`/etc/...`) return null and are never linkified.
 */
function normalizeLinkTarget(path: string): string | null {
  if (path.startsWith('/') && !isPlausibleFsAbsolute(path)) {
    return toProjectRelativePath(path);
  }
  return path;
}

/**
 * Test whether `value` is exactly one openable path (no surrounding prose).
 * Used to decide whether a backtick-wrapped `inlineCode` node should become
 * a link — we only convert when the entire span is a path, never substrings
 * inside other tokens. An optional trailing `:line` / `:line:col` is accepted;
 * matching uses the stripped path.
 */
function isEntirelyOpenablePath(value: string): boolean {
  if (!value) return false;
  const stripped = stripLineSuffix(value);
  for (const re of [
    OPENABLE_PATH_RE,
    OPENABLE_RELATIVE_RE,
    OPENABLE_FILE_URI_RE,
    OPENABLE_BARE_RELATIVE_RE,
    OPENABLE_BARE_FILENAME_RE,
  ]) {
    re.lastIndex = 0;
    const m = re.exec(stripped);
    if (m && m[1] === stripped && normalizeLinkTarget(stripped)) return true;
  }
  return false;
}

const linkNode = (path: string, label?: string): Link => ({
  type: 'link',
  url: path,
  data: { hName: 'a', hProperties: { 'data-tierwyn-file': 'true' } },
  children: [{ type: 'text', value: label ?? path }],
});

/**
 * Remark plugin that turns absolute or ./~/~ relative paths to openable files
 * (images + markdown) inside prose into actual markdown links. The link URL
 * is the raw path; the web client turns it into a fetch against GET /files and
 * pops the FileModal instead of navigating.
 *
 * Two node kinds are handled:
 *  - `text`: substrings inside a longer text run get split into Text/Link.
 *  - `inlineCode`: backtick-wrapped spans whose entire value is an openable
 *    path get replaced wholesale. Agents very commonly write
 *    "saved to `/tmp/foo.png`" — without this branch the path stays inert.
 *
 * Paths inside `code` (fenced blocks) and `link` (already-linked) nodes are
 * deliberately left alone.
 */
export const linkifyPaths: Plugin<[], Root> = () => {
  return (tree) => {
    visitParents(tree, 'text', (node: Text, ancestors) => {
      // Skip if any ancestor is a link (don't nest links) — `code`
      // and `inlineCode` are leaf nodes with `value`, not `text` children,
      // so they never reach this visitor at all.
      if (ancestors.some((a) => a.type === 'link')) return SKIP;

      const parent = ancestors[ancestors.length - 1] as Parent | undefined;
      if (!parent || !Array.isArray(parent.children)) return;
      const index = (parent.children as unknown[]).indexOf(node);
      if (index === -1) return;

      const value = node.value;
      if (!value || !/[/.]/.test(value)) return;

      const unique = findOpenablePaths(value);
      if (unique.length === 0) return;

      // Build replacement siblings: alternating Text and Link nodes.
      const replacement: (Text | Link)[] = [];
      let cursor = 0;
      for (const m of unique) {
        if (m.start > cursor) {
          replacement.push({ type: 'text', value: value.slice(cursor, m.start) });
        }
        // Label keeps the ORIGINAL span text (e.g. `/docs/plan.md`) while the
        // href is the normalized project-relative target.
        replacement.push(linkNode(m.path, value.slice(m.start, m.end)));
        cursor = m.end;
      }
      if (cursor < value.length) {
        replacement.push({ type: 'text', value: value.slice(cursor) });
      }

      parent.children.splice(index, 1, ...replacement);
      // Tell visit we've already replaced this slot; index+1 is next.
      return [SKIP, index + 1] as const;
    });

    // Backtick-wrapped paths: visit inlineCode nodes and replace any whose
    // entire value is an openable path. Substring matches inside inlineCode
    // are intentionally not linkified — agents quote fragments like `foo.png`
    // all the time and turning those into links would be noisy.
    visitParents(tree, 'inlineCode', (node: InlineCode, ancestors) => {
      // Skip if any ancestor is a link (don't nest links)
      if (ancestors.some((a) => a.type === 'link')) return SKIP;

      const parent = ancestors[ancestors.length - 1] as Parent | undefined;
      if (!parent || !Array.isArray(parent.children)) return;
      const index = (parent.children as unknown[]).indexOf(node);
      if (index === -1) return;

      if (!isEntirelyOpenablePath(node.value)) return;
      const target = normalizeLinkTarget(stripLineSuffix(node.value));
      if (!target) return;
      // Href is the normalized path (line suffix and web-root slash stripped);
      // visible label keeps the full original span.
      parent.children.splice(index, 1, linkNode(target, node.value));
      return [SKIP, index + 1] as const;
    });
  };
};
