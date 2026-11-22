import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { CommandDescriptor } from '@tierwyn/shared';

export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const frontmatter = match[1];
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

export function scanSkillDir(dir: string): CommandDescriptor[] {
  if (!existsSync(dir)) return [];
  const out: CommandDescriptor[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const fm = parseSkillFrontmatter(content);
      const name = fm.name ?? entry.name;
      out.push({
        name,
        label: name,
        description: fm.description ?? '',
        sourceDetail: 'skill',
      });
    } catch {
      // skip unreadable entries
    }
  }
  return out;
}

/** Scan multiple directories; first occurrence wins for duplicate names. */
export function scanSkillDirs(dirs: string[]): CommandDescriptor[] {
  const seen = new Set<string>();
  const out: CommandDescriptor[] = [];
  for (const dir of dirs) {
    for (const cmd of scanSkillDir(dir)) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      out.push(cmd);
    }
  }
  return out;
}

/** Walk claude plugin cache: plugins/cache/<marketplace>/<plugin>/<version>/skills/ */
export function walkPluginSkillCache(pluginsCacheDir: string): CommandDescriptor[] {
  if (!existsSync(pluginsCacheDir)) return [];
  const out: CommandDescriptor[] = [];
  const seen = new Set<string>();
  const walk = (dir: string) => {
    for (const cmd of scanSkillDir(dir)) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      out.push(cmd);
    }
  };
  try {
    for (const marketplace of readdirSync(pluginsCacheDir, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue;
      const marketplaceDir = join(pluginsCacheDir, marketplace.name);
      for (const plugin of readdirSync(marketplaceDir, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const pluginDir = join(marketplaceDir, plugin.name);
        for (const version of readdirSync(pluginDir, { withFileTypes: true })) {
          if (!version.isDirectory()) continue;
          walk(join(pluginDir, version.name, 'skills'));
        }
      }
    }
  } catch {
    // best-effort — malformed cache layout
  }
  return out;
}

/** Walk Gemini/Antigravity plugin directory: config/plugins/<plugin>/skills/ */
export function scanGeminiPluginSkills(pluginsDir: string): CommandDescriptor[] {
  if (!existsSync(pluginsDir)) return [];
  const out: CommandDescriptor[] = [];
  const seen = new Set<string>();
  try {
    for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!plugin.isDirectory() && !plugin.isSymbolicLink()) continue;
      const skillsDir = join(pluginsDir, plugin.name, 'skills');
      for (const cmd of scanSkillDir(skillsDir)) {
        if (seen.has(cmd.name)) continue;
        seen.add(cmd.name);
        out.push(cmd);
      }
    }
  } catch {
    // best-effort
  }
  return out;
}

/** Scan opencode command templates: flat *.md files with YAML frontmatter. */
export function scanCommandTemplateDir(dir: string): CommandDescriptor[] {
  if (!existsSync(dir)) return [];
  const out: CommandDescriptor[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.replace(/\.md$/, '');
    try {
      const content = readFileSync(join(dir, entry.name), 'utf-8');
      const fm = parseSkillFrontmatter(content);
      out.push({
        name: fm.name ?? name,
        label: fm.name ?? name,
        description: fm.description ?? '',
        sourceDetail: 'command-template',
      });
    } catch {
      out.push({ name, label: name, description: '', sourceDetail: 'command-template' });
    }
  }
  return out;
}
