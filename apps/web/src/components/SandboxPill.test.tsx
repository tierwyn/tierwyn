import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SandboxPill } from './SandboxPill.js';
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

describe('SandboxPill', () => {
  it('renders compact ON badge when effectively on', () => {
    const state = sandboxControlState({ ...baseInput, conv: null, project: 'on' });
    const html = renderToStaticMarkup(
      <SandboxPill state={state} value={null} onChange={() => {}} />,
    );
    expect(html).toContain('on');
    expect(html).toContain('Sandbox: on (project)');
  });

  it('renders compact OFF badge when effectively off', () => {
    const state = sandboxControlState({ ...baseInput, conv: 'off', project: 'on' });
    const html = renderToStaticMarkup(
      <SandboxPill state={state} value="off" onChange={() => {}} />,
    );
    expect(html).toContain('off');
    expect(html).toContain('Sandbox: off (this chat)');
  });

  it('renders locked node require state as disabled', () => {
    const state = sandboxControlState({
      ...baseInput,
      remote: true,
      hostId: 'vm-909',
      conv: 'off',
      hostHello: { features: ['sandbox'], sandbox: { policy: 'require', available: true } },
    });
    const html = renderToStaticMarkup(
      <SandboxPill state={state} value={null} onChange={() => {}} />,
    );
    expect(html).toContain('Sandbox: on (forced by host)');
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('renders a warning chip when the host cannot sandbox', () => {
    const state = sandboxControlState({
      ...baseInput,
      project: null,
      hubAvailable: false,
      settings: { global: true, defaults: [] },
    });
    const html = renderToStaticMarkup(
      <SandboxPill state={state} value={null} onChange={() => {}} />,
    );
    expect(html).toMatch(/Sandbox: off \(host can(&#x27;|')t sandbox\)/);
    expect(html).toContain('sandbox-pill-warning');
  });

  it('renders nothing for grok-bot', () => {
    const state = sandboxControlState({ ...baseInput, agentType: 'grok-bot' });
    const html = renderToStaticMarkup(
      <SandboxPill state={state} value={null} onChange={() => {}} />,
    );
    expect(html).toBe('');
  });
});
