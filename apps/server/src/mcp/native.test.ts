import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  installNativeMcp,
  maskArgs,
  maskUrl,
  mergeNativeFile,
  NativeWriteError,
  readNativeMcp,
  removeNativeMcp,
  stripJsonc,
} from './native.js';

function home() {
  const h = mkdtempSync(join(tmpdir(), 'mcp-native-'));
  const root = join(h, 'proj');
  mkdirSync(root);
  return { h, root };
}

describe('native MCP viewer', () => {
  it('claude-code: user + local + project scopes, env/header values masked', async () => {
    const { h, root } = home();
    writeFileSync(join(h, '.claude.json'), JSON.stringify({
      mcpServers: {
        ctx: { command: 'npx', args: ['-y', 'ctx', '--api-key', 'sk-123', 'TOKEN=abc'], env: { K: 'secret' } },
        bad: { type: 'http', url: '{bad-url?token-raw}' },
      },
      projects: { [root]: { mcpServers: { loc: { type: 'http', url: 'https://h/mcp?token=zzz', headers: { Authorization: 'Bearer x' } } } } },
    }));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: 'true' } } }));
    const v = await readNativeMcp('claude-code', root, { home: h });
    expect(JSON.stringify(v)).not.toMatch(/sk-123|abc|secret|Bearer x|zzz|token-raw/);
    expect(v.entries.find((e) => e.name === 'bad')?.url).toBe('invalid-url');
    expect(v.entries.map((e) => [e.name, e.scope])).toEqual([['ctx', 'user'], ['bad', 'user'], ['loc', 'local'], ['proj', 'project']]);
    expect(v.entries[0]).toMatchObject({ command: 'npx', args: ['-y', 'ctx', '--api-key', '••••', 'TOKEN=••••'], env: { K: '••••' }, transport: 'stdio' });
    expect(v.entries[2]).toMatchObject({ transport: 'http', headers: { Authorization: '••••' } });

    const vNoRoot = await readNativeMcp('claude-code', undefined, { home: h });
    expect(vNoRoot.entries.map((e) => [e.name, e.scope])).toEqual([['ctx', 'user'], ['bad', 'user'], ['loc', 'local']]);
    expect(vNoRoot.entries[2]?.file).toContain(root);
  });

  it('missing files → empty; parse errors → errors[]; opencode JSONC + command array', async () => {
    const { h } = home();
    expect(await readNativeMcp('cursor', undefined, { home: h })).toEqual({ entries: [] });
    mkdirSync(join(h, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(h, '.config', 'opencode', 'opencode.json'), '{ // c\n "mcp": { "o": { "type": "local", "command": ["npx", "x"], "environment": {"A":"b"}, "enabled": false, }, }, }');
    const v = await readNativeMcp('opencode', undefined, { home: h });
    expect(v.entries[0]).toMatchObject({ name: 'o', command: 'npx', args: ['x'], env: { A: '••••' }, enabled: false, transport: 'local' });
    mkdirSync(join(h, '.qwen'));
    writeFileSync(join(h, '.qwen', 'settings.json'), '{bad');
    expect((await readNativeMcp('qwen', undefined, { home: h })).errors).toHaveLength(1);
  });

  it('CLI sources: codex array, openclaw preamble, hermes raw masked', async () => {
    const { h } = home();
    const codex = await readNativeMcp('codex', undefined, {
      home: h,
      run: async () => JSON.stringify([{ name: 'r', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['a'], env: { X: 'y' } } }]),
    });
    expect(codex.entries[0]).toMatchObject({ name: 'r', command: 'npx', transport: 'stdio', env: { X: '••••' } });
    const claw = await readNativeMcp('openclaw', undefined, { home: h, run: async () => '◇ warn {x}\n{"mcpServers":{"c":{"command":"t"}}}' });
    expect(claw.entries.map((e) => e.name)).toEqual(['c']);
    const hermes = await readNativeMcp('hermes', undefined, { home: h, run: async () => 'srv  token=abc123  Bearer qqq' });
    expect(hermes.raw).not.toMatch(/abc123|qqq/);
  });

  it('helpers', () => {
    expect(maskArgs(['-H', 'Authorization: x', '--token=t', 'plain'])).toEqual(['-H', '••••', '--token=••••', 'plain']);
    expect(JSON.parse(stripJsonc('{"a":"//not a comment", /* x */ "b":1,}'))).toEqual({ a: '//not a comment', b: 1 });
    expect(maskUrl('https://user:secret@host/mcp')).toBe('https://user:••••@host/mcp');
    expect(maskUrl('https://host/mcp?token=xyz&api_key=123&normal=abc')).toBe('https://host/mcp?token=••••&api_key=••••&normal=abc');
    expect(maskUrl('invalid-url-string ::: //')).toBe('invalid-url');
  });

  describe('write-through native MCP config (WP-2.2)', () => {
    it('1. claude-code user install into temp HOME: placeholders, no secret in file or result', async () => {
      const { h } = home();
      const row = {
        id: 'everything',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'srv'],
        env: [
          { key: 'PROBE_SECRET', secret: true },
          { key: 'NORMAL_VAR', secret: false, value: 'plain_val' },
        ],
        headers: [],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };

      const res = await installNativeMcp('claude-code', row, {
        env: { PROBE_SECRET: 'real-secret-12345' },
        headers: {},
      }, { scope: 'user', home: h });

      expect(res.ok).toBe(true);
      expect(res.secrets).toBe('placeholders');
      expect(res.placeholderVars).toEqual(['PROBE_SECRET']);
      expect(res.overwrote).toBe(false);

      const filePath = join(h, '.claude.json');
      const content = readFileSync(filePath, 'utf8');
      expect(content).toContain('${PROBE_SECRET}');
      expect(content).toContain('plain_val');
      expect(content).not.toContain('real-secret-12345');

      const parsed = JSON.parse(content);
      expect(parsed.mcpServers.everything).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'srv'],
        env: {
          PROBE_SECRET: '${PROBE_SECRET}',
          NORMAL_VAR: 'plain_val',
        },
      });
      expect(JSON.stringify(res)).not.toContain('real-secret-12345');
    });

    it('2. install into existing file: preserves unrelated keys, creates .bak, overwrote flag, mode 0600', async () => {
      const { h } = home();
      const cursorDir = join(h, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      const targetPath = join(cursorDir, 'mcp.json');
      const initialJson = {
        otherSetting: true,
        mcpServers: {
          existingServer: { command: 'node', args: ['existing.js'] },
        },
      };
      writeFileSync(targetPath, JSON.stringify(initialJson, null, 2));

      const row = {
        id: 'srv1',
        transport: 'stdio' as const,
        command: 'python',
        args: ['mcp.py'],
        env: [],
        headers: [],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };

      const res1 = await installNativeMcp('cursor', row, { env: {}, headers: {} }, { scope: 'user', home: h });
      expect(res1.overwrote).toBe(false);
      expect(res1.backup).toMatch(new RegExp(`${targetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak-[0-9]+-[0-9a-f]+$`));
      expect(readFileSync(res1.backup!, 'utf8')).toContain('existingServer');

      const post1 = JSON.parse(readFileSync(targetPath, 'utf8'));
      expect(post1.otherSetting).toBe(true);
      expect(post1.mcpServers.existingServer).toBeDefined();
      expect(post1.mcpServers.srv1).toBeDefined();
      expect(statSync(targetPath).mode & 0o777).toBe(0o600);

      // Second install of same id -> overwrote: true
      const res2 = await installNativeMcp('cursor', row, { env: {}, headers: {} }, { scope: 'user', home: h });
      expect(res2.overwrote).toBe(true);
      expect(statSync(targetPath).mode & 0o777).toBe(0o600);
    });

    it('3. cursor stdio with copySecrets: true/false/missing', async () => {
      const { h } = home();
      const row = {
        id: 'cursor-sec',
        transport: 'stdio' as const,
        command: 'node',
        args: ['srv.js'],
        env: [{ key: 'API_KEY', secret: true }],
        headers: [],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };

      // Without copySecrets -> throws mentioning copySecrets
      await expect(
        installNativeMcp('cursor', row, { env: { API_KEY: 'secret-xyz-999' }, headers: {} }, { scope: 'user', home: h }),
      ).rejects.toThrowError(/copySecrets/);

      // With copySecrets but missing value -> throws listing key, file unchanged
      const targetPath = join(h, '.cursor', 'mcp.json');
      await expect(
        installNativeMcp('cursor', row, { env: {}, headers: {} }, { scope: 'user', home: h, copySecrets: true }),
      ).rejects.toThrowError(/missing secret value\(s\): env\/API_KEY/);
      expect(existsSync(targetPath)).toBe(false);

      // With copySecrets and value -> secret literal in file (0600), masked in result
      const res = await installNativeMcp(
        'cursor',
        row,
        { env: { API_KEY: 'secret-xyz-999' }, headers: {} },
        { scope: 'user', home: h, copySecrets: true },
      );
      expect(res.secrets).toBe('copied');
      expect(statSync(targetPath).mode & 0o777).toBe(0o600);

      const fileContent = readFileSync(targetPath, 'utf8');
      expect(fileContent).toContain('secret-xyz-999');
      expect(JSON.stringify(res)).not.toContain('secret-xyz-999');
      expect(res.entry.env?.API_KEY).toBe('••••');
    });

    it('4. opencode: stdio local + http remote shapes; qwen http throws', async () => {
      const { h } = home();
      const stdioRow = {
        id: 'local-srv',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['my-mcp', 'arg1'],
        env: [{ key: 'ENV1', secret: false, value: 'val1' }],
        headers: [],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };

      const resStdio = await installNativeMcp('opencode', stdioRow, { env: {}, headers: {} }, { scope: 'user', home: h });
      expect(resStdio.ok).toBe(true);
      const opencodePath = join(h, '.config', 'opencode', 'opencode.json');
      const opencodeJson = JSON.parse(readFileSync(opencodePath, 'utf8'));
      expect(opencodeJson.mcp['local-srv']).toEqual({
        type: 'local',
        command: ['npx', 'my-mcp', 'arg1'],
        enabled: true,
        environment: { ENV1: 'val1' },
      });

      const httpRow = {
        id: 'remote-srv',
        transport: 'http' as const,
        url: 'https://example.com/mcp',
        args: [],
        env: [],
        headers: [{ key: 'X-Plain', secret: false, value: 'plain-val' }],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };

      const resHttp = await installNativeMcp('opencode', httpRow, { env: {}, headers: {} }, { scope: 'user', home: h });
      expect(resHttp.ok).toBe(true);
      const opencodeJson2 = JSON.parse(readFileSync(opencodePath, 'utf8'));
      expect(opencodeJson2.mcp['remote-srv']).toEqual({
        type: 'remote',
        url: 'https://example.com/mcp',
        enabled: true,
        headers: { 'X-Plain': 'plain-val' },
      });

      // qwen http -> throws (unsupported transport)
      await expect(
        installNativeMcp('qwen', httpRow, { env: {}, headers: {} }, { scope: 'user', home: h }),
      ).rejects.toThrowError(/transport http not supported for qwen/);
    });

    it('5. header placeholder naming: X-Api-Key on claude-code http', async () => {
      const { h } = home();
      const httpRow = {
        id: 'api-srv',
        transport: 'http' as const,
        url: 'https://api.example.com/mcp',
        args: [],
        env: [],
        headers: [{ key: 'X-Api-Key', secret: true }],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };

      const res = await installNativeMcp(
        'claude-code',
        httpRow,
        { env: {}, headers: { 'X-Api-Key': 'real-key-val' } },
        { scope: 'user', home: h },
      );
      expect(res.placeholderVars).toEqual(['X_API_KEY']);

      const parsed = JSON.parse(readFileSync(join(h, '.claude.json'), 'utf8'));
      expect(parsed.mcpServers['api-srv'].headers['X-Api-Key']).toBe('${X_API_KEY}');
      expect(readFileSync(join(h, '.claude.json'), 'utf8')).not.toContain('real-key-val');
    });

    it('6. JSONC refusal: opencode user file containing comments', async () => {
      const { h } = home();
      const cfgDir = join(h, '.config', 'opencode');
      mkdirSync(cfgDir, { recursive: true });
      const cfgPath = join(cfgDir, 'opencode.json');
      const commentContent = '{\n  // important user comment\n  "mcp": {}\n}';
      writeFileSync(cfgPath, commentContent);

      const row = {
        id: 'srv',
        transport: 'stdio' as const,
        command: 'true',
        args: [],
        env: [],
        headers: [],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };

      await expect(
        installNativeMcp('opencode', row, { env: {}, headers: {} }, { scope: 'user', home: h }),
      ).rejects.toThrowError(/file contains JSONC comments that would be lost/);

      expect(readFileSync(cfgPath, 'utf8')).toBe(commentContent);
    });

    it('7. removeNativeMcp removes named key, creates .bak, 404 on absent key, works on opencode .mcp', async () => {
      const { h } = home();
      const row = {
        id: 'to-remove',
        transport: 'stdio' as const,
        command: 'true',
        args: [],
        env: [],
        headers: [],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };
      await installNativeMcp('opencode', row, { env: {}, headers: {} }, { scope: 'user', home: h });

      const cfgPath = join(h, '.config', 'opencode', 'opencode.json');
      expect(JSON.parse(readFileSync(cfgPath, 'utf8')).mcp['to-remove']).toBeDefined();

      const removeRes = await removeNativeMcp('opencode', 'to-remove', { scope: 'user', home: h });
      expect(removeRes.ok).toBe(true);
      expect(removeRes.backup).toMatch(/opencode\.json\.bak-[0-9]+-[0-9a-f]+$/);
      expect(JSON.parse(readFileSync(cfgPath, 'utf8')).mcp['to-remove']).toBeUndefined();
      expect(readFileSync(removeRes.backup!, 'utf8')).toContain('to-remove');

      // Removing absent key -> 404
      await expect(
        removeNativeMcp('opencode', 'to-remove', { scope: 'user', home: h }),
      ).rejects.toThrowError(/not found in native config/);
    });

    it('refuses a symlinked .mcp.json and does not touch the outside file', async () => {
      const { h, root } = home();
      const outside = join(h, 'outside-auth.json');
      writeFileSync(outside, '{"keep":true}\n');
      symlinkSync(outside, join(root, '.mcp.json'));
      const row = {
        id: 'x',
        transport: 'stdio' as const,
        command: 'true',
        args: [],
        env: [],
        headers: [],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };
      await expect(
        installNativeMcp('claude-code', row, { env: {}, headers: {} }, { scope: 'project', root, home: h }),
      ).rejects.toMatchObject({ status: 400 });
      expect(readFileSync(outside, 'utf8')).toBe('{"keep":true}\n');
    });

    it('ignores a pre-planted .mcp.json.bak symlink', async () => {
      const { h, root } = home();
      const victim = join(h, 'victim.json');
      writeFileSync(victim, 'victim\n');
      symlinkSync(victim, join(root, '.mcp.json.bak'));
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { old: { command: 'true' } } }));
      const row = {
        id: 'x',
        transport: 'stdio' as const,
        command: 'true',
        args: [],
        env: [],
        headers: [],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };
      const res = await installNativeMcp('claude-code', row, { env: {}, headers: {} }, { scope: 'project', root, home: h });
      expect(res.ok).toBe(true);
      expect(readFileSync(victim, 'utf8')).toBe('victim\n');
    });

    it('does not mkdir through a missing parent whose ancestor is a symlink outside the root', async () => {
      const { h, root } = home();
      const outside = join(h, 'out');
      mkdirSync(outside);
      symlinkSync(outside, join(root, 'link'));
      await expect(
        mergeNativeFile(join(root, 'link', 'newdir', 'x.json'), () => true, { root }),
      ).rejects.toBeInstanceOf(NativeWriteError);
      expect(existsSync(join(outside, 'newdir'))).toBe(false);
    });

    it('refuses when a project directory component is a symlink outside the root', async () => {
      const { h, root } = home();
      const outside = join(h, 'outside-cursor');
      mkdirSync(outside);
      symlinkSync(outside, join(root, '.cursor'));
      const row = {
        id: 'x',
        transport: 'stdio' as const,
        command: 'true',
        args: [],
        env: [],
        headers: [],
        enabled: true,
        allowInDelegating: false,
        agentTypes: null,
        createdAt: 1000,
        updatedAt: 1000,
      };
      await expect(
        installNativeMcp('cursor', row, { env: {}, headers: {} }, { scope: 'project', root, home: h }),
      ).rejects.toBeInstanceOf(NativeWriteError);
    });
  });
});
