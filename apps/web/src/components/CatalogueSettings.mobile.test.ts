import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const tsx = readFileSync(new URL('./CatalogueSettings.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8');
const inputBar = readFileSync(new URL('./InputBar.tsx', import.meta.url), 'utf8');

const PHONE_MQ = '(max-width: 600px), (max-height: 500px) and (orientation: landscape)';

function mediaBlockAfter480CatalogueRule(): string {
  const marker = '.catalogue-agent-option-version { display: none; }';
  const markerAt = css.indexOf(marker);
  expect(markerAt).toBeGreaterThan(-1);
  const after = css.slice(markerAt + marker.length);
  const mediaAt = after.search(/@media\s*\(/);
  expect(mediaAt).toBeGreaterThan(-1);
  const from = markerAt + marker.length + mediaAt;
  const rest = css.slice(from + 1);
  const nextMedia = rest.search(/@media\s*\(/);
  return css.slice(from, nextMedia === -1 ? undefined : from + 1 + nextMedia);
}

describe('CatalogueSettings mobile Option B', () => {
  it('uses the same phone media query as InputBar', () => {
    expect(tsx).toContain(`const PHONE_MQ = '${PHONE_MQ}'`);
    expect(inputBar).toContain(`window.matchMedia('${PHONE_MQ}')`);
  });

  it('defines useIsPhone and calls it from CatalogueSettings', () => {
    expect(tsx).toMatch(/function useIsPhone\(\):\s*boolean/);
    expect(tsx).toMatch(/const isPhone = useIsPhone\(\)/);
  });

  it('renders a compact phone agent list when selectedId is ALL', () => {
    expect(tsx).toContain('catalogue-phone-agent-row');
    expect(tsx).toContain('catalogue-phone-agent-open');
    expect(tsx).toMatch(/e\.stopPropagation\(\)/);
    expect(tsx).toMatch(/\$\{enabledCount\}\/\$\{agentModels\.length\} models/);
    expect(tsx).toContain('not installed');
    expect(tsx).toMatch(/setSelectedId\(a\.id\)/);
  });

  it('renders a sticky ‹ Agents back bar when one agent is open on phone', () => {
    expect(tsx).toContain('catalogue-phone-back');
    expect(tsx).toContain('‹ Agents');
    expect(tsx).toMatch(/setSelectedId\(ALL\)/);
    expect(tsx).toMatch(/scrollIntoView\(\{\s*block:\s*'start'\s*\}\)/);
  });

  it('collapses versions and bulk fields into a Tools details on phone', () => {
    expect(tsx).toContain('catalogue-phone-tools');
    expect(tsx).toContain('Tools · versions, bulk edit');
    expect(tsx).toMatch(/const searchRow/);
  });

  it('adds a model-row accordion with expand control and is-expanded', () => {
    expect(tsx).toMatch(/useState<string \| null>\(null\)/);
    expect(tsx).toContain('expandedModelId');
    expect(tsx).toContain('catalogue-model-expand');
    expect(tsx).toContain('is-expanded');
    expect(tsx).toContain('aria-label="Model details"');
  });

  it('confirms before deleting a model or a user command', () => {
    expect(tsx).toMatch(/window\.confirm\(`Delete model "\$\{m\.label\}"\?`\)/);
    expect(tsx).toMatch(/window\.confirm\(`Delete command "\/\$\{c\.name\}"\?`\)/);
  });

  it('places a catalogue phone media block after the 480px version rule', () => {
    const block = mediaBlockAfter480CatalogueRule();
    expect(block).toContain(PHONE_MQ);
    expect(block).toMatch(/\.catalogue-agent-selector[\s\S]{0,80}display:\s*none/);
    expect(block).toContain('.catalogue-phone-agent-row');
    expect(block).toContain('.catalogue-phone-back');
    expect(block).toContain('.catalogue-phone-tools');
    expect(block).toContain('.catalogue-model-expand');
    expect(block).toMatch(/font-size:\s*16px/);
    expect(block).toMatch(/min-height:\s*44px/);
  });

  it('hides the expand chevron on desktop and unifies bulk-row type to 12px', () => {
    expect(css).toMatch(/\.catalogue-model-expand\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(
      /\.catalogue-global-bulk\s+\.catalogue-model-spawn-input[\s\S]{0,120}font-size:\s*12px/,
    );
    expect(css).toMatch(
      /\.catalogue-global-bulk[\s\S]{0,80}\.catalogue-bulk-tristate[\s\S]{0,80}\.ms-trigger[\s\S]{0,120}font-size:\s*12px/,
    );
  });

  it('moves model-item inline styles into classes', () => {
    expect(tsx).toContain('catalogue-model-toggle');
    expect(tsx).toContain('catalogue-model-name-input');
    expect(css).toContain('.catalogue-model-item');
    expect(css).toContain('.catalogue-model-toggle');
    expect(css).toContain('.catalogue-model-name-input');
    expect(css).toContain('.catalogue-model-subrow');
    expect(tsx).not.toMatch(/style=\{\{\s*marginBottom:\s*'8px'/);
    expect(tsx).not.toMatch(/fontSize:\s*'10px'/);
  });
});

describe('CatalogueSettings agent picker model counts', () => {
  it('shows enabled/total models in the dropdown meta, not total-only', () => {
    expect(tsx).toMatch(/function optionMeta\(status: HealthStatus, enabledCount: number, totalModels: number\)/);
    expect(tsx).toMatch(/\$\{enabledCount\}\/\$\{totalModels\} model\$\{totalModels === 1 \? '' : 's'\}/);
    expect(tsx).toMatch(/meta:\s*optionMeta\(status,\s*enabledCount,\s*count\)/);
    expect(tsx).not.toMatch(/function optionMeta\(status: HealthStatus, totalModels: number\)/);
  });

  it('shows enabled/total on the agent card status badge', () => {
    expect(tsx).toMatch(/function statusLabel\(status: HealthStatus, enabledCount: number, totalModels: number\)/);
    expect(tsx).toMatch(/statusLabel\(status,\s*enabledCount,\s*agentModels\.length\)/);
  });
});

describe('CatalogueSettings hub-local login', () => {
  it('renders Log in for installed login-capable agents that report loggedIn:false', () => {
    expect(tsx).toContain('a.installed && isRemoteLoginAgent(a.type) && a.loggedIn === false && !a.login?.running');
    expect(tsx).toContain('onClick={() => startLogin(a.type)}');
  });
});
