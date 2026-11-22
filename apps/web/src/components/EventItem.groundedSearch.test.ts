import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { EventItem } from './EventItem.js';
import type { NormalisedEvent } from '@tierwyn/shared';

describe('EventItem tool_result grounded search display', () => {
  it('renders grounded search message and badge when web search tool has empty output', () => {
    const event: NormalisedEvent = {
      id: 'res-1',
      sessionId: 's1',
      seq: 1,
      ts: 1000,
      type: 'tool_result',
      payload: {
        toolUseId: 'call-1',
        content: '',
        isError: false,
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(EventItem, {
        event,
        linkedToolName: 'search_web',
      })
    );

    expect(html).toContain('Search results incorporated into model context');
    expect(html).toContain('tool-result-grounded');
    expect(html).toContain('· grounded search');
    expect(html).not.toContain('(no output)');
  });

  it('renders standard (no output) for non-search tools with empty output', () => {
    const event: NormalisedEvent = {
      id: 'res-2',
      sessionId: 's1',
      seq: 2,
      ts: 1000,
      type: 'tool_result',
      payload: {
        toolUseId: 'call-2',
        content: '',
        isError: false,
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(EventItem, {
        event,
        linkedToolName: 'execute_command',
      })
    );

    expect(html).toContain('(no output)');
    expect(html).toContain('tool-result-empty');
    expect(html).not.toContain('grounded search');
    expect(html).not.toContain('Search results incorporated into model context');
  });

  it('renders normal content if search tool returned actual content', () => {
    const event: NormalisedEvent = {
      id: 'res-3',
      sessionId: 's1',
      seq: 3,
      ts: 1000,
      type: 'tool_result',
      payload: {
        toolUseId: 'call-3',
        content: 'Found 3 results: https://example.com',
        isError: false,
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(EventItem, {
        event,
        linkedToolName: 'search_web',
      })
    );

    expect(html).toContain('Found 3 results: https://example.com');
    expect(html).not.toContain('grounded search');
    expect(html).not.toContain('Search results incorporated into model context');
  });

  it('renders file-edit placeholder for empty successful edit results, not read tools', () => {
    const event: NormalisedEvent = {
      id: 'res-fe', sessionId: 's1', seq: 3, ts: 1000, type: 'tool_result',
      payload: { toolUseId: 'call-fe', content: '', isError: false },
    };
    const edit = renderToStaticMarkup(React.createElement(EventItem, { event, linkedToolName: 'replace_file_content' }));
    expect(edit).toContain('File edit applied');
    expect(edit).not.toContain('(no output)');
    const read = renderToStaticMarkup(React.createElement(EventItem, { event, linkedToolName: 'read_file' }));
    expect(read).toContain('(no output)');
  });
});
