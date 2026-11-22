import { describe, it, expect } from 'vitest';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { GrokBotIcon } from './GrokBotIcon.js';

describe('GrokBotIcon', () => {
  it('renders standard attributes and path structure', () => {
    const icon = GrokBotIcon({});
    expect(icon).toBeDefined();
    expect(icon.props.className).toBe('project-folder-icon');
    expect(icon.props.viewBox).toBe('0 0 16 14');
    expect(icon.props.width).toBe(16);
    expect(icon.props.height).toBe(14);
    expect(icon.props['aria-hidden']).toBe(true);

    // Children should include the head squircle path and the tilted eye path
    const children = icon.props.children;
    expect(children).toHaveLength(2);

    const [headPath, eyesPath] = children;
    expect(headPath.props.fill).toBe('var(--accent-dim)');
    expect(headPath.props.fillOpacity).toBe(0.25);
    expect(headPath.props.stroke).toBe('var(--accent)');
    expect(headPath.props.strokeWidth).toBe(1.2);
    expect(headPath.props.d).toContain('M5 1H11');

    expect(eyesPath.props.stroke).toBe('var(--accent)');
    expect(eyesPath.props.strokeWidth).toBe(1.3);
    expect(eyesPath.props.strokeLinecap).toBe('round');
    // Verify tilted pills path
    expect(eyesPath.props.d).toContain('M5.6 5.6L6.8 9.2');
    expect(eyesPath.props.d).toContain('M9.2 4.8L10.4 8.4');
  });

  it('accepts custom className and dimensions', () => {
    const custom = GrokBotIcon({
      className: 'custom-icon-class',
      width: 24,
      height: 20,
      style: { opacity: 0.8 },
    });
    expect(custom.props.className).toBe('custom-icon-class');
    expect(custom.props.width).toBe(24);
    expect(custom.props.height).toBe(20);
    expect(custom.props.style).toMatchObject({
      flexShrink: 0,
      opacity: 0.8,
    });
  });

  it('correctly matches Grok Bot project condition by UUID or name', () => {
    const isGrokBotProject = (p: { id: string; name: string }) =>
      p.id === REMOTE_AGENTS_PROJECT_ID || p.name === 'Grok Bots';

    expect(isGrokBotProject({ id: REMOTE_AGENTS_PROJECT_ID, name: 'Grok Bots' })).toBe(true);
    expect(isGrokBotProject({ id: REMOTE_AGENTS_PROJECT_ID, name: 'Custom Grok' })).toBe(true);
    expect(isGrokBotProject({ id: 'some-other-uuid', name: 'Grok Bots' })).toBe(true);
    expect(isGrokBotProject({ id: 'some-other-uuid', name: 'Tierwyn' })).toBe(false);
  });
});
