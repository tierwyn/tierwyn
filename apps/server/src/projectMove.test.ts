import { describe, it, expect, beforeEach } from 'vitest';
import { beginProjectMove, endProjectMove, isProjectMoving, PROJECT_MOVING_ERROR } from './projectMove.js';

describe('projectMove lock', () => {
  beforeEach(() => {
    endProjectMove('proj-1');
    endProjectMove('proj-2');
  });

  it('acquires lock, refuses concurrent move, releases on end', () => {
    expect(isProjectMoving('proj-1')).toBe(false);

    expect(beginProjectMove('proj-1')).toBe(true);
    expect(isProjectMoving('proj-1')).toBe(true);

    // Second acquisition for the same project fails
    expect(beginProjectMove('proj-1')).toBe(false);

    // Different project can acquire
    expect(beginProjectMove('proj-2')).toBe(true);
    expect(isProjectMoving('proj-2')).toBe(true);

    endProjectMove('proj-1');
    expect(isProjectMoving('proj-1')).toBe(false);
    expect(beginProjectMove('proj-1')).toBe(true);

    endProjectMove('proj-1');
    endProjectMove('proj-2');
  });

  it('exports the standard PROJECT_MOVING_ERROR text', () => {
    expect(PROJECT_MOVING_ERROR).toBe('project folder is being moved — retry in a moment');
  });
});
