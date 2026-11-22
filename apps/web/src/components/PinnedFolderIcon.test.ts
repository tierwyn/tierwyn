import { describe, it, expect } from 'vitest';
import { PINNED_PROJECT_ID } from '../pinned.js';
import { PinnedFolderIcon } from './PinnedFolderIcon.js';

describe('PinnedFolderIcon', () => {
  it('renders standard attributes and path structure', () => {
    const icon = PinnedFolderIcon({});
    expect(icon).toBeDefined();
    expect(icon.props.className).toBe('project-folder-icon');
    expect(icon.props.viewBox).toBe('0 0 16 14');
    expect(icon.props.width).toBe(16);
    expect(icon.props.height).toBe(14);
    expect(icon.props['aria-hidden']).toBe(true);

    const children = icon.props.children;
    expect(children).toHaveLength(2);

    const [bodyPath, needleLine] = children;
    expect(bodyPath.props.fill).toBe('var(--accent-dim)');
    expect(bodyPath.props.fillOpacity).toBe(0.25);
    expect(bodyPath.props.stroke).toBe('var(--accent)');
    expect(bodyPath.props.strokeWidth).toBe(1.2);
    expect(bodyPath.props.strokeLinejoin).toBe('round');

    expect(needleLine.props.stroke).toBe('var(--accent)');
    expect(needleLine.props.strokeWidth).toBe(1.3);
    expect(needleLine.props.strokeLinecap).toBe('round');
    expect(needleLine.props.x1).toBe(8);
    expect(needleLine.props.x2).toBe(8);
  });

  it('accepts custom className and dimensions', () => {
    const custom = PinnedFolderIcon({
      className: 'custom-icon-class',
      width: 20,
      height: 18,
      style: { opacity: 0.9 },
    });
    expect(custom.props.className).toBe('custom-icon-class');
    expect(custom.props.width).toBe(20);
    expect(custom.props.height).toBe(18);
    expect(custom.props.style).toMatchObject({
      flexShrink: 0,
      opacity: 0.9,
    });
  });

  it('correctly matches Pinned folder project condition by ID', () => {
    const isPinnedFolder = (p: { id: string }) => p.id === PINNED_PROJECT_ID;

    expect(isPinnedFolder({ id: PINNED_PROJECT_ID })).toBe(true);
    expect(isPinnedFolder({ id: 'some-other-uuid' })).toBe(false);
  });
});
