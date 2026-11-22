import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SandboxPathList } from './SandboxPathList.js';

describe('SandboxPathList', () => {
  it('does not show a Phase E3 deferred-mount warning', () => {
    const html = renderToStaticMarkup(
      <SandboxPathList paths={[{ path: '/srv/models', mode: 'ro' }]} onChange={() => {}} />,
    );
    expect(html).not.toMatch(/Phase E3/i);
    expect(html).toContain('/srv/models');
  });
});
