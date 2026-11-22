import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('file browser wiring', () => {
  const app = src('./App.tsx');
  const modal = src('./components/FileBrowserModal.tsx');

  it('places the topbar button after Git working tree and before Global tasks', () => {
    const git = app.indexOf('aria-label="Git working tree"');
    const fb = app.indexOf('aria-label="File browser"');
    const tasks = app.indexOf('gt-header-btn');
    expect(git).toBeGreaterThan(-1);
    expect(fb).toBeGreaterThan(git);
    expect(tasks).toBeGreaterThan(fb);
  });

  it('handles the palette action', () => {
    expect(app).toContain("case 'open_file_browser'");
    expect(src('./commandPalette.ts')).toContain("actionType: 'open_file_browser'");
  });

  it('opens files relatively through its own FileModal with root context', () => {
    expect(modal).toContain('<FileModal');
    expect(modal).toContain('conversationId={root.conversationId}');
    expect(modal).not.toMatch(/path=\{[^}]*root\.root/);
  });

  it('does not close underneath an open file', () => {
    expect(modal).toContain('if (!openFile)');
  });

  it('uses shared SelectDropdown for the root picker', () => {
    expect(modal).toMatch(/from ['"]\.\/SelectDropdown\.js['"]/);
    expect(modal).toContain('SelectDropdown');
  });

  it('styles the folder filter with modal-input', () => {
    expect(modal).toMatch(/className=["']modal-input["']/);
  });

  it('has no bare native select in FileBrowserModal', () => {
    expect(modal).not.toMatch(/<select[\s>]/);
  });
});
