import { describe, it, expect } from 'vitest';
import { sidecarAdvisoryText } from './sidecarAdvisoryText';

describe('sidecarAdvisoryText', () => {
  it('returns empty string for no advisories', () => {
    expect(sidecarAdvisoryText([])).toBe('');
  });

  it('maps reason codes into the operator warning line', () => {
    expect(sidecarAdvisoryText([
      { site: 'commit', adapter: 'pi', model: 'zai/glm-5.3-flash', reason: 'model_not_on_host' },
      { site: 'enhance', adapter: 'claude-code', model: 'm', reason: 'mode_read_only_unsupported_on_host' },
    ])).toBe(
      '⚠ Sidecars that will run tools-off on the hub instead: commit (pi · zai/glm-5.3-flash — model not on host), enhance project (claude-code · m — read-only not supported on host).',
    );
  });

  it('maps agent_not_installed', () => {
    expect(sidecarAdvisoryText([
      { site: 'enhance', adapter: 'claude-code', model: 'm', reason: 'agent_not_installed' },
    ])).toContain('enhance (claude-code · m — agent not installed)');
  });
});
