import { describe, it, expect, vi } from 'vitest';
import { ClaudeCodeAdapter } from './claude-code/index.js';
import { QwenAdapter } from './qwen/index.js';
import { KimiAdapter } from './kimi/index.js';
import { KiroAdapter } from './kiro/index.js';
import { HermesAdapter } from './hermes/index.js';
import { GrokBuildAdapter } from './grok-build/index.js';
import { CodexAdapter } from './codex/index.js';
import { AntigravityAdapter } from './antigravity/index.js';

describe('adapters setPermissionMode', () => {
  it('claude-code setPermissionMode updates mode and forwards to live query', async () => {
    const adapter = new ClaudeCodeAdapter({} as any, { interactionMode: 'bypass' });
    const mockSetMode = vi.fn();
    (adapter as any)._query = { setPermissionMode: mockSetMode };

    await adapter.setPermissionMode('prompt');
    expect((adapter as any)._interactionMode).toBe('prompt');
    expect(mockSetMode).toHaveBeenCalledWith('default');
  });

  it('qwen setPermissionMode updates mode and sends session/set_mode', async () => {
    const adapter = new QwenAdapter({} as any, { interactionMode: 'bypass' });
    const mockRequest = vi.fn().mockResolvedValue({});
    (adapter as any)._acp = { request: mockRequest };
    (adapter as any)._nativeSessionId = 'qwen-session-1';

    await adapter.setPermissionMode('prompt');
    expect((adapter as any)._interactionMode).toBe('prompt');
    expect(mockRequest).toHaveBeenCalledWith('session/set_mode', {
      sessionId: 'qwen-session-1',
      modeId: 'default',
    });
  });

  it('kimi setPermissionMode updates mode and checks supported modeIds', async () => {
    const adapter = new KimiAdapter({} as any, { interactionMode: 'bypass' });
    const mockRequest = vi.fn().mockResolvedValue({});
    (adapter as any)._acp = { request: mockRequest };
    (adapter as any)._nativeSessionId = 'kimi-session-1';
    (adapter as any)._supportedModeIds = ['default', 'yolo'];

    await adapter.setPermissionMode('prompt');
    expect((adapter as any)._interactionMode).toBe('prompt');
    expect(mockRequest).toHaveBeenCalledWith('session/set_mode', {
      sessionId: 'kimi-session-1',
      modeId: 'default',
    });
  });

  it('kiro setPermissionMode updates mode', async () => {
    const adapter = new KiroAdapter({} as any, { interactionMode: 'bypass' });
    await adapter.setPermissionMode('prompt');
    expect((adapter as any)._interactionMode).toBe('prompt');
  });

  it('hermes setPermissionMode updates mode', async () => {
    const adapter = new HermesAdapter({} as any, { interactionMode: 'bypass' });
    await adapter.setPermissionMode('prompt');
    expect((adapter as any)._interactionMode).toBe('prompt');
  });

  it('grok-build setPermissionMode sends session/set_model with sessionMeta', async () => {
    const adapter = new GrokBuildAdapter({} as any, { interactionMode: 'bypass' });
    const mockSend = vi.fn().mockResolvedValue({});
    (adapter as any)._rpc = { send: mockSend };
    (adapter as any)._nativeSessionId = 'grok-session-1';
    (adapter as any)._model = 'grok-4.6';

    await adapter.setPermissionMode('prompt');
    expect((adapter as any)._interactionMode).toBe('prompt');
    expect(mockSend).toHaveBeenCalledWith('session/set_model', expect.objectContaining({
      sessionId: 'grok-session-1',
    }));
  });

  it('codex setPermissionMode updates mode and marks thread unstarted', async () => {
    const adapter = new CodexAdapter({} as any, { interactionMode: 'bypass' });
    (adapter as any)._threadStarted = true;
    (adapter as any)._threadId = 'thread-123';

    await adapter.setPermissionMode('prompt');
    expect((adapter as any)._interactionMode).toBe('prompt');
    expect((adapter as any)._threadStarted).toBe(false);
    expect((adapter as any)._resumeThreadId).toBe('thread-123');
  });

  it('antigravity setPermissionMode updates mode', async () => {
    const adapter = new AntigravityAdapter({} as any, { interactionMode: 'bypass' });
    await adapter.setPermissionMode('prompt');
    expect((adapter as any)._interactionMode).toBe('prompt');
  });
});
