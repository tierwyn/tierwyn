import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { discoverInstalledAgents, binaryOnPath, INSTALL_HINTS, AGENT_BINARIES, DYNAMIC_MODEL_DISCOVERY } from './discovery.js';

function db() {
  const d = new Database(':memory:');
  runMigrations(d, migrations);
  return d;
}

describe('binaryOnPath', () => {
  it('treats an explicit path as installed when the file exists', () => {
    expect(binaryOnPath('/usr/bin/agy', (p) => p === '/usr/bin/agy')).toBe(true);
    expect(binaryOnPath('/usr/bin/agy', () => false)).toBe(false);
  });

  it('scans PATH dirs for a bare binary name', () => {
    const exists = (p: string) => p === '/opt/bin/opencode';
    const prev = process.env.PATH;
    process.env.PATH = '/usr/bin:/opt/bin';
    try {
      expect(binaryOnPath('opencode', exists)).toBe(true);
      expect(binaryOnPath('missing', exists)).toBe(false);
    } finally { process.env.PATH = prev; }
  });
});

describe('discoverInstalledAgents', () => {
  it('reports every known agent type with an install hint when missing', () => {
    const out = discoverInstalledAgents(db(), () => false);
    const byType = new Map(out.map((o) => [o.agentType, o]));
    for (const type of Object.keys(INSTALL_HINTS)) {
      expect(byType.get(type)?.installed).toBe(false);
      expect(byType.get(type)?.installHint).toBe(INSTALL_HINTS[type]);
    }
  });

  it('marks an agent installed and drops its hint when the binary is present', () => {
    const exists = (p: string) => p.endsWith('/agy');
    const prev = process.env.PATH;
    process.env.PATH = '/usr/local/bin';
    try {
      const info = discoverInstalledAgents(db(), exists).find((o) => o.agentType === 'antigravity');
      expect(info?.installed).toBe(true);
      expect(info?.installHint).toBeUndefined();
    } finally { process.env.PATH = prev; }
  });

  it("honours a stored agent's executable_path override", () => {
    const d = db();
    d.prepare(
      `INSERT INTO agents (id,type,label,description,executable_path,env_vars,created_at)
       VALUES ('opencode','opencode','OpenCode','',@p,'{}',0)`
    ).run({ p: '/custom/oc' });
    const exists = (p: string) => p === '/custom/oc';
    const info = discoverInstalledAgents(d, exists).find((o) => o.agentType === 'opencode');
    expect(info?.installed).toBe(true);
  });

  it('executable_path overrides the default binary name for the enable probe', () => {
    const d = db();
    d.prepare(
      `INSERT INTO agents (id,type,label,description,executable_path,env_vars,created_at)
       VALUES ('opencode','opencode','OpenCode','',@p,'{}',0)`,
    ).run({ p: process.execPath });
    const info = discoverInstalledAgents(d).find((o) => o.agentType === 'opencode');
    expect(info?.installed).toBe(true);
  });
});

describe('DYNAMIC_MODEL_DISCOVERY', () => {
  it('marks claude-code, pi, antigravity, opencode as dynamic', () => {
    expect(DYNAMIC_MODEL_DISCOVERY['claude-code']).toBe(true);
    expect(DYNAMIC_MODEL_DISCOVERY['pi']).toBe(true);
    expect(DYNAMIC_MODEL_DISCOVERY['antigravity']).toBe(true);
    expect(DYNAMIC_MODEL_DISCOVERY['opencode']).toBe(true);
  });

  it('marks cursor, codex, hermes as dynamic', () => {
    expect(DYNAMIC_MODEL_DISCOVERY['cursor']).toBe(true);
    expect(DYNAMIC_MODEL_DISCOVERY['codex']).toBe(true);
    expect(DYNAMIC_MODEL_DISCOVERY['hermes']).toBe(true);
  });

  it('covers every type in AGENT_BINARIES', () => {
    for (const type of Object.keys(AGENT_BINARIES)) {
      expect(DYNAMIC_MODEL_DISCOVERY[type]).toBeDefined();
    }
  });

  it('grok-build supports dynamic model discovery via the on-disk models cache', () => {
    expect(DYNAMIC_MODEL_DISCOVERY['grok-build']).toBe(true);
  });

  it('kiro supports dynamic model discovery via kiro-cli --list-models', () => {
    expect(DYNAMIC_MODEL_DISCOVERY['kiro']).toBe(true);
    expect(AGENT_BINARIES.kiro.bin).toBe('kiro-cli');
  });

  it('qwen supports dynamic model discovery via ACP session/new', () => {
    expect(DYNAMIC_MODEL_DISCOVERY['qwen']).toBe(true);
    expect(AGENT_BINARIES.qwen.bin).toBe('qwen');
  });

  it('kimi supports dynamic model discovery via ACP session/new configOptions', () => {
    expect(DYNAMIC_MODEL_DISCOVERY['kimi']).toBe(true);
    expect(AGENT_BINARIES.kimi.bin).toBe('kimi');
  });

  it('copilot is seed-only (no CLI model-list command)', () => {
    expect(DYNAMIC_MODEL_DISCOVERY['copilot']).toBe(false);
    expect(AGENT_BINARIES.copilot.bin).toBe('copilot');
  });

  it('grok-bot supports dynamic model discovery via CDP roster and probes the absolute desktop binary', () => {
    expect(DYNAMIC_MODEL_DISCOVERY['grok-bot']).toBe(true);
    expect(AGENT_BINARIES['grok-bot'].bin).toBe('/opt/Grok Bot/grok-bot');
  });

  it('deepseek is seed-only (no CLI model-list command) and tracks @deepseek-ai/dsh for latest', () => {
    expect(DYNAMIC_MODEL_DISCOVERY['deepseek']).toBe(false);
    expect(AGENT_BINARIES.deepseek.bin).toBe('dsh');
    expect(AGENT_BINARIES.deepseek.pkg).toBe('@deepseek-ai/dsh');
  });
});

describe('AGENT_BINARIES install commands (run by scripts/install.sh on operator request)', () => {
  it('are only `npm i -g <pkg>`, a vendor `curl -fsSL https://… | bash`, or the latter prefixed by an rm -f of quoted $HOME paths (non-interactive pre-clean) — nothing else gets executed', () => {
    for (const [type, a] of Object.entries(AGENT_BINARIES)) {
      if (!a.install) continue;
      // The optional rm -f prefix mirrors the vendor installer's own "replace it? (y)"
      // branch (kiro reads the answer from /dev/tty, which non-interactive installs lack).
      // Paths must be quoted, $HOME-relative (no ..), and contain no metacharacters.
      expect(a.install, type).toMatch(/^(rm -f ("\$HOME\/(?!.*\.\.)[^";`]*")( "\$HOME\/(?!.*\.\.)[^";`]*")*; )*(npm i -g (@[a-z0-9-]+\/)?[a-z0-9.-]+(@latest)?|curl -fsSL https:\/\/[^\s|;&$`]+ \| bash( -s -- --[a-z-]+)?)$/);
    }
  });

  it('points pi at @earendil-works/pi-coding-agent', () => {
    expect(AGENT_BINARIES.pi.install).toBe('npm i -g @earendil-works/pi-coding-agent');
    expect(AGENT_BINARIES.pi.pkg).toBe('@earendil-works/pi-coding-agent');
  });

  it('validates version sources: pkg, releasesRepo, and grok-bot noVersion', () => {
    const pkgRegex = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9.-]*$/;
    const repoRegex = /^[\w.-]+\/[\w.-]+$/;

    for (const [type, a] of Object.entries(AGENT_BINARIES)) {
      if (a.pkg) {
        expect(a.pkg, `${type} pkg`).toMatch(pkgRegex);
      }
      if (a.releasesRepo) {
        expect(a.releasesRepo, `${type} releasesRepo`).toMatch(repoRegex);
      }
    }

    expect(AGENT_BINARIES['grok-bot'].noVersion).toBe(true);
    expect(AGENT_BINARIES['grok-bot'].pkg).toBeUndefined();
    expect(AGENT_BINARIES['grok-bot'].releasesRepo).toBeUndefined();
  });

  it('declares unzip as a prerequisite for kiro and validates all prereq binary names', () => {
    expect(AGENT_BINARIES.kiro.prereqs).toEqual(['unzip']);
    // Installer prompts "replace it?" via /dev/tty when existing binaries are present —
    // installs run non-interactively, so the command must pre-clean them first.
    expect(AGENT_BINARIES.kiro.install).toContain("rm -f \"$HOME/.local/bin/kiro-cli\"");
    // --force skips the installer's `q` (Amazon Q) shim branch, which would run `q update`
    // against the kiro-cli we just removed and fail.
    expect(AGENT_BINARIES.kiro.install).toMatch(/\| bash -s -- --force$/);
    for (const [type, a] of Object.entries(AGENT_BINARIES)) {
      for (const bin of a.prereqs ?? []) {
        expect(bin, `${type} prereq`).toMatch(/^[a-z0-9][a-z0-9._+-]*$/);
      }
    }
  });
});

