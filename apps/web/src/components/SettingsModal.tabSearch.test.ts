import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('SettingsModal tab search and mobile centering', () => {
  const modalSrc = src('./SettingsModal.tsx');
  const css = src('../styles/index.css');

  it('renders a search input for settings tabs on desktop', () => {
    expect(modalSrc).toContain('className="settings-tabs-search"');
    expect(modalSrc).toContain('className="settings-tabs-search-input"');
    expect(modalSrc).toContain('placeholder="Search settings…"');
  });

  it('filters desktop tabs based on search query', () => {
    expect(modalSrc).toMatch(/filteredTabs[\s\S]*?tabSearch/);
    expect(modalSrc).toContain('No settings match');
  });

  it('enables searchable prop on the mobile settings tab picker', () => {
    expect(modalSrc).toMatch(/<div className="settings-tab-picker">[\s\S]*?<SelectDropdown[\s\S]*?searchable/);
  });

  it('centres the settings tab picker trigger label in CSS', () => {
    expect(css).toMatch(/\.settings-tab-picker \.model-selector \.ms-trigger\s*\{[\s\S]*?justify-content:\s*center/);
    expect(css).toMatch(/\.settings-tab-picker \.model-selector \.ms-trigger-label\s*\{[\s\S]*?text-align:\s*center/);
  });
});

describe('MemoriesModal mobile overlapping prevention', () => {
  const css = src('../styles/index.css');

  it('prevents overlapping by setting white-space nowrap on superseded checkbox label', () => {
    expect(css).toMatch(/\.mem-checkbox-label\s*\{[\s\S]*?white-space:\s*nowrap/);
  });

  it('stacks memory filters in a clean column on mobile viewports', () => {
    expect(css).toMatch(/@media \(max-width: 680px\)\s*\{[\s\S]*?\.mem-filters\s*\{[\s\S]*?flex-direction:\s*column/);
  });
});
