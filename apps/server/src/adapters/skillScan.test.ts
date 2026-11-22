import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSkillFrontmatter, scanSkillDir, scanSkillDirs, scanGeminiPluginSkills } from './skillScan.js';

describe('skillScan', () => {
  it('parseSkillFrontmatter extracts name and description', () => {
    const content = `---
name: find-skills
description: Helps users discover skills
---
# Body
`;
    expect(parseSkillFrontmatter(content)).toEqual({
      name: 'find-skills',
      description: 'Helps users discover skills',
    });
  });

  it('scanSkillDir reads SKILL.md directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'tierwyn-skills-'));
    const skillDir = join(root, 'find-skills');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: find-skills
description: Discover skills
---
`);
    const cmds = scanSkillDir(root);
    expect(cmds).toEqual([{
      name: 'find-skills',
      label: 'find-skills',
      description: 'Discover skills',
      sourceDetail: 'skill',
    }]);
  });

  it('scanSkillDirs dedupes by name', () => {
    const a = mkdtempSync(join(tmpdir(), 'tierwyn-a-'));
    const b = mkdtempSync(join(tmpdir(), 'tierwyn-b-'));
    for (const root of [a, b]) {
      const skillDir = join(root, 'dup');
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: dup
description: first
---
`);
    }
    writeFileSync(join(join(b, 'dup'), 'SKILL.md'), `---
name: dup
description: second
---
`);
    const cmds = scanSkillDirs([a, b]);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].description).toBe('first');
  });

  it('scanGeminiPluginSkills discovers skills inside plugin folders', () => {
    const pluginsRoot = mkdtempSync(join(tmpdir(), 'tierwyn-plugins-'));
    const pluginA = join(pluginsRoot, 'plugin-a', 'skills', 'skill-1');
    mkdirSync(pluginA, { recursive: true });
    writeFileSync(join(pluginA, 'SKILL.md'), `---
name: skill-1
description: Skill from plugin A
---
`);
    const cmds = scanGeminiPluginSkills(pluginsRoot);
    expect(cmds).toEqual([{
      name: 'skill-1',
      label: 'skill-1',
      description: 'Skill from plugin A',
      sourceDetail: 'skill',
    }]);
  });
});
