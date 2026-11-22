import { describe, it, expect } from 'vitest';
import {
  buildDelegationPreamble,
  buildDelegationStub,
  buildScheduleOnlyPreamble,
  buildScheduleOnlyStub,
  pluginRosterLines,
  filterAgentPlugins,
  scopeAgentPlugins,
  spawnFpPayload,
  searchFpExtra,
  filterRolesForMode,
  DEFAULT_DELEGATION_INSTRUCTIONS,
} from './preamble.js';
import { makeFingerprint } from './preamble-mode.js';
import type { AgentSearchScopeSetting, ResolvedAgentSearchScope } from '@tierwyn/shared';

function ss(
  effective: AgentSearchScopeSetting,
  extra: { capped?: boolean; source?: 'project' | 'global' } = {},
): ResolvedAgentSearchScope {
  return {
    effective,
    source: extra.source ?? 'global',
    cappedBySandbox: extra.capped ?? false,
  };
}

describe('buildDelegationPreamble', () => {
  const template = {
    name: 'team',
    roles: [
      { role: 'reviewer', profileId: 'claude-code:opus', when: 'deep correctness review' },
      { role: 'Master planner', profileId: 'claude-code:opus-4.8', when: 'writing specs' },
    ],
  };

  it('omits the mesh awareness block when off, and names GET /agent/mesh/peers when subtree', () => {
    const off = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(off).not.toContain('/agent/mesh/peers');
    const on = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787,
      meshAwareness: 'subtree',
    });
    expect(on).toContain('GET http://127.0.0.1:8787/agent/mesh/peers');
    expect(on).toContain('Do not poll');
    expect(on).not.toContain('Peer messaging is on');
    const msg = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787,
      meshAwareness: 'subtree', meshMessaging: 'tree',
    });
    expect(msg).toContain('Peer messaging is on');
  });

  it('does not tell the agent parent-messaging is impossible while the mesh block grants it', () => {
    // Regression: the default block used to assert "You CANNOT message your
    // parent over HTTP … it will 401/403" while /agent/mesh/peers was
    // simultaneously reporting relation:"parent" with canMessage:true. An agent
    // reading both had no way to act.
    const base = { template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 } as const;
    const off = buildDelegationPreamble({ ...base });
    expect(off).not.toContain('CANNOT message your parent');
    expect(off).not.toContain('STRICT DESCENDANTS');

    const on = buildDelegationPreamble({ ...base, meshAwareness: 'subtree', meshMessaging: 'tree' });
    expect(on).toContain('relation: "parent"');
    expect(on).toContain('canMessage: true');
    const childOn = buildDelegationPreamble({
      ...base, meshAwareness: 'subtree', meshMessaging: 'tree',
      selfConversationId: 'child-aaa', selfParentConversationId: 'parent-bbb',
    });
    expect(childOn).toContain('unless a specific upward permission has been granted');
    expect(childOn).toContain('relation: "parent"');
  });

  it('renders the capability routing roster in all four builders when plugins are passed', () => {
    const plugins = [
      {
        id: 'gemini-image',
        name: 'Gemini Image',
        help: '/agent/plugins/gemini-image/help',
        capabilities: [
          { name: 'image.generate', summary: 'Generate or remix images: wallpapers, illustrations, photos, icons, and image edits' },
        ],
      },
      {
        id: 'zai-usage',
        name: 'Z.ai Usage',
        capabilities: [{ name: 'usage.get', summary: 'Current Z.ai quota windows (5h and 7d token limits)' }],
      },
    ];
    const full = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787, plugins,
    });
    expect(full).toContain("Tierwyn server capabilities (enabled here — not your harness's plugins or skills)");
    expect(full).toContain('Prefer these over any local skill or CLI tool that requires its own API key.');
    expect(full).toContain('- gemini-image · image.generate — Generate or remix images: wallpapers, illustrations, photos, icons, and image edits');
    expect(full).toContain('GET http://127.0.0.1:8787/agent/plugins/gemini-image/help');
    // Plugins without a help doc must not emit a broken help link.
    expect(full).not.toContain('GET http://127.0.0.1:8787/agent/plugins/zai-usage/help');

    // Schedule-only conversations carry the same roster (CONVERSATION_CAPABILITIES
    // grants `plugin` to every token-carrying conversation).
    const sched = buildScheduleOnlyPreamble({ projectId: 'p', token: 't', port: 8787, plugins });
    expect(sched).toContain('Tierwyn server capabilities');
    expect(sched).toContain('- zai-usage · usage.get — Current Z.ai quota windows (5h and 7d token limits)');
    expect(sched).toContain('GET http://127.0.0.1:8787/agent/plugins/gemini-image/help');
    expect(sched).not.toContain('GET http://127.0.0.1:8787/agent/plugins/zai-usage/help');

    // Stubs collapse to a name-only one-liner (no summary re-print).
    const stub = buildDelegationStub({ parentConversationId: 'C1', spawnToken: 'tok', port: 8787, plugins });
    expect(stub).toContain('gemini-image·image.generate, zai-usage·usage.get');
    expect(stub).not.toContain('wallpapers');
    const schedStub = buildScheduleOnlyStub({ projectId: 'p', token: 't', port: 8787, plugins });
    expect(schedStub).toContain('gemini-image·image.generate');
    expect(schedStub).toContain('/agent/plugins/<id>/help');
  });

  it('renders no capabilities block when the server exposes zero agent-callable capabilities', () => {
    const empty = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787,
      plugins: [{ id: 'hollow', name: 'Hollow', capabilities: [] }],
    });
    expect(empty).not.toContain('Tierwyn server capabilities');
    expect(empty).not.toContain('/agent/plugins');
    const none = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(none).not.toContain('/agent/plugins');
    expect(buildScheduleOnlyPreamble({ projectId: 'p', token: 't', port: 8787 })).not.toContain('/agent/plugins');
    expect(buildScheduleOnlyStub({ projectId: 'p', token: 't', port: 8787 })).not.toContain('/agent/plugins');
  });

  it('lists every role with its when-hint', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).toContain('reviewer');
    expect(out).toContain('deep correctness review');
    expect(out).toContain('Master planner');
    expect(out).toContain('writing specs');
  });

  it('tells the agent the roster is a hard allow-list enforced by the server', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).toContain('hard allow-list');
    expect(out).toContain('Spawn only a **role**');
    expect(out).not.toContain('profile not in parent template roster');
    expect(out).not.toContain('parent has no spawn template');
    expect(out).toContain('GET /agent/help/spawn');
    // Present even when custom delegationInstructions replace the default block.
    const custom = buildDelegationPreamble({
      template: { ...template, delegationInstructions: 'Custom only.' },
      parentConversationId: 'C1',
      spawnToken: 'tok',
      port: 8787,
    });
    expect(custom).toContain('hard allow-list');
    expect(custom).toContain('Custom only.');
  });

  it('embeds the raw-body curl recipe with parent id and token substituted', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).toContain('/spawn/raw');
    expect(out).toContain('--data-binary @');
    expect(out).toContain('X-Spawn-Parent: C1');
    expect(out).toContain('Bearer tok');
    expect(out).toContain('The Bearer is session-scoped');
    expect(out).toContain('never one copied from an earlier tool call');
    expect(out).not.toContain('"prompt": "REPLACE');
  });

  it('includes approval note when spawnApprovalRequired is true', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787, spawnApprovalRequired: true });
    expect(out).toContain('Spawn approval is ON');
    expect(out).toContain('202 { requestId, status: "pending" }');
    expect(out).toContain('Do not retry or treat the 202 as an error');
  });

  it('omits approval note when spawnApprovalRequired is false', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787, spawnApprovalRequired: false });
    expect(out).not.toContain('Spawn approval is ON');
    expect(out).not.toContain('202 { requestId, status: "pending" }');
  });

  it('omits approval note when spawnApprovalRequired is omitted (default)', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).not.toContain('Spawn approval is ON');
  });

  it('renders parent-profile line when parentProfileLabel is provided', () => {
    const out = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787,
      parentProfileLabel: 'Claude Sonnet 4.5',
    });
    expect(out).toContain('_Your parent conversation is running as Claude Sonnet 4.5._');
  });

  it('omits parent-profile line when parentProfileLabel is not provided', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).not.toContain('Your parent conversation is running as');
  });

  it('appends short schedule pointer when scheduleCreate is passed', () => {
    const out = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787,
      scheduleCreate: { projectId: 'proj-xyz' },
    });
    expect(out).toContain('## Scheduler (opt-in — not a standing task)');
    expect(out).toContain('unless the operator asked to schedule');
    expect(out).toContain('Spawn is preferred for immediate work');
    expect(out).toContain('Do not GET schedule-help unless you are about to create');
    expect(out).toContain('GET http://127.0.0.1:8787/agent/schedule-help');
    expect(out).toContain('POST http://127.0.0.1:8787/projects/proj-xyz/schedules/agent');
    expect(out).toContain('Bearer <same spawn token>');
    // Must stay short — no second multi-line curl --data-binary dump for schedules.
    expect(out).not.toMatch(/schedules\/agent[\s\S]*--data-binary/);
  });

  it('omits schedule pointer when scheduleCreate is absent', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).not.toContain('## Scheduler (opt-in — not a standing task)');
    expect(out).not.toContain('/agent/schedule-help');
    expect(out).not.toContain('/schedules/agent');
  });

  it('teaches child/delegate one-shot upstream recovery only on child preambles', () => {
    const root = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(root).not.toContain('ONE-SHOT');
    expect(root).not.toContain('STRICT DESCENDANTS');
    expect(root).toContain('Mid-turn narration');
    const child = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787,
      selfConversationId: 'child-aaa', selfParentConversationId: 'parent-bbb',
    });
    expect(child).toContain('-RESULT.md');
    expect(child).toContain('ONE-SHOT');
    expect(child).toContain('STRICT DESCENDANTS');
    expect(child).toContain('child-aaa');
    expect(child).toContain('parent-bbb');
  });

  it('forbids parent sleep/timer-polling of children when async notify is in use', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).toContain('end your turn');
    expect(out).toMatch(/Do \*\*not\*\* `sleep`/i);
    expect(out).toContain('upstream notify');
    expect(out).toContain('not on a polling loop');
    // Present even when custom delegationInstructions replace the default block.
    const custom = buildDelegationPreamble({
      template: { ...template, delegationInstructions: 'Custom only.' },
      parentConversationId: 'C1',
      spawnToken: 'tok',
      port: 8787,
    });
    expect(custom).toContain('not on a polling loop');
    expect(custom).toContain('Custom only.');
  });

  it('injects self + parent conversation ids when both are provided', () => {
    const out = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787,
      selfConversationId: 'child-aaa',
      selfParentConversationId: 'parent-bbb',
    });
    expect(out).toContain('child-aaa');
    expect(out).toContain('parent-bbb');
    expect(out).toContain('Cite these in your ## Result');
  });

  it('omits self/parent id line when ids are absent (roots)', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).not.toContain('Cite these in your ## Result');
  });

  it('lists the designation catalogue and optional spawn header when designations are passed', () => {
    const out = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787,
      designations: ['orchestrator', 'planner', 'implementer', 'reviewer', 'research', 'auditor'],
    });
    expect(out).toContain('Optional designation');
    expect(out).toContain('orchestrator, planner, implementer, reviewer, research, auditor');
    expect(out).toContain('X-Spawn-Designation');
    expect(out).toContain('"designation"');
    expect(out).toContain('Do not invent spellings');
  });

  it('omits the designation block when the catalogue is absent', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).not.toContain('Optional designation');
    expect(out).not.toContain('X-Spawn-Designation');
  });

  it('injects the self id alone for root conversations — the mesh body needs it', () => {
    // Regression: a root coordinator has no parentConversationId, and the
    // /spawn/:id/message body requires parentConversationId = your OWN id.
    // Withholding the self id from roots left them unable to construct the
    // documented curl at all.
    const full = buildDelegationPreamble({
      template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787,
      selfConversationId: 'root-ccc',
    });
    expect(full).toContain('You are conversation `root-ccc`');
    expect(full).not.toContain('your parent is');
  });

  it('teaches child messaging via a pointer, not a full curl', () => {
    const out = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(out).toContain('## Messaging an existing child (switch profile, steer, or resume)');
    expect(out).toContain('POST /spawn/<childId>/message');
    expect(out).toContain('notifyParent:true');
    expect(out).toContain('GET /agent/help/messaging');
    expect(out).not.toContain('/spawn/CHILD_CONVERSATION_ID/message');
    expect(out).not.toContain('"handoff": "fresh" | "summary" | "transcript"');
  });

});

describe('buildScheduleOnlyPreamble', () => {
  it('gates create on explicit operator ask and does not treat lack of spawn as a reason to schedule', () => {
    const out = buildScheduleOnlyPreamble({
      projectId: 'proj-xyz',
      token: 'tok-sched',
      port: 8788,
    });
    expect(out).toContain('## Scheduler (opt-in — not a standing task)');
    expect(out).toContain('unless the operator asked to schedule');
    expect(out).toContain('not permission to schedule instead');
    expect(out).toContain('A test, a question, or current-turn work is not a schedule request');
    expect(out).toContain('Do not GET schedule-help unless you are about to create');
    expect(out).toContain('GET http://127.0.0.1:8788/agent/schedule-help');
    expect(out).toContain('POST http://127.0.0.1:8788/projects/proj-xyz/schedules/agent');
    expect(out).toContain('Bearer tok-sched');
    expect(out).toContain('This token schedules only');
    expect(out).not.toMatch(/You can create/);
  });
});

const spawnFpBase = {
  template: {
    name: 'team',
    roles: [
      { role: 'reviewer', profileId: 'claude-code:opus', when: 'deep correctness review' },
      { role: 'cursor-impl', profileId: 'cursor:composer', when: 'quick edits' },
    ],
  },
  spawnApprovalRequired: false,
  parentInteractionMode: 'bypass' as const,
  resolveAgentType: (id: string) => id.split(':')[0],
  scheduleCreate: { projectId: 'proj-xyz' },
};

function spawnHash(over: Partial<typeof spawnFpBase> & {
  template?: typeof spawnFpBase.template;
  pluginSetHash?: string;
  meshAwareness?: 'off' | 'subtree';
  meshMessaging?: 'off' | 'tree';
  meshEdgeSetHash?: string;
  designations?: string[];
}) {
  return makeFingerprint('spawn', spawnFpPayload({ ...spawnFpBase, ...over }));
}

describe('spawnFpPayload fingerprint', () => {
  const baseline = spawnHash({});

  it('changes when a role is added', () => {
    const next = {
      ...spawnFpBase.template,
      roles: [
        ...spawnFpBase.template.roles,
        { role: 'planner', profileId: 'claude-code:opus-4.8', when: 'specs' },
      ],
    };
    expect(spawnHash({ template: next })).not.toBe(baseline);
  });

  it('changes when a profileId changes', () => {
    const next = {
      ...spawnFpBase.template,
      roles: [
        { ...spawnFpBase.template.roles[0]!, profileId: 'claude-code:sonnet-4.6' },
        spawnFpBase.template.roles[1]!,
      ],
    };
    expect(spawnHash({ template: next })).not.toBe(baseline);
  });

  it('changes when a when string changes', () => {
    const next = {
      ...spawnFpBase.template,
      roles: [
        { ...spawnFpBase.template.roles[0]!, when: 'different hint' },
        spawnFpBase.template.roles[1]!,
      ],
    };
    expect(spawnHash({ template: next })).not.toBe(baseline);
  });

  it('changes when delegationInstructions change', () => {
    expect(spawnHash({
      template: { ...spawnFpBase.template, delegationInstructions: 'Custom only.' },
    })).not.toBe(baseline);
  });

  it('changes when spawnApprovalRequired flips', () => {
    expect(spawnHash({ spawnApprovalRequired: true })).not.toBe(baseline);
  });

  it('changes when interactionMode filters out a bypass-only role', () => {
    expect(spawnHash({ parentInteractionMode: 'prompt' })).not.toBe(baseline);
  });

  it('does not change when token, parent conversation id, or port would change', () => {
    // spawnFpPayload does not take those fields — hash is independent of them.
    const a = spawnFpPayload(spawnFpBase);
    const b = spawnFpPayload(spawnFpBase);
    expect(makeFingerprint('spawn', a)).toBe(makeFingerprint('spawn', b));
    expect(JSON.stringify(a)).not.toMatch(/tok|C1|8787/);
  });

  it('changes when the enabled-plugin set hash changes, and is stable when unchanged', () => {
    const a = spawnHash({ pluginSetHash: 'aaaaaaaaaaaa' });
    const b = spawnHash({ pluginSetHash: 'aaaaaaaaaaaa' });
    const c = spawnHash({ pluginSetHash: 'bbbbbbbbbbbb' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(spawnFpPayload(spawnFpBase).p).toBe('');
  });

  it('omits mesh keys when awareness and messaging are off (or omitted)', () => {
    const payload = spawnFpPayload(spawnFpBase);
    expect(payload).not.toHaveProperty('ma');
    expect(payload).not.toHaveProperty('mm');
    expect(payload).not.toHaveProperty('me');
    const explicitOff = spawnFpPayload({ ...spawnFpBase, meshAwareness: 'off', meshMessaging: 'off' });
    expect(explicitOff).not.toHaveProperty('ma');
    expect(explicitOff).not.toHaveProperty('mm');
    expect(JSON.stringify(payload)).toBe(JSON.stringify(explicitOff));
  });

  it('includes mesh awareness key when subtree, and messaging keys only when tree', () => {
    const a = spawnFpPayload({ ...spawnFpBase, meshAwareness: 'subtree' });
    expect(a.ma).toBe('subtree');
    expect(a).not.toHaveProperty('mm');
    const b = spawnFpPayload({ ...spawnFpBase, meshAwareness: 'subtree', meshMessaging: 'tree', meshEdgeSetHash: 'abcd' });
    expect(b.ma).toBe('subtree');
    expect(b.mm).toBe('tree');
    expect(b.me).toBe('abcd');
    expect(spawnHash({ meshAwareness: 'subtree' })).not.toBe(baseline);
  });

  it('omits designations from the payload when absent, and changes hash when the catalogue changes', () => {
    expect(spawnFpPayload(spawnFpBase)).not.toHaveProperty('d');
    const withList = spawnFpPayload({ ...spawnFpBase, designations: ['planner', 'auditor'] });
    expect(withList.d).toEqual(['planner', 'auditor']);
    expect(spawnHash({ designations: ['planner'] })).not.toBe(baseline);
    expect(spawnHash({ designations: ['planner'] })).not.toBe(spawnHash({ designations: ['planner', 'auditor'] }));
  });
});

describe('filterRolesForMode isAgentUsable', () => {
  const template = {
    name: 'team',
    roles: [
      { role: 'reviewer', profileId: 'claude-code:opus', when: 'review' },
      { role: 'Grok Bot Default', profileId: 'grok-bot:default', when: 'desktop' },
    ],
  };
  const resolve = (id: string) => id.split(':')[0];

  it('omits grok-bot when isAgentUsable returns false', () => {
    const filtered = filterRolesForMode(template, 'bypass', resolve, (t) => t !== 'grok-bot');
    expect(filtered.map((r) => r.role)).toEqual(['reviewer']);
  });

  it('fingerprint differs when grok-bot is dropped as unusable', () => {
    const usable = spawnFpPayload({
      ...spawnFpBase,
      template,
      isAgentUsable: () => true,
    });
    const hidden = spawnFpPayload({
      ...spawnFpBase,
      template,
      isAgentUsable: (t) => t !== 'grok-bot',
    });
    expect(usable.r).toHaveLength(2);
    expect(hidden.r).toEqual([['reviewer', 'claude-code:opus', 'review']]);
    expect(makeFingerprint('spawn', usable)).not.toBe(makeFingerprint('spawn', hidden));
  });
});

describe('buildDelegationStub', () => {
  const fullArgs = {
    template: {
      name: 'team',
      roles: [
        { role: 'reviewer', profileId: 'claude-code:opus', when: 'deep correctness review' },
        { role: 'Master planner', profileId: 'claude-code:opus-4.8', when: 'writing specs' },
      ],
    },
    parentConversationId: 'C1',
    spawnToken: 'tok-new',
    port: 8788,
    scheduleCreate: { projectId: 'proj-xyz' },
  };

  it('contains the new token, parent id, project id, port, intent gate, and re-inject hatch', () => {
    const out = buildDelegationStub(fullArgs);
    expect(out).toContain('tok-new');
    expect(out).toContain('C1');
    expect(out).toContain('proj-xyz');
    expect(out).toContain('8788');
    expect(out).toContain('/spawn/<childId>/message');
    expect(out).toContain('(supports role/profileId/handoff/fireInMs/wait/notifyParent)');
    expect(out).toContain('only if the operator asked to schedule');
    expect(out).toContain('ask the operator to re-inject');
    expect(out).toContain('Never reuse a Bearer or Authorization header copied from an earlier tool call');
    expect(out).toContain('Always take the Bearer from the latest stub above.');
  });

  it('omits curl bodies, roster lock, default instructions, and role names', () => {
    const out = buildDelegationStub(fullArgs);
    expect(out).not.toContain('/spawn/raw \\');
    expect(out).not.toContain('X-Spawn-Role');
    expect(out).not.toContain('X-Spawn-Designation');
    expect(out).not.toContain('Optional designation');
    expect(out).not.toContain('--data-binary');
    expect(out).not.toContain('Roster lock');
    expect(out).not.toContain(DEFAULT_DELEGATION_INSTRUCTIONS.slice(0, 40));
    expect(out).not.toContain('reviewer');
    expect(out).not.toContain('Master planner');
  });

  it('injects self + parent conversation ids when both are provided', () => {
    const out = buildDelegationStub({
      ...fullArgs,
      selfConversationId: 'child-aaa',
      selfParentConversationId: 'parent-bbb',
    });
    expect(out).toContain('_You are conversation `child-aaa`; your parent is `parent-bbb`._');
    expect(out).not.toContain('Cite these in your ## Result');
  });

  it('injects the self id alone for root conversations', () => {
    const out = buildDelegationStub({
      ...fullArgs,
      selfConversationId: 'root-ccc',
    });
    expect(out).toContain('_You are conversation `root-ccc`._');
    expect(out).not.toContain('your parent is');
  });

  it('is much shorter than the full spawn preamble', () => {
    const stub = buildDelegationStub(fullArgs);
    const full = buildDelegationPreamble(fullArgs);
    expect(stub.length).toBeLessThan(full.length / 5);
  });
});

describe('buildScheduleOnlyStub', () => {
  it('contains the token, create URL, and intent gate, and omits the 401-vs-404 paragraph', () => {
    const out = buildScheduleOnlyStub({
      projectId: 'proj-xyz',
      token: 'tok-sched',
      port: 8788,
    });
    expect(out).toContain('tok-sched');
    expect(out).toContain('POST http://127.0.0.1:8788/projects/proj-xyz/schedules/agent');
    expect(out).toContain('only if the operator asked to schedule');
    expect(out).toContain('not permission to schedule instead');
    expect(out).toContain('Never reuse a Bearer or Authorization header copied from an earlier tool call');
    expect(out).toContain('Always take the Bearer from the latest stub above.');
    expect(out).not.toContain('401 unauthorized');
    expect(out).not.toContain('not 404');
  });

  it('is shorter than the full schedule-only preamble', () => {
    const args = { projectId: 'proj-xyz', token: 'tok-sched', port: 8788 };
    expect(buildScheduleOnlyStub(args).length).toBeLessThan(buildScheduleOnlyPreamble(args).length);
  });
});

describe('filterAgentPlugins', () => {
  const plugins = [
    {
      id: 'gemini-image',
      name: 'Gemini Image',
      capabilities: [{ name: 'image.generate', summary: 'img' }],
    },
    {
      id: 'zai-usage',
      name: 'Z.ai Usage',
      capabilities: [{ name: 'usage.get', summary: 'quota', usageProvider: true as const }],
    },
  ];

  it('keeps usageProvider capabilities when the grant allows them', () => {
    const all = filterAgentPlugins(plugins, { id: 'all', plugins: '*', usage: true });
    expect(all.map((p) => p.id)).toEqual(['gemini-image', 'zai-usage']);
    const usage = filterAgentPlugins(plugins, { id: 'usage', plugins: [], usage: true });
    expect(usage.map((p) => p.id)).toEqual(['zai-usage']);
    const media = filterAgentPlugins(plugins, { id: 'media', plugins: ['gemini-image'], usage: false });
    expect(media.map((p) => p.id)).toEqual(['gemini-image']);
  });
});

describe('scopeAgentPlugins', () => {
  const plugins = [
    {
      id: 'gemini-image',
      name: 'Gemini Image',
      capabilities: [
        { name: 'image.generate', summary: 'img' },
        { name: 'image.edit', summary: 'edit' },
      ],
    },
    {
      id: 'zai-usage',
      name: 'Z.ai Usage',
      capabilities: [{ name: 'usage.get', summary: 'quota', usageProvider: true as const }],
    },
    {
      id: 'demo',
      name: 'Demo',
      capabilities: [{ name: 'echo', summary: 'echo' }],
    },
  ];

  it('drops capabilities outside the grant and whole plugins left with none', () => {
    const scoped = scopeAgentPlugins(plugins, { id: 'media', plugins: ['gemini-image'], usage: false });
    expect(scoped).toEqual([
      {
        id: 'gemini-image',
        name: 'Gemini Image',
        capabilities: [
          { name: 'image.generate', summary: 'img' },
          { name: 'image.edit', summary: 'edit' },
        ],
      },
    ]);
  });

  it('usageProvider capabilities never render as roster lines, even when their plugin is explicitly granted', () => {
    expect(scopeAgentPlugins(plugins, { id: 'z', plugins: ['zai-usage'], usage: false })).toEqual([]);
    expect(scopeAgentPlugins(plugins, { id: 'z', plugins: ['zai-usage'], usage: true })).toEqual([]);
  });

  it('all keeps everything except usageProvider lines', () => {
    const scoped = scopeAgentPlugins(plugins, { id: 'all', plugins: '*', usage: true });
    expect(scoped.map((p) => p.id)).toEqual(['gemini-image', 'demo']);
  });

  it('minimal yields an empty roster', () => {
    expect(scopeAgentPlugins(plugins, { id: 'minimal', plugins: [], usage: false })).toEqual([]);
  });

  it('tolerates undefined input', () => {
    expect(scopeAgentPlugins(undefined, { id: 'all', plugins: '*', usage: true })).toEqual([]);
  });
});

describe('pluginRosterLines usage telemetry', () => {
  const plugins = [{ id: 'demo', name: 'Demo', capabilities: [{ name: 'echo', summary: 'echo' }] }];

  it('full mode renders exactly one usage line, after the plugin lines', () => {
    const lines = pluginRosterLines(8787, plugins, 'full', true);
    const usageLines = lines.filter((l) => l.includes('usage · telemetry'));
    expect(usageLines).toHaveLength(1);
    expect(usageLines[0]).toContain('GET http://127.0.0.1:8787/agent/usage');
    expect(lines[lines.length - 1]).toBe(usageLines[0]);
  });

  it('full mode without usage renders the old shape with no usage line', () => {
    expect(pluginRosterLines(8787, plugins, 'full').join('\n')).not.toContain('usage · telemetry');
    expect(pluginRosterLines(8787, plugins, 'full', false).join('\n')).not.toContain('/agent/usage');
  });

  it('usage-only surface renders the router line with no Invoke line', () => {
    const lines = pluginRosterLines(8787, [], 'full', true);
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('Invoke:');
    expect(lines[2]).toContain('All: GET http://127.0.0.1:8787/agent/usage');
    expect(lines[2]).toContain('one: GET http://127.0.0.1:8787/agent/usage/<target>');
    expect(lines[2]).toContain('6 calls/min');
  });

  it('nothing granted and no usage ⇒ no block at all', () => {
    expect(pluginRosterLines(8787, [], 'full', false)).toEqual([]);
    expect(pluginRosterLines(8787)).toEqual([]);
  });

  it('stub mode appends the usage suffix and collapses to one line when usage-only', () => {
    const stub = pluginRosterLines(8787, plugins, 'stub', true).join(' | ');
    expect(stub).toContain('demo·echo');
    expect(stub).toContain('usage·telemetry');
    expect(stub).toContain('GET http://127.0.0.1:8787/agent/usage[/<target>]');
    expect(pluginRosterLines(8787, plugins, 'stub', false).join('')).not.toContain('usage·telemetry');
    expect(pluginRosterLines(8787, [], 'stub', true)).toEqual([
      'Tierwyn server capabilities (use the new Bearer above): usage·telemetry — GET http://127.0.0.1:8787/agent/usage[/<target>]',
    ]);
    expect(pluginRosterLines(8787, [], 'stub', false)).toEqual([]);
  });
});

describe('selfTimer preamble', () => {
  const scheduleArgs = { projectId: 'p-1', token: 'tok', port: 8788 };
  const delegationArgs = {
    template: { name: 't', roles: [] },
    parentConversationId: 'p-1',
    spawnToken: 'tok',
    port: 8788,
  };
  const stubArgs = { projectId: 'p-1', token: 'tok', port: 8788 };
  const fpArgs = { template: { name: 't', roles: [] } };

  it('documents the self-timer route when selfTimer is set', () => {
    const s = buildScheduleOnlyPreamble({ ...scheduleArgs, selfTimer: { conversationId: 'c-1', isChild: false } });
    expect(s).toContain('## Self-timer (wake yourself later)');
    expect(s).toContain('POST http://127.0.0.1:8788/conversations/c-1/timers/agent');
    expect(s).toContain('{text, fireInMs|fireAtMs}');
    expect(s).toMatch(/8h/);
  });
  it('omits it when selfTimer is unset', () => {
    expect(buildScheduleOnlyPreamble(scheduleArgs)).not.toContain('timers/agent');
  });
  it('child variant warns the parent is not notified', () => {
    const s = buildDelegationPreamble({ ...delegationArgs, selfTimer: { conversationId: 'c-2', isChild: true } });
    expect(s).toMatch(/does NOT notify your parent/);
  });
  it('stubs carry a one-line pointer', () => {
    expect(buildScheduleOnlyStub({ ...stubArgs, selfTimer: { conversationId: 'c-1', isChild: false } })).toContain('/conversations/c-1/timers/agent');
  });
  it('spawnFpPayload changes when selfTimer toggles', () => {
    expect(spawnFpPayload({ ...fpArgs })).not.toEqual(spawnFpPayload({ ...fpArgs, selfTimer: { conversationId: 'x', isChild: false } }));
  });
});

describe('globalTasks preamble', () => {
  const scheduleArgs = { projectId: 'p-1', token: 'tok', port: 8788 };
  const delegationArgs = {
    template: { name: 't', roles: [] },
    parentConversationId: 'p-1',
    spawnToken: 'tok',
    port: 8788,
  };
  const stubArgs = { projectId: 'p-1', token: 'tok', port: 8788 };
  const fpArgs = { template: { name: 't', roles: [] } };
  const root = { conversationId: 'c1', isChild: false };
  const child = { conversationId: 'c1', isChild: true };

  it('delegation full block for root, child, and absent', () => {
    const rootText = buildDelegationPreamble({ ...delegationArgs, globalTasks: root });
    expect(rootText).toContain('## Global task log');
    expect(rootText).toContain('/conversations/c1/tasks/agent');
    expect(rootText).toContain('your parent owns the task');
    expect(rootText).toContain('At most 3 open tasks');
    const childText = buildDelegationPreamble({ ...delegationArgs, globalTasks: child });
    expect(childText).toContain('record your own sub-task');
    expect(childText).not.toContain('your parent owns');
    expect(buildDelegationPreamble(delegationArgs)).not.toContain('Global task log');
  });

  it('schedule-only full block for root, child, and absent', () => {
    const rootText = buildScheduleOnlyPreamble({ ...scheduleArgs, globalTasks: root });
    expect(rootText).toContain('## Global task log');
    expect(rootText).toContain('/conversations/c1/tasks/agent');
    expect(rootText).toContain('your parent owns the task');
    expect(rootText).toContain('At most 3 open tasks');
    const childText = buildScheduleOnlyPreamble({ ...scheduleArgs, globalTasks: child });
    expect(childText).toContain('record your own sub-task');
    expect(childText).not.toContain('your parent owns');
    expect(buildScheduleOnlyPreamble(scheduleArgs)).not.toContain('Global task log');
  });

  it('stubs mention Global tasks only when globalTasks is set', () => {
    expect(buildDelegationStub({ parentConversationId: 'p-1', spawnToken: 'tok', port: 8788, globalTasks: root }))
      .toContain('Global tasks: GET|POST http://127.0.0.1:8788/tasks/agent, PATCH http://127.0.0.1:8788/tasks/agent/<taskId> (Bearer: tok;');
    expect(buildScheduleOnlyStub({ ...stubArgs, globalTasks: root }))
      .toContain('Global tasks: GET|POST http://127.0.0.1:8788/tasks/agent, PATCH http://127.0.0.1:8788/tasks/agent/<taskId> (Bearer: tok;');
    expect(buildDelegationStub({ parentConversationId: 'p-1', spawnToken: 'tok', port: 8788 })).not.toContain('Global tasks:');
    expect(buildScheduleOnlyStub(stubArgs)).not.toContain('Global tasks:');
  });

  it('fingerprint has no gt when off; gt 1 for root; gt 2 for child', () => {
    expect('gt' in spawnFpPayload({ ...fpArgs })).toBe(false);
    expect(spawnFpPayload({ ...fpArgs, globalTasks: root }).gt).toBe(1);
    expect(spawnFpPayload({ ...fpArgs, globalTasks: child }).gt).toBe(2);
  });

  it('schedule fingerprint toggles gt key when globalTasks is set', () => {
    const off = makeFingerprint('schedule', { p: 'proj' });
    const onRoot = makeFingerprint('schedule', { p: 'proj', gt: 1 });
    const onChild = makeFingerprint('schedule', { p: 'proj', gt: 2 });
    expect(off).not.toBe(onRoot);
    expect(onRoot).not.toBe(onChild);
    expect(off).not.toBe(onChild);
  });
});

describe('project memories in preambles', () => {
  it('full preambles carry the memory section when enabled, stubs the one-liner', () => {
    const del = buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 'tok', port: 8788,
      memoryEnabled: true,
    });
    const sch = buildScheduleOnlyPreamble({ projectId: 'p', token: 'tok', port: 8788, memoryEnabled: true });
    for (const out of [del, sch]) {
      expect(out).toContain('## Project memories');
      expect(out).toContain('Search: GET http://127.0.0.1:8788/agent/memory?q=<words>');
      expect(out).toContain('Bearer: tok');
      expect(out).toContain('"suggestRule":true,"ruleReason":"<one line>"');
    }
    const delStub = buildDelegationStub({
      parentConversationId: 'c1', spawnToken: 'tok', port: 8788, memoryEnabled: true,
    });
    const schStub = buildScheduleOnlyStub({ projectId: 'p', token: 'tok', port: 8788, memoryEnabled: true });
    for (const out of [delStub, schStub]) {
      expect(out).toContain('Project memories: GET http://127.0.0.1:8788/agent/memory?q=<words> · POST same path {"kind":"gotcha|decision|fact","text":"..."} (same Bearer).');
      expect(out).not.toContain('## Project memories');
    }
  });

  it('absent when memoryEnabled is false', () => {
    expect(buildScheduleOnlyPreamble({ projectId: 'p', token: 't', port: 8788 })).not.toContain('Project memories');
    expect(buildScheduleOnlyStub({ projectId: 'p', token: 't', port: 8788 })).not.toContain('Project memories');
    expect(buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 't', port: 8788, memoryEnabled: false,
    })).not.toContain('Project memories');
  });

  it('never mentions memory.md or Memory proposals', () => {
    const del = buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 't', port: 8788, memoryEnabled: true,
    });
    expect(del).not.toContain('memory.md');
    expect(del).not.toContain('Memory proposals');
  });

  it('stubs carry the one-liner; delegation stub keeps identity line last', () => {
    const del = buildDelegationStub({
      parentConversationId: 'c1', spawnToken: 't', port: 8788,
      selfConversationId: 'c1', memoryEnabled: true,
    });
    expect(del).toContain('Project memories: GET http://127.0.0.1:8788/agent/memory');
    expect(del.trimEnd().endsWith('_You are conversation `c1`._')).toBe(true);
  });
});

describe('conversation history search in preambles', () => {
  it('full preambles carry the search line and search help topic when searchScope is project or all', () => {
    const del = buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 'tok', port: 8788,
      searchScope: ss('project'), memoryEnabled: true,
    });
    const sch = buildScheduleOnlyPreamble({ projectId: 'p', token: 'tok', port: 8788, searchScope: ss('all'), memoryEnabled: true });
    expect(del).toContain('GET http://127.0.0.1:8788/agent/search?q=<words>');
    expect(del).toContain('(this project only; same Bearer)');
    expect(del).not.toContain('scope=all enabled');
    expect(del).not.toContain('sandbox active');
    expect(del).toContain('/agent/help/<topic>` — spawn, messaging, results, helpers, search.');
    expect(sch).toContain('(default: this project; scope=all enabled; same Bearer)');
    expect(sch).toContain('GET /agent/help/search');
  });

  it('full preamble for capped project mentions sandbox active', () => {
    const del = buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 'tok', port: 8788,
      searchScope: ss('project', { capped: true }), memoryEnabled: true,
    });
    expect(del).toContain('(this project only — sandbox active; same Bearer)');
    expect(del).not.toContain('scope=all enabled');
  });

  it('stubs carry the compact reminder with the scope note', () => {
    const delStub = buildDelegationStub({
      parentConversationId: 'c1', spawnToken: 'tok', port: 8788, searchScope: ss('project'), memoryEnabled: true,
    });
    const capStub = buildDelegationStub({
      parentConversationId: 'c1', spawnToken: 'tok', port: 8788,
      searchScope: ss('project', { capped: true }), memoryEnabled: true,
    });
    const schStub = buildScheduleOnlyStub({ projectId: 'p', token: 'tok', port: 8788, searchScope: ss('all'), memoryEnabled: true });
    expect(delStub).toContain('History search: GET http://127.0.0.1:8788/agent/search?q=<words> (this project only; same Bearer; `GET /agent/help/search`).');
    expect(capStub).toContain('(this project only — sandbox active; same Bearer; `GET /agent/help/search`)');
    expect(schStub).toContain('(scope=all enabled; same Bearer; `GET /agent/help/search`)');
  });

  it('absent when searchScope is off or omitted', () => {
    expect(buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 't', port: 8788,
      memoryEnabled: true,
    })).not.toContain('/agent/search');
    expect(buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 't', port: 8788, searchScope: ss('off'),
      memoryEnabled: true,
    })).not.toContain('/agent/search');
    expect(buildScheduleOnlyPreamble({ projectId: 'p', token: 't', port: 8788, searchScope: ss('off'), memoryEnabled: true }))
      .not.toContain('/agent/search');
  });

  it('project override off with source project and global all → no search line', () => {
    const off = ss('off', { source: 'project' });
    expect(buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 't', port: 8788,
      searchScope: off, memoryEnabled: true,
    })).not.toContain('/agent/search');
    expect(searchFpExtra(off, true)).toEqual({});
  });

  it('absent when memory is not allowed even if searchScope is project or all', () => {
    expect(buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 't', port: 8788,
      searchScope: ss('project'),
    })).not.toContain('/agent/search');
    expect(buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 't', port: 8788,
      searchScope: ss('all'), memoryEnabled: false,
    })).not.toContain('/agent/search');
    expect(buildScheduleOnlyPreamble({ projectId: 'p', token: 't', port: 8788, searchScope: ss('all') }))
      .not.toContain('/agent/search');
    expect(buildDelegationStub({
      parentConversationId: 'c1', spawnToken: 't', port: 8788, searchScope: ss('project'),
    })).not.toContain('/agent/search');
    expect(buildScheduleOnlyStub({ projectId: 'p', token: 't', port: 8788, searchScope: ss('all') }))
      .not.toContain('/agent/search');
  });
});

describe('spawnFpPayload searchScope key', () => {
  it('omits ss when searchScope is off or omitted', () => {
    expect('ss' in spawnFpPayload(spawnFpBase)).toBe(false);
    expect('ss' in spawnFpPayload({ ...spawnFpBase, searchScope: ss('off'), memoryEnabled: true })).toBe(false);
  });
  it('includes ss when searchScope is project or all and memory is allowed', () => {
    expect(spawnFpPayload({ ...spawnFpBase, searchScope: ss('project'), memoryEnabled: true }).ss).toBe('project');
    expect(spawnFpPayload({ ...spawnFpBase, searchScope: ss('all'), memoryEnabled: true }).ss).toBe('all');
  });
  it('omits ss when memory is not allowed even if searchScope is project', () => {
    expect('ss' in spawnFpPayload({ ...spawnFpBase, searchScope: ss('project') })).toBe(false);
    expect('ss' in spawnFpPayload({ ...spawnFpBase, searchScope: ss('all'), memoryEnabled: false })).toBe(false);
  });
  it('capped vs uncapped project fingerprints differ; uncapped omits ssc', () => {
    const uncapped = searchFpExtra(ss('project'), true);
    const capped = searchFpExtra(ss('project', { capped: true }), true);
    expect(uncapped).toEqual({ ss: 'project' });
    expect(capped).toEqual({ ss: 'project', ssc: 1 });
    expect(spawnFpPayload({ ...spawnFpBase, searchScope: ss('project'), memoryEnabled: true })).not.toEqual(
      spawnFpPayload({ ...spawnFpBase, searchScope: ss('project', { capped: true }), memoryEnabled: true }),
    );
  });
});

describe('spawnFpPayload has no mem key', () => {
  const baseline = spawnHash({});
  it('fingerprint is identical with memoryEnabled true and false', () => {
    expect(makeFingerprint('spawn', spawnFpPayload(spawnFpBase))).toBe(baseline);
  });
  it('fingerprint payload has no mem key', () => {
    expect('mem' in spawnFpPayload(spawnFpBase)).toBe(false);
  });
});

const rulesView = {
  blocks: [
    { label: 'Project', text: 'always worktrees' },
    { label: 'Conversation: Orchestrator', text: 'plan first' },
  ],
  hash: 'ruleshash0001',
};

describe('operator rules in preambles', () => {
  it('full builders render Operator rules before Project memories', () => {
    const del = buildDelegationPreamble({
      template: spawnFpBase.template, parentConversationId: 'c1', spawnToken: 't', port: 8788,
      memoryEnabled: true, operatorRules: rulesView,
    });
    const sch = buildScheduleOnlyPreamble({
      projectId: 'p', token: 't', port: 8788, memoryEnabled: true, operatorRules: rulesView,
    });
    for (const out of [del, sch]) {
      expect(out).toContain('## Operator rules');
      expect(out).toContain('always worktrees');
      expect(out.indexOf('## Operator rules')).toBeLessThan(out.indexOf('## Project memories'));
    }
  });

  it('stubs carry the one-line reminder; absent rules omit the block', () => {
    expect(buildScheduleOnlyPreamble({ projectId: 'p', token: 't', port: 8788 })).not.toContain('Operator rules');
    const stub = buildScheduleOnlyStub({ projectId: 'p', token: 't', port: 8788, operatorRules: rulesView });
    expect(stub).toContain('Operator rules given earlier still apply.');
    const del = buildDelegationStub({
      parentConversationId: 'c1', spawnToken: 't', port: 8788, operatorRules: rulesView,
    });
    expect(del).toContain('Operator rules given earlier still apply.');
  });
});

describe('spawnFpPayload rules key', () => {
  const baseline = spawnHash({});
  it('omitted rules keep the pre-feature hash (deploy-stable)', () => {
    expect(makeFingerprint('spawn', spawnFpPayload({ ...spawnFpBase, operatorRules: undefined }))).toBe(baseline);
    expect('rules' in spawnFpPayload(spawnFpBase)).toBe(false);
  });
  it('present rules change the hash, and an edit changes it again', () => {
    const a = makeFingerprint('spawn', spawnFpPayload({ ...spawnFpBase, operatorRules: rulesView }));
    const b = makeFingerprint('spawn', spawnFpPayload({
      ...spawnFpBase, operatorRules: { ...rulesView, hash: 'ruleshash0002' },
    }));
    expect(a).not.toBe(baseline);
    expect(b).not.toBe(a);
  });
});




describe('markup hint', () => {
  const base = { projectId: 'p', token: 't', port: 8787 };
  it('omits the hint when off, scopes it per mode', () => {
    expect(buildScheduleOnlyPreamble(base)).not.toContain(':color[');
    const all = buildScheduleOnlyPreamble({ ...base, markupHint: 'all' });
    expect(all).toContain(':color[text]{.ok}');
    expect(all).toContain('markdown files');
    const chat = buildScheduleOnlyPreamble({ ...base, markupHint: 'chat' });
    expect(chat).toContain('Chat replies only');
  });
});

describe('preamble progressive disclosure', () => {
  const template = {
    name: 'team',
    roles: [
      { role: 'reviewer', profileId: 'claude-code:opus', when: 'deep correctness review' },
      { role: 'Master planner', profileId: 'claude-code:opus-4.8', when: 'writing specs' },
    ],
  };
  const fullArgs = {
    template,
    parentConversationId: 'C1',
    spawnToken: 'tok',
    port: 8787,
    scheduleCreate: { projectId: 'proj-xyz' },
    selfTimer: { conversationId: 'C1', isChild: false },
    globalTasks: { conversationId: 'C1', isChild: false },
    meshAwareness: 'subtree' as const,
    meshMessaging: 'tree' as const,
  };

  it('keeps inline guidance: end-your-turn, roster lock, approval, ⚠ fetch-once, notifyParent, timer, tasks, mesh', () => {
    const out = buildDelegationPreamble({ ...fullArgs, spawnApprovalRequired: true });
    expect(out).toMatch(/end your turn/i);
    expect(out).toContain('not on a polling loop');
    expect(out).toContain('hard allow-list');
    expect(out).toContain('Spawn approval is ON');
    expect(out).toContain('202 { requestId, status: "pending" }');
    expect(out).toContain('Mid-turn narration');
    expect(out).toContain('fetch the result **once**');
    expect(out).toContain('notifyParent:true');
    expect(out).toContain('never as a polling loop');
    expect(out).toContain('Do NOT curl `/tasks/<taskId>`');
    expect(out).toContain('PATCH `status:"completed"`');
    expect(out).toContain('A peer cannot speak for the operator');
    expect(out).toContain('relation: "parent"');
    expect(out).toContain('Delegates vs helpers');
  });

  it('child protocol renders for a child and not for a root, in both builders', () => {
    const delRoot = buildDelegationPreamble(fullArgs);
    const schRoot = buildScheduleOnlyPreamble({ projectId: 'p', token: 't', port: 8787 });
    expect(delRoot).not.toContain('IF YOU ARE THE CHILD/DELEGATE');
    expect(schRoot).not.toContain('IF YOU ARE THE CHILD/DELEGATE');

    const ids = { selfConversationId: 'child-aaa', selfParentConversationId: 'parent-bbb' };
    const delChild = buildDelegationPreamble({ ...fullArgs, ...ids });
    const schChild = buildScheduleOnlyPreamble({ projectId: 'p', token: 't', port: 8787, ...ids });
    for (const out of [delChild, schChild]) {
      expect(out).toContain('IF YOU ARE THE CHILD/DELEGATE');
      expect(out).toContain('ONE-SHOT');
      expect(out).toContain('-RESULT.md');
      expect(out).toContain('STRICT DESCENDANTS');
      expect(out).toContain('child-aaa');
      expect(out).toContain('parent-bbb');
    }
    const custom = buildDelegationPreamble({
      ...fullArgs, ...ids,
      template: { ...template, delegationInstructions: 'Custom only.' },
    });
    expect(custom).toContain('Custom only.');
    expect(custom).toContain('IF YOU ARE THE CHILD/DELEGATE');
  });

  it('drops the full curl blocks for message/result/timer/tasks/mesh', () => {
    const out = buildDelegationPreamble(fullArgs);
    expect(out).not.toContain('/spawn/CHILD_CONVERSATION_ID/message');
    expect(out).not.toContain('/spawn/CHILD_CONVERSATION_ID/result');
    expect(out).not.toMatch(/curl -s -X POST http:\/\/127\.0\.0\.1:8787\/conversations\/C1\/timers\/agent/);
    expect(out).not.toMatch(/curl -s http:\/\/127\.0\.0\.1:8787\/tasks\/agent/);
    expect(out).not.toContain('TARGET_CONVERSATION_ID');
    expect(out).toContain('--data-binary @');
  });

  it('help index lists only enabled topics', () => {
    const allOn = buildDelegationPreamble(fullArgs);
    expect(allOn).toMatch(/GET http:\/\/127\.0\.0\.1:8787\/agent\/help\/<topic>` — spawn, messaging, results, helpers, timer, tasks, mesh\./);

    const minimal = buildDelegationPreamble({ template, parentConversationId: 'C1', spawnToken: 'tok', port: 8787 });
    expect(minimal).toMatch(/GET http:\/\/127\.0\.0\.1:8787\/agent\/help\/<topic>` — spawn, messaging, results, helpers\./);
    expect(minimal).not.toContain('helpers, timer');
    expect(minimal).not.toMatch(/results, helpers, mesh/);

    const sched = buildScheduleOnlyPreamble({
      projectId: 'p', token: 't', port: 8787,
      selfTimer: { conversationId: 'c', isChild: false },
    });
    expect(sched).toMatch(/GET http:\/\/127\.0\.0\.1:8787\/agent\/help\/<topic>` — helpers, timer\./);
    expect(sched).not.toContain('spawn, messaging, results');
  });
});

