import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionModeModal } from './PermissionModeModal.js';

if (typeof globalThis.document === 'undefined') {
  (globalThis as any).document = {
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

describe('PermissionModeModal', () => {
  it('renders all options and selects properly', () => {
    const html = renderToStaticMarkup(
      <PermissionModeModal
        value="bypass"
        defaultMode="bypass"
        permissionCapable={true}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('Permission Mode');
    expect(html).toContain('Default (inherit global: bypass)');
    expect(html).toContain('Bypass');
    expect(html).toContain('Questions only');
    expect(html).toContain('Prompt');
  });

  it('marks prompt mode disabled when not permission capable', () => {
    const html = renderToStaticMarkup(
      <PermissionModeModal
        value="bypass"
        defaultMode="bypass"
        permissionCapable={false}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('prompt mode is unavailable');
  });
});
