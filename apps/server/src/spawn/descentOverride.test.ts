import { describe, it, expect } from 'vitest';
import { resolveDescentOverride } from './descentOverride.js';

const child = { roles: [{ role: 'impl', profileId: 'hermes:glm-4.6' }] };
const parent = { roles: [{ role: 'impl', profileId: 'claude-code:sonnet-4.6' }, { role: 'plan', profileId: 'claude-code:opus-4.8' }] };

describe('resolveDescentOverride', () => {
  it('returns undefined profileId when neither role nor profileId is sent', () => {
    expect(resolveDescentOverride({ bearer: true, manual: false, childTemplate: child, parentTemplate: parent }))
      .toEqual({ ok: true, profileId: undefined });
  });

  it('bearer uses the child roster when the child has roles', () => {
    const r = resolveDescentOverride({
      bearer: true, manual: false, childTemplate: child, parentTemplate: parent,
      profileId: 'hermes:glm-4.6',
    });
    expect(r).toEqual({ ok: true, profileId: 'hermes:glm-4.6' });
  });

  it('bearer rejects a parent-only profile when the child has a roster', () => {
    const r = resolveDescentOverride({
      bearer: true, manual: false, childTemplate: child, parentTemplate: parent,
      profileId: 'claude-code:sonnet-4.6',
    });
    expect(r).toEqual({ ok: false, error: 'profile not in parent template roster' });
  });

  it('bearer falls back to the parent roster when the child has no template', () => {
    const r = resolveDescentOverride({
      bearer: true, manual: false, parentTemplate: parent, profileId: 'claude-code:sonnet-4.6',
    });
    expect(r).toEqual({ ok: true, profileId: 'claude-code:sonnet-4.6' });
  });

  it('bearer with no roster anywhere → parent has no spawn template', () => {
    const r = resolveDescentOverride({ bearer: true, manual: false, profileId: 'x' });
    expect(r).toEqual({ ok: false, error: 'parent has no spawn template' });
  });

  it('bearer + empty child and parent roles → parent has no spawn template', () => {
    const r = resolveDescentOverride({
      bearer: true, manual: false,
      childTemplate: { roles: [] }, parentTemplate: { roles: [] },
      profileId: 'x',
    });
    expect(r).toEqual({ ok: false, error: 'parent has no spawn template' });
  });

  it('resolves a role alias on the child roster', () => {
    const r = resolveDescentOverride({
      bearer: true, manual: false, childTemplate: child, parentTemplate: parent, role: 'impl',
    });
    expect(r).toEqual({ ok: true, profileId: 'hermes:glm-4.6' });
  });

  it('unknown role → verbatim error', () => {
    const r = resolveDescentOverride({
      bearer: true, manual: false, childTemplate: child, role: 'nope',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('role "nope" not found in the conversation template');
  });

  it('role and profileId disagree → verbatim error', () => {
    const r = resolveDescentOverride({
      bearer: true, manual: false, childTemplate: child,
      role: 'impl', profileId: 'claude-code:sonnet-4.6',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('role "impl" maps to profile hermes:glm-4.6, not claude-code:sonnet-4.6');
  });

  it('cookie caller may pick an off-roster profileId', () => {
    const r = resolveDescentOverride({
      bearer: false, manual: true, childTemplate: child, profileId: 'claude-code:sonnet-4.6',
    });
    expect(r).toEqual({ ok: true, profileId: 'claude-code:sonnet-4.6' });
  });

  it('bearer passes catalogue-unknown profileIds through to the route availability check', () => {
    const unknown = resolveDescentOverride({
      bearer: true, manual: false, parentTemplate: parent,
      profileId: 'no-such-profile', isKnownProfile: () => false,
    });
    expect(unknown).toEqual({ ok: true, profileId: 'no-such-profile' });
    const known = resolveDescentOverride({
      bearer: true, manual: false, parentTemplate: parent,
      profileId: 'kimi-code:k2', isKnownProfile: () => true,
    });
    expect(known).toEqual({ ok: false, error: 'profile not in parent template roster' });
  });
});
