import { join } from 'path';
import { homedir } from 'os';
import { spawn as nodeSpawn } from 'child_process';
import type { AgentAdapter } from '@tierwyn/shared';
import type { AdapterFactoryOpts } from '../registry.js';
import { sandboxSpawnFor, withPwdSpawn } from '../sandbox/bwrap.js';
import { ClaudeCodeAdapter } from './claude-code/index.js';
import { PiAdapter } from './pi/index.js';
import { AntigravityAdapter } from './antigravity/index.js';
import { OpenCodeAdapter } from './opencode/index.js';
import { CursorAdapter } from './cursor/index.js';
import { HermesAdapter } from './hermes/index.js';
import { CodexAdapter } from './codex/index.js';
import { GrokBuildAdapter } from './grok-build/index.js';
import { KiroAdapter } from './kiro/index.js';
import { QwenAdapter } from './qwen/index.js';
import { OpenClawAdapter } from './openclaw/index.js';
import { CopilotAdapter } from './copilot/index.js';
import { KimiAdapter } from './kimi/index.js';
import { DeepSeekAdapter } from './deepseek/index.js';

type StdioRegistry = {
  register(
    type: string,
    f: (opts?: AdapterFactoryOpts) => AgentAdapter,
    label?: string,
  ): void;
};

/** Always inject a spawn that sets `PWD=cwd`. Sandboxed path also wraps bwrap. */
const sb = (type: string, opts?: AdapterFactoryOpts) =>
  opts?.sandbox
    ? { spawn: sandboxSpawnFor(type, {
        customPaths: opts.sandboxPaths,
        roots: opts.sandboxRoots,
        extraDeny: opts.sandboxDeny,
      }), sandboxed: true as const }
    : { spawn: withPwdSpawn(nodeSpawn) };

export function registerStdioAdapters(
  reg: StdioRegistry,
  defaultMode: () => 'bypass' | 'questions' | 'prompt',
): void {
  reg.register('claude-code', (opts) => new ClaudeCodeAdapter({
    interactionMode: opts?.interactionMode ?? defaultMode(),
    ...sb('claude-code', opts),
  }), 'Claude Code');
  reg.register('pi', (opts) => new PiAdapter({ ...sb('pi', opts) }), 'Pi');
  reg.register('antigravity', (opts) => new AntigravityAdapter({
    interactionMode: opts?.interactionMode ?? defaultMode(),
    ...sb('antigravity', opts),
  }), 'Antigravity');
  reg.register('opencode', (opts) => new OpenCodeAdapter({ ...sb('opencode', opts) }), 'OpenCode');
  reg.register(
    'kilocode',
    (opts) => new OpenCodeAdapter({
      bin: 'kilo',
      label: 'Kilo',
      agentType: 'kilocode',
      configDir: join(homedir(), '.config', 'kilo'),
      dbPath: join(homedir(), '.local', 'share', 'kilo', 'kilo.db'),
      // Kilo personal skills live here (not in the XDG config dir);
      // ~/.agents/skills is the cross-agent default kilo also loads.
      skillDirs: [join(homedir(), '.kilo', 'skills'), join(homedir(), '.agents', 'skills')],
      ...sb('kilocode', opts),
    }),
    'KiloCode',
  );
  reg.register('cursor', (opts) => new CursorAdapter({ ...sb('cursor', opts) }), 'Cursor');
  reg.register('hermes', (opts) => new HermesAdapter({
    interactionMode: opts?.interactionMode ?? defaultMode(),
    ...sb('hermes', opts),
  }), 'Hermes');
  reg.register('codex', (opts) => new CodexAdapter({
    interactionMode: opts?.interactionMode ?? defaultMode(),
    ...sb('codex', opts),
  }), 'Codex');
  reg.register('grok-build', (opts) => new GrokBuildAdapter({
    interactionMode: opts?.interactionMode ?? defaultMode(),
    ...sb('grok-build', opts),
  }), 'Grok Build');
  reg.register('kiro', (opts) => new KiroAdapter({
    interactionMode: opts?.interactionMode ?? defaultMode(),
    ...sb('kiro', opts),
  }), 'Kiro');
  reg.register('qwen', (opts) => new QwenAdapter({
    interactionMode: opts?.interactionMode ?? defaultMode(),
    ...sb('qwen', opts),
  }), 'Qwen Code');
  reg.register('openclaw', (opts) => new OpenClawAdapter({ ...sb('openclaw', opts) }), 'OpenClaw');
  reg.register('copilot', (opts) => new CopilotAdapter({ ...sb('copilot', opts) }), 'GitHub Copilot');
  reg.register('kimi', (opts) => new KimiAdapter({
    interactionMode: opts?.interactionMode ?? defaultMode(),
    ...sb('kimi', opts),
  }), 'Kimi Code');
  reg.register('deepseek', (opts) => new DeepSeekAdapter({ ...sb('deepseek', opts) }), 'DeepSeek Harness');
}
