import { describe, it, expect } from 'vitest';
import { modelSelectorEmptyCopy, modelSelectorTriggerLabel } from './modelSelectorLabel.js';

const SAMPLE = [{ id: 'p1', label: 'Claude · Opus' }];

describe('modelSelectorTriggerLabel', () => {
  it('shows Loading while /profiles has not landed, even when the list is empty', () => {
    expect(modelSelectorTriggerLabel(undefined, [], false, false)).toBe('Loading');
    expect(modelSelectorTriggerLabel(null, [], true, false)).toBe('Loading');
    expect(modelSelectorTriggerLabel(undefined, [], false, false)).not.toBe('No agents enabled');
  });

  it('shows No agents enabled only after a successful empty fetch', () => {
    expect(modelSelectorTriggerLabel(undefined, [], false, true)).toBe('No agents enabled');
    expect(modelSelectorTriggerLabel(null, [], true, true)).toBe('No agents enabled');
  });

  it('shows Select model when loaded, list is non-empty, nothing selected, allowEmpty', () => {
    expect(modelSelectorTriggerLabel(undefined, SAMPLE, true, true)).toBe('Select model');
  });

  it('uses the selected profile label when present', () => {
    expect(modelSelectorTriggerLabel(SAMPLE[0], [], false, false)).toBe('Claude · Opus');
  });
});

describe('modelSelectorEmptyCopy', () => {
  it('does not show the Catalogue instruction while unloaded', () => {
    const copy = modelSelectorEmptyCopy([], false);
    expect(copy).not.toBe('No agents enabled — turn one on in Settings → Agents.');
    expect(copy).toBe('Loading');
  });

  it('shows the Catalogue instruction when loaded with zero profiles', () => {
    expect(modelSelectorEmptyCopy([], true)).toBe(
      'No agents enabled — turn one on in Settings → Agents.',
    );
  });

  it('shows No matches when loaded with profiles that did not match the filter', () => {
    expect(modelSelectorEmptyCopy(SAMPLE, true)).toBe('No matches');
  });
});
