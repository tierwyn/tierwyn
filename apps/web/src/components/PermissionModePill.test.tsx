import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionModePill } from './PermissionModePill.js';

describe('PermissionModePill', () => {
  it('renders default display value when value is null', () => {
    const html = renderToStaticMarkup(
      <PermissionModePill
        value={null}
        defaultMode="bypass"
        permissionCapable={true}
        onChange={() => {}}
      />
    );

    expect(html).toContain('default');
    expect(html).toContain('title="Permission mode: default"');
  });

  it('renders explicit mode when value is set', () => {
    const html = renderToStaticMarkup(
      <PermissionModePill
        value="prompt"
        defaultMode="bypass"
        permissionCapable={true}
        onChange={() => {}}
      />
    );

    expect(html).toContain('prompt');
    expect(html).toContain('title="Permission mode: prompt"');
  });

  it('renders disabled button when disabled is true', () => {
    const html = renderToStaticMarkup(
      <PermissionModePill
        value="questions"
        defaultMode="bypass"
        permissionCapable={true}
        disabled={true}
        onChange={() => {}}
      />
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('questions');
  });

  it('includes permission-mode-pill class on root wrapper', () => {
    const html = renderToStaticMarkup(
      <PermissionModePill
        value={null}
        defaultMode="questions"
        permissionCapable={true}
        onChange={() => {}}
      />
    );

    expect(html).toContain('class="effort-pill permission-mode-pill"');
  });
});
