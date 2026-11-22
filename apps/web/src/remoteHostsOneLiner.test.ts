import { describe, expect, it } from 'vitest';
import { pickOneLiner, remoteSelectableTypes, withAgentFlags } from './remoteHostsOneLiner';

const github = 'curl -fsSL https://raw.githubusercontent.com/tierwyn/tierwyn/main/scripts/install.sh | bash -s -- node enroll --hub H --token T';
const hub = 'curl -fsSL https://hub.example/node/install.sh | bash -s -- node enroll --hub H --token T';
const base = github;

describe('withAgentFlags', () => {
  it('later / empty → unchanged', () => {
    expect(withAgentFlags(base, 'later')).toBe(base);
    expect(withAgentFlags(base, [])).toBe(base);
  });
  it('all', () => expect(withAgentFlags(base, 'all')).toBe(`${base} --all-agents`));
  it('list is deduped and sorted', () => {
    expect(withAgentFlags(base, ['codex', 'claude-code', 'codex'])).toBe(`${base} --agents claude-code,codex`);
  });
  it('strips grok-bot and unsafe names', () => {
    expect(withAgentFlags(base, ['grok-bot', 'Bad;rm', 'codex'])).toBe(`${base} --agents codex`);
  });
});

describe('pickOneLiner', () => {
  it('hub form when fromGithub is false', () => {
    expect(pickOneLiner({ oneLiner: hub, oneLinerGithub: github }, false)).toBe(hub);
  });
  it('GitHub form when fromGithub is true', () => {
    expect(pickOneLiner({ oneLiner: hub, oneLinerGithub: github }, true)).toBe(github);
  });
});

describe('withAgentFlags on both forms', () => {
  it('appends to hub one-liner', () => {
    expect(withAgentFlags(hub, 'all')).toBe(`${hub} --all-agents`);
  });
  it('appends to GitHub one-liner', () => {
    expect(withAgentFlags(github, ['codex'])).toBe(`${github} --agents codex`);
  });
});

describe('remoteSelectableTypes', () => {
  it('drops grok-bot and dupes', () => {
    expect(remoteSelectableTypes([{ type: 'grok-bot' }, { type: 'codex' }, { type: 'codex' }])).toEqual(['codex']);
  });
});
