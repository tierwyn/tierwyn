import { describe, it, expect } from 'vitest';
import { computeDiff } from './components/ToolInputDisplay.js';

describe('computeDiff', () => {
  it('handles identical content with 0 added and 0 removed', () => {
    const text = 'line 1\nline 2\nline 3';
    const result = computeDiff(text, text);
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe('unchanged');
    expect(result.blocks[0].lines.length).toBe(3);
  });

  it('handles empty inputs', () => {
    const emptyResult = computeDiff('', '');
    expect(emptyResult.addedCount).toBe(0);
    expect(emptyResult.removedCount).toBe(0);
    expect(emptyResult.blocks.length).toBe(0);

    const addResult = computeDiff('', 'new line');
    expect(addResult.addedCount).toBe(1);
    expect(addResult.removedCount).toBe(0);
    expect(addResult.blocks[0].lines[0]).toEqual({ type: 'added', text: 'new line' });

    const delResult = computeDiff('old line', '');
    expect(delResult.addedCount).toBe(0);
    expect(delResult.removedCount).toBe(1);
    expect(delResult.blocks[0].lines[0]).toEqual({ type: 'removed', text: 'old line' });
  });

  it('accurately identifies single-line replacement in middle of file', () => {
    const original = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      'Status: proposed',
      '',
      'Footer notes.',
    ].join('\n');

    const replacement = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      'Status: approved',
      '',
      'Footer notes.',
    ].join('\n');

    const result = computeDiff(original, replacement);
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1);

    // Prefix block: unchanged
    expect(result.blocks[0].type).toBe('unchanged');
    expect(result.blocks[0].lines.map((l) => l.text)).toEqual([
      '# Title',
      '',
      'Intro paragraph.',
      '',
    ]);

    // Changed block
    expect(result.blocks[1].type).toBe('changed');
    expect(result.blocks[1].lines).toEqual([
      { type: 'removed', text: 'Status: proposed' },
      { type: 'added', text: 'Status: approved' },
    ]);

    // Suffix block: unchanged
    expect(result.blocks[2].type).toBe('unchanged');
    expect(result.blocks[2].lines.map((l) => l.text)).toEqual([
      '',
      'Footer notes.',
    ]);
  });

  it('handles multi-line additions and deletions', () => {
    const original = 'A\nB\nC\nD';
    const replacement = 'A\nB\nX\nY\nZ\nD';
    const result = computeDiff(original, replacement);

    expect(result.addedCount).toBe(3);
    expect(result.removedCount).toBe(1);
  });

  it('handles large files fast with common prefix and suffix trimming', () => {
    const lines1000 = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}`);
    const modified = [...lines1000];
    modified[500] = 'Line 501 modified';

    const t0 = performance.now();
    const result = computeDiff(lines1000.join('\n'), modified.join('\n'));
    const duration = performance.now() - t0;

    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1);
    // Prefix trimming means this runs in less than 50ms (usually < 2ms)
    expect(duration).toBeLessThan(100);
  });
});
