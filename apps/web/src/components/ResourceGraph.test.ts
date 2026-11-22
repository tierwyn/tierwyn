import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResourceGraph } from './ResourceGraph.js';

describe('ResourceGraph component', () => {
  it('renders title and empty state cleanly with no data', () => {
    const html = renderToStaticMarkup(
      createElement(ResourceGraph, { title: 'Test latency', values: [], unit: ' ms' })
    );
    expect(html).toContain('Test latency');
    expect(html).toContain('0 samples');
    expect(html).toContain('—');
  });

  it('renders current value and pulse dot when single value provided', () => {
    const html = renderToStaticMarkup(
      createElement(ResourceGraph, {
        title: 'CPU load',
        values: [45],
        unit: '%',
        fixedMin: 0,
        fixedMax: 100,
      })
    );
    expect(html).toContain('CPU load');
    expect(html).toContain('45%');
    expect(html).toContain('1 sample');
    expect(html).toContain('<circle');
  });

  it('renders SVG path and range for multiple values', () => {
    const html = renderToStaticMarkup(
      createElement(ResourceGraph, {
        title: 'RAM trend',
        values: [20, 50, 80],
        unit: '%',
        fixedMin: 0,
        fixedMax: 100,
      })
    );
    expect(html).toContain('RAM trend');
    expect(html).toContain('80%');
    expect(html).toContain('min 20%');
    expect(html).toContain('max 80%');
    expect(html).toContain('3 samples');
    expect(html).toContain('<path');
  });

  it('tolerates null values from dropped packets gracefully', () => {
    const html = renderToStaticMarkup(
      createElement(ResourceGraph, {
        title: 'Latency trend',
        values: [12, null, 18],
        unit: ' ms',
        fixedMin: 0,
      })
    );
    expect(html).toContain('Latency trend');
    expect(html).toContain('18 ms');
    expect(html).toContain('2 samples');
    expect(html).not.toContain('NaN');
  });
});
