import { describe, it, expect } from 'vitest';
import { summarizeToolInput } from './TurnInfoPopover.js';

describe('summarizeToolInput', () => {
  it('extracts command for shell tools', () => {
    expect(summarizeToolInput('bash', { command: 'git status' })).toBe('git status');
    expect(summarizeToolInput('run_command', { CommandLine: 'npm test' })).toBe('npm test');
  });

  it('extracts target file for file tools', () => {
    expect(summarizeToolInput('view_file', { AbsolutePath: '/var/log/syslog' })).toBe('/var/log/syslog');
    expect(summarizeToolInput('replace_file_content', { TargetFile: '/src/app.tsx' })).toBe('/src/app.tsx');
    expect(summarizeToolInput('write_to_file', { path: '/tmp/test.txt' })).toBe('/tmp/test.txt');
  });

  it('extracts search queries and patterns', () => {
    expect(summarizeToolInput('grep_search', { Query: 'function foo' })).toBe('function foo');
    expect(summarizeToolInput('find_by_name', { Pattern: '*.css' })).toBe('*.css');
    expect(summarizeToolInput('read_url_content', { Url: 'https://example.com' })).toBe('https://example.com');
  });

  it('handles invalid or empty inputs gracefully', () => {
    expect(summarizeToolInput('tool', null)).toBe('');
    expect(summarizeToolInput('tool', undefined)).toBe('');
    expect(summarizeToolInput('tool', {})).toBe('');
  });
});
