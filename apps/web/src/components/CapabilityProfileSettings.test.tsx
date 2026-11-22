import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { CapabilityProfileSettings } from './CapabilityProfileSettings.js';

const src = readFileSync(new URL('./CapabilityProfileSettings.tsx', import.meta.url), 'utf8');

describe('CapabilityProfileSettings scrolling layout', () => {
  it('does not use template-settings--panel or template-settings-body which trap overflow', () => {
    // template-settings--panel sets overflow: hidden and clamps flex height
    expect(src).not.toContain('template-settings--panel');
    // template-settings-body sets inner overflow-y: auto and clamps flex height
    expect(src).not.toContain('template-settings-body');
  });

  it('uses capability-profile-settings and dedicated editor actions', () => {
    expect(src).toContain('capability-profile-settings');
    expect(src).toContain('capability-profile-editor-actions');
    expect(src).toContain('editorRef');
  });

  it('renders initial markup without overflow-trapping panel classes', () => {
    const html = renderToStaticMarkup(<CapabilityProfileSettings />);
    expect(html).toContain('capability-profile-settings');
    expect(html).not.toContain('template-settings--panel');
    expect(html).not.toContain('template-settings-body');
    expect(html).toContain('template-list');
  });
});
