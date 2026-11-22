import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody } from './components/MarkdownBody.js';

const TEMPLATE = `IMPLEMENT TICK for roster row FW-63 (Global search across all open terminal panes).

Repo: /home/user/Projects/DemoApp

Read in this order:
1. \`.tierwyn/schedule/feature-wave-2-prompt.md\` — IMPLEMENT TICK section (your full contract).
2. Row FW-63 in \`.tierwyn/schedule/feature-wave-2-roster.md\`. Status MUST be \`approved\`. If not, stop and complete-job this one-shot.

- Plan file: \`internal/docs/plans/fw-63-plan.md\`.
- Scope (do not expand): \`src/command-palette.ts\`, new \`src/pane-search.ts\` + tests, \`src/panes.ts\`.
- Every child ends with \`## Result\` listing all files touched + decisions, AND writes \`.tierwyn/delegates/<role>-<slug>-RESULT.md\`.`;

describe('schedule viewer template links', () => {
  it('renders backticked schedule paths as file anchors', () => {
    const html = renderToStaticMarkup(<MarkdownBody>{TEMPLATE}</MarkdownBody>);
    const anchors = Array.from(html.matchAll(/<a [^>]*>/g)).map((m) => m[0]);
    expect(anchors.some((a) => a.includes('href=".tierwyn/schedule/feature-wave-2-prompt.md"'))).toBe(true);
    expect(anchors.some((a) => a.includes('href=".tierwyn/schedule/feature-wave-2-roster.md"'))).toBe(true);
    expect(anchors.some((a) => a.includes('href="src/command-palette.ts"'))).toBe(true);
  });
});

const USER_MSG = `I still can't open this from user sent messages in this project why?
- \`/home/user/Projects/Tierwyn/internal/docs/superpowers/reviews/2026-09-11-deletable-profiles-and-sidecar-toggles-review.md\` — full review report (created)
- \`/home/user/Projects/Tierwyn/.tierwyn/delegates/claude-opus-5-reviewer-zero-profiles-and-toggles-RESULT.md\` — this summary (created)`;

describe('user-sent absolute path links', () => {
  it('renders dot-free absolute paths as file anchors; dot-dir absolutes are a known gap', () => {
    const html = renderToStaticMarkup(<MarkdownBody>{USER_MSG}</MarkdownBody>);
    const anchors = Array.from(html.matchAll(/<a [^>]*>/g)).map((m) => m[0]);
    expect(anchors.some((a) => a.includes('href="/home/user/Projects/Tierwyn/internal/docs/superpowers/reviews/2026-09-11-deletable-profiles-and-sidecar-toggles-review.md"'))).toBe(true);
    // KNOWN GAP (packages/shared/src/paths.ts): OPENABLE_PATH_RE forbids dots
    // in intermediate directory segments, so an absolute path through a
    // dot-directory (.tierwyn/) never linkifies — bare-relative .tierwyn/...
    // paths do (OPENABLE_BARE_RELATIVE_RE). Flip this to toBe(true) when the
    // regex learns dot-directories.
    expect(anchors.some((a) => a.includes('href="/home/user/Projects/Tierwyn/.tierwyn/delegates/claude-opus-5-reviewer-zero-profiles-and-toggles-RESULT.md"'))).toBe(false);
  });
});
