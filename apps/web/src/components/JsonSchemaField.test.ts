import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsonSchemaField } from './JsonSchemaField.js';

describe('JsonSchemaField', () => {
  it('renders presets and empty validation state when value is empty', () => {
    const html = renderToStaticMarkup(
      React.createElement(JsonSchemaField, {
        value: '',
        onChange: () => {},
      })
    );
    expect(html).toContain('Structured Summary');
    expect(html).toContain('Action Plan');
    expect(html).toContain('Custom');
    expect(html).toContain('Inline JSON schema object');
  });

  it('renders valid status line when valid JSON object is provided', () => {
    const validJson = JSON.stringify({ type: 'object', properties: { summary: { type: 'string' } } }, null, 2);
    const html = renderToStaticMarkup(
      React.createElement(JsonSchemaField, {
        value: validJson,
        onChange: () => {},
      })
    );
    expect(html).toContain('json-schema-status is-valid');
    expect(html).toContain('✓ Valid JSON Schema');
  });

  it('renders error status line when invalid JSON syntax is provided', () => {
    const invalidJson = '{ type: "object", invalid }';
    const html = renderToStaticMarkup(
      React.createElement(JsonSchemaField, {
        value: invalidJson,
        onChange: () => {},
      })
    );
    expect(html).toContain('json-schema-status is-invalid');
    expect(html).toContain('⚠ Invalid JSON');
  });

  it('renders error status line when JSON is an array rather than an object', () => {
    const arrayJson = '["not", "an", "object"]';
    const html = renderToStaticMarkup(
      React.createElement(JsonSchemaField, {
        value: arrayJson,
        onChange: () => {},
      })
    );
    expect(html).toContain('json-schema-status is-invalid');
    expect(html).toContain('JSON Schema must be a JSON object');
  });
});
