import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('mobile topbar overflow: git + file browser', () => {
  const app = src('./App.tsx');
  const css = src('./styles/index.css');

  it('git working tree button className contains topbar-git', () => {
    expect(app).toMatch(/className=\{`theme-toggle topbar-git\$\{gitPanel \? ' active' : ''\}`\}/);
  });

  it('file browser button className contains topbar-filebrowser', () => {
    expect(app).toMatch(/className=\{`theme-toggle topbar-filebrowser\$\{fileBrowserOpen \? ' active' : ''\}`\}/);
  });

  it('overflow menu demotes Git working tree and File browser with matching actions', () => {
    const overflowStart = app.indexOf('className="topbar-overflow-menu"');
    expect(overflowStart).toBeGreaterThan(-1);
    const menu = app.slice(overflowStart);
    const appearance = menu.indexOf('<span>Appearance</span>');
    expect(appearance).toBeGreaterThan(-1);
    const gitLabel = menu.indexOf('<span>Git working tree</span>');
    const fbLabel = menu.indexOf('<span>File browser</span>');
    expect(gitLabel).toBeGreaterThan(-1);
    expect(fbLabel).toBeGreaterThan(-1);
    expect(gitLabel).toBeLessThan(appearance);
    expect(fbLabel).toBeLessThan(appearance);

    expect(menu).toMatch(
      /setShowTopbarOverflow\(false\);\s*setGitPanel\(\{ via: 'topbar' \}\);/,
    );
    expect(menu).toMatch(
      /setShowTopbarOverflow\(false\);\s*setFileBrowserOpen\(true\);/,
    );
  });

  it('hides git and file browser buttons inside the ≤600px media query', () => {
    const start = css.indexOf('@media (max-width: 600px) {');
    expect(start).toBeGreaterThan(-1);
    const rest = css.slice(start + 1);
    const nextMediaRel = rest.search(/@media\s*\(/);
    const block = css.slice(start, nextMediaRel === -1 ? undefined : start + 1 + nextMediaRel);
    expect(block).toMatch(/\.topbar-git/);
    expect(block).toMatch(/\.topbar-filebrowser/);
    expect(block).toMatch(
      /\.topbar-git[\s\S]*?display:\s*none|\.topbar-git,\s*\n\s*\.topbar-filebrowser[\s\S]*?display:\s*none/,
    );
    expect(block).toMatch(/\.topbar-git[\s\S]{0,200}display:\s*none/);
    expect(block).toMatch(/\.topbar-filebrowser[\s\S]{0,80}display:\s*none/);
  });
});
