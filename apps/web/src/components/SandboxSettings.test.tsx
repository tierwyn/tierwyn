import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { SANDBOX_FLEET_WIDE_CELL_LABEL } from '../sandboxControl.js';
import { SandboxFleetWideCell } from './SandboxSettings.js';

const src = readFileSync(new URL('./SandboxSettings.tsx', import.meta.url), 'utf8');

describe('SandboxFleetWideCell', () => {
  it('renders a read-only Global default badge, not a selector', () => {
    const html = renderToStaticMarkup(<SandboxFleetWideCell />);
    expect(html).toContain(SANDBOX_FLEET_WIDE_CELL_LABEL);
    expect(html).toContain('sandbox-global-cell');
    expect(html).toContain('#sandbox-global-default');
    expect(html).not.toMatch(/<button/i);
  });
});

describe('SandboxSettings auto-save', () => {
  it('has no manual Discard/Save button row', () => {
    expect(src).not.toContain('sandbox-save-row');
    expect(src).not.toMatch(/>\s*Discard\s*</);
    expect(src).not.toMatch(/saving \? 'Saving…' : 'Save'/);
  });

  it('persists the global default immediately on toggle', () => {
    expect(src).not.toContain('setDraft((d) => ({ ...d, global: !d.global }))');
    expect(src).toMatch(/updateSandboxSettings\(/);
    expect(src).toMatch(/global:\s*!/);
  });

  it('persists default-cell changes immediately', () => {
    expect(src).not.toContain('setDraft((d) => ({ ...d, defaults: setCell(d.defaults, hostId, agentType, value) }))');
    expect(src).toMatch(/defaults:\s*setCell/);
    expect(src).toMatch(/updateSandboxSettings\(/);
  });

  it('persists host custom path changes immediately', () => {
    expect(src).not.toMatch(/onChange=\{\(next\) => setDraft\(\(d\) => \{/);
    expect(src).toMatch(/updateSandboxSettings\(/);
    expect(src).toContain('hostPaths');
  });

  it('shows save errors inline', () => {
    expect(src).toMatch(/\{error && <div className="error">\{error\}<\/div>\}/);
    expect(src).toContain('api.updateSandboxSettings');
  });
});

