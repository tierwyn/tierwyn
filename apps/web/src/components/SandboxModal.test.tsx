import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SandboxModal } from './SandboxModal.js';
import { sandboxControlState } from '../sandboxControl.js';

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

const baseInput = {
  agentType: 'claude-code' as string | undefined,
  conv: null as 'on' | 'off' | null,
  project: 'on' as 'on' | 'off' | null,
  settings: { global: false, defaults: [] as [] },
  hostId: 'hub',
  supportedAgents: ['claude-code', 'codex'] as readonly string[],
  hubAvailable: true as boolean | undefined,
  remote: false,
};

describe('SandboxModal', () => {
  it('renders all options with inheritance information', () => {
    const state = sandboxControlState({ ...baseInput, conv: null, project: 'on' })!;
    const html = renderToStaticMarkup(
      <SandboxModal
        state={state}
        value={null}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('Agent Sandbox');
    expect(html).toContain('Inherit (project: on)');
    expect(html).toContain('Sandbox: On');
    expect(html).toContain('Sandbox: Off');
  });

  it('renders disabled reasons when unsupported', () => {
    const state = sandboxControlState({ ...baseInput, hubAvailable: false })!;
    const html = renderToStaticMarkup(
      <SandboxModal
        state={state}
        value={null}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('bubblewrap (bwrap) is unavailable on the hub');
  });

  it('renders origin and a warning when the host cannot sandbox', () => {
    const state = sandboxControlState({
      ...baseInput,
      project: null,
      hubAvailable: false,
      settings: { global: true, defaults: [] },
    })!;
    const html = renderToStaticMarkup(
      <SandboxModal
        state={state}
        value={null}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('Currently: Sandbox: off (host can&#x27;t sandbox)');
    expect(html).toContain('Host cannot sandbox');
    expect(html).toContain('4-tier chain');
  });
});
