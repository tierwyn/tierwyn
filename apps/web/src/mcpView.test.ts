import { describe, it, expect } from 'vitest';
import type { McpLiveStatus, ResolvedMcpSkipReason } from '@tierwyn/shared';
import {
  describeSkipReason,
  summariseStatus,
  summariseChipLabel,
  statusSeverity,
  getMcpSelectionMode,
  resolveSelectedIds,
} from './mcpView.js';

describe('mcpView', () => {
  describe('describeSkipReason', () => {
    it('returns plain-language string for each skip reason', () => {
      const cases: [ResolvedMcpSkipReason, string][] = [
        ['delegating_blocked', "Blocked: this chat can delegate — enable 'Allow in delegating chats' on the server"],
        ['disabled', 'Disabled on the server'],
        ['unknown', 'Unknown or removed server'],
        ['agent_not_injectable', 'Agent does not support registry MCP injection'],
        ['agent_filtered', "Excluded by server's agent filter"],
        ['transport_unsupported', 'Transport is unsupported by this agent'],
        ['secret_missing', 'Missing required secret (vault or env fallback)'],
        ['secret_env_unsupported', 'Agent does not support secret env vars for this transport'],
        ['hub_placement_unsupported', 'Hub placement supports http servers only (for now)'],
        ['command_not_found_on_host', 'Command not found on the remote host'],
        ['cwd_outside_roots', "Working directory is outside the remote host's allowed roots"],
      ];

      for (const [reason, expected] of cases) {
        expect(describeSkipReason(reason)).toBe(expected);
      }
    });

    it('handles undefined or unknown reasons gracefully', () => {
      expect(describeSkipReason(undefined)).toBe('Skipped');
      expect(describeSkipReason('custom_reason' as any)).toBe('Skipped: custom_reason');
    });
  });

  describe('summariseStatus', () => {
    it('returns default MCP label for null or empty list', () => {
      expect(summariseStatus(null)).toEqual({ total: 0, connected: 0, label: 'MCP' });
      expect(summariseStatus([])).toEqual({ total: 0, connected: 0, label: 'MCP' });
    });

    it('counts connected servers correctly', () => {
      const statuses: McpLiveStatus[] = [
        { name: 's1', status: 'connected', source: 'tierwyn' },
        { name: 's2', status: 'failed', source: 'tierwyn' },
        { name: 's3', status: 'connected', source: 'native' },
      ];
      expect(summariseStatus(statuses)).toEqual({
        total: 3,
        connected: 2,
        label: 'MCP 2/3',
      });
    });
  });

  describe('statusSeverity', () => {
    it('maps statuses to severity colors', () => {
      expect(statusSeverity('connected')).toBe('success');
      expect(statusSeverity('failed')).toBe('danger');
      expect(statusSeverity('needs-auth')).toBe('warning');
      expect(statusSeverity('pending')).toBe('warning');
      expect(statusSeverity('disabled')).toBe('muted');
    });
  });

  describe('tri-state selection helpers', () => {
    it('determines selection mode accurately', () => {
      expect(getMcpSelectionMode(null)).toBe('inherit');
      expect(getMcpSelectionMode(undefined)).toBe('inherit');
      expect(getMcpSelectionMode([])).toBe('none');
      expect(getMcpSelectionMode(['server-a'])).toBe('custom');
      expect(getMcpSelectionMode(['server-a', 'server-b'])).toBe('custom');
    });

    it('resolves selection mode back to wire format', () => {
      expect(resolveSelectedIds('inherit', ['server-a'])).toBeNull();
      expect(resolveSelectedIds('none', ['server-a'])).toEqual([]);
      expect(resolveSelectedIds('custom', ['server-a', 'server-b'])).toEqual(['server-a', 'server-b']);
    });
  });

  describe('summariseChipLabel', () => {
    it('prefers live statuses when present', () => {
      const statuses: McpLiveStatus[] = [
        { name: 's1', status: 'connected', source: 'tierwyn' },
        { name: 's2', status: 'failed', source: 'tierwyn' },
      ];
      expect(summariseChipLabel(statuses, [{ id: 's1', injected: true }], ['s1'])).toEqual({
        label: 'MCP 1/2',
        activeCount: 1,
        isModified: true,
      });
    });

    it('falls back to effective injected count when idle', () => {
      expect(
        summariseChipLabel(
          null,
          [
            { id: 's1', injected: true },
            { id: 's2', injected: false },
          ],
          ['s1', 's2'],
        ),
      ).toEqual({
        label: 'MCP 1',
        activeCount: 1,
        isModified: true,
      });
    });

    it('shows MCP Off when explicitly disabled ([]) and MCP otherwise', () => {
      expect(summariseChipLabel(null, [], [])).toEqual({ label: 'MCP Off', activeCount: 0, isModified: true });
      expect(summariseChipLabel(null, [], null)).toEqual({ label: 'MCP', activeCount: 0, isModified: false });
    });

    it('marks modified when native MCPs are disabled or filtered', () => {
      expect(summariseChipLabel(null, [], null, true)).toEqual({ label: 'MCP', activeCount: 0, isModified: true });
      expect(summariseChipLabel(null, [], null, false, ['native1'])).toEqual({ label: 'MCP', activeCount: 0, isModified: true });
    });
  });
});

describe('mcp capability', () => {
  it('describes enforced vs ignored agents honestly', async () => {
    const { describeMcpCapability } = await import('./mcpView.js');
    const { mcpAgentCapability } = await import('@tierwyn/shared');
    expect(describeMcpCapability('claude-code')).toBe('Registry injection: supported · Native overrides: enforced');
    expect(describeMcpCapability('codex')).toBe('Registry injection: supported · Native overrides: not enforced');
    expect(describeMcpCapability('antigravity')).toBe('Registry injection: not supported · Native overrides: not enforced');
    expect(mcpAgentCapability('antigravity').notes).toContain('mcp_config.json');
    expect(mcpAgentCapability('codex').notes).toMatch(/sse servers are skipped/);
    expect(mcpAgentCapability('unknown-agent')).toEqual({ registryInjection: 'unsupported', nativeOverrides: 'ignored' });
  });
});
