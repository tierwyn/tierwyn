import { describe, it, expect } from 'vitest';
import {
  BUILTIN_CAPABILITY_PROFILES,
  CAPABILITY_PROFILE_ID_RE,
  DEFAULT_CAPABILITY_PROFILE_ID,
  FALLBACK_CAPABILITY_PROFILE_ID,
  canonicalCapabilityProfileId,
  capabilityProfileFp,
  profileAllowsCapability,
  profileAllowsMemory,
  profileAllowsUsage,
  validateCapabilityProfileInput,
  type ResolvedCapabilityProfile,
} from './capabilityProfiles.js';

const all: ResolvedCapabilityProfile = { id: 'all', plugins: '*', usage: true };
const media: ResolvedCapabilityProfile = { id: 'media', plugins: ['gemini-image'], usage: false };
const usage: ResolvedCapabilityProfile = { id: 'usage', plugins: [], usage: true };
const minimal: ResolvedCapabilityProfile = { id: 'minimal', plugins: [], usage: false };

describe('profileAllowsCapability grant rule', () => {
  const cases: Array<[ResolvedCapabilityProfile, string, { usageProvider?: boolean } | undefined, boolean]> = [
    [all, 'gemini-image', undefined, true],
    [all, 'no-such-plugin', undefined, true],
    [all, 'demo', { usageProvider: true }, true],
    [media, 'gemini-image', undefined, true],
    [media, 'demo', undefined, false],
    [media, 'gemini-image', { usageProvider: false }, true],
    [usage, 'demo', undefined, false],
    [usage, 'demo', { usageProvider: true }, true],
    [usage, 'demo', { usageProvider: false }, false],
    [minimal, 'demo', { usageProvider: true }, false],
    [minimal, 'demo', undefined, false],
  ];

  it.each(cases)('%s allows %s cap=%j → %j', (profile, pluginId, cap, expected) => {
    expect(profileAllowsCapability(profile, pluginId, cap)).toBe(expected);
  });

  it('plugin-level checks may omit the capability (help gate)', () => {
    expect(profileAllowsCapability(media, 'gemini-image')).toBe(true);
    expect(profileAllowsCapability(media, 'demo')).toBe(false);
  });
});

describe('profileAllowsMemory', () => {
  it('existing stored profiles without the field allow memory; minimal denies', () => {
    expect(profileAllowsMemory(all)).toBe(true);
    expect(profileAllowsMemory(media)).toBe(true);
    expect(profileAllowsMemory({ id: 'minimal', plugins: [], usage: false, memory: false })).toBe(false);
  });
});

describe('profileAllowsUsage', () => {
  it('follows the same grant as a usageProvider cap under plugins:"*" or usage:true', () => {
    expect(profileAllowsUsage(all)).toBe(true);
    expect(profileAllowsUsage(usage)).toBe(true);
    expect(profileAllowsUsage({ id: 'star', plugins: '*', usage: false })).toBe(true);
    expect(profileAllowsUsage(media)).toBe(false);
    expect(profileAllowsUsage(minimal)).toBe(false);
    expect(profileAllowsUsage({ id: 'listed', plugins: ['zai-usage'], usage: false })).toBe(false);
  });
});

describe('canonicalCapabilityProfileId', () => {
  it('collapses null, empty, and the default id to null', () => {
    expect(canonicalCapabilityProfileId(null)).toBeNull();
    expect(canonicalCapabilityProfileId(undefined)).toBeNull();
    expect(canonicalCapabilityProfileId('')).toBeNull();
    expect(canonicalCapabilityProfileId('all')).toBeNull();
    expect(canonicalCapabilityProfileId('  all  ')).toBeNull();
    expect(canonicalCapabilityProfileId('media')).toBe('media');
    expect(canonicalCapabilityProfileId('minimal')).toBe('minimal');
  });

  it('honours a custom default profile id', () => {
    expect(canonicalCapabilityProfileId('custom', 'custom')).toBeNull();
    expect(canonicalCapabilityProfileId('  custom  ', 'custom')).toBeNull();
    expect(canonicalCapabilityProfileId('all', 'custom')).toBe('all');
    expect(canonicalCapabilityProfileId(null, 'custom')).toBeNull();
  });
});

describe('capabilityProfileFp', () => {
  it('is stable and order-insensitive over the plugin list', () => {
    const a = capabilityProfileFp({ id: 'team', plugins: ['zai', 'gemini-image', 'demo'], usage: true });
    const b = capabilityProfileFp({ id: 'team', plugins: ['demo', 'zai', 'gemini-image'], usage: true });
    expect(a).toBe(b);
  });

  it('distinguishes id, plugin set, and usage flag', () => {
    const base = capabilityProfileFp({ id: 'team', plugins: ['demo'], usage: false });
    expect(capabilityProfileFp({ id: 'other', plugins: ['demo'], usage: false })).not.toBe(base);
    expect(capabilityProfileFp({ id: 'team', plugins: ['demo', 'zai'], usage: false })).not.toBe(base);
    expect(capabilityProfileFp({ id: 'team', plugins: ['demo'], usage: true })).not.toBe(base);
    expect(capabilityProfileFp(all)).toBe(`all:*:1:1`);
    expect(capabilityProfileFp(minimal)).toBe('minimal::0:1');
  });

  it('capabilityProfileFp changes when memory flips', () => {
    const allowed = capabilityProfileFp({ id: 'team', plugins: ['demo'], usage: false });
    const denied = capabilityProfileFp({ id: 'team', plugins: ['demo'], usage: false, memory: false });
    expect(denied).not.toBe(allowed);
    expect(denied.endsWith(':0')).toBe(true);
  });
});

describe('BUILTIN_CAPABILITY_PROFILES', () => {
  it('ships only all with the settled grant', () => {
    expect(BUILTIN_CAPABILITY_PROFILES).toEqual([
      { id: 'all', label: 'All', plugins: '*', usage: true, builtin: true },
    ]);
    expect(DEFAULT_CAPABILITY_PROFILE_ID).toBe('all');
    expect(FALLBACK_CAPABILITY_PROFILE_ID).toBe('minimal');
  });

  it('freezes builtin rows so a process-wide mutation cannot widen the grant', () => {
    expect(Object.isFrozen(BUILTIN_CAPABILITY_PROFILES)).toBe(true);
    const allRow = BUILTIN_CAPABILITY_PROFILES.find((p) => p.id === 'all')!;
    expect(Object.isFrozen(allRow)).toBe(true);
  });
});

describe('validateCapabilityProfileInput', () => {
  const catalogue = ['gemini-image', 'zai-usage', 'demo'];

  it('accepts a well-formed custom profile and dedupes plugin ids', () => {
    const out = validateCapabilityProfileInput(
      { id: 'image-only', label: 'Image only', plugins: ['gemini-image', 'gemini-image'], usage: false },
      catalogue,
    );
    expect(out).toEqual({
      ok: true,
      profile: { id: 'image-only', label: 'Image only', plugins: ['gemini-image'], usage: false },
    });
  });

  it('accepts plugins:"*" with usage either way', () => {
    expect(validateCapabilityProfileInput({ id: 'wide', label: 'Wide', plugins: '*', usage: true }, catalogue).ok).toBe(true);
    expect(validateCapabilityProfileInput({ id: 'wide', label: 'Wide', plugins: '*', usage: false }, catalogue).ok).toBe(true);
  });

  it.each([
    ['uppercase id', { id: 'Team', label: 't', plugins: '*', usage: true }],
    ['leading dash id', { id: '-team', label: 't', plugins: '*', usage: true }],
    ['too-long id', { id: 'a'.repeat(41), label: 't', plugins: '*', usage: true }],
    ['empty label', { id: 'team', label: '', plugins: '*', usage: true }],
    ['too-long label', { id: 'team', label: 'x'.repeat(61), plugins: '*', usage: true }],
    ['plugins not list or star', { id: 'team', label: 't', plugins: 'demo', usage: true }],
    ['non-string plugin entry', { id: 'team', label: 't', plugins: [1], usage: true }],
    ['unknown plugin id', { id: 'team', label: 't', plugins: ['demo', 'nope'], usage: true }],
    ['missing usage flag', { id: 'team', label: 't', plugins: '*' }],
    ['non-object body', 'team'],
  ])('rejects %s', (_name, raw) => {
    expect(validateCapabilityProfileInput(raw, catalogue).ok).toBe(false);
  });

  it('rejects built-in ids and never lets the operator overwrite them', () => {
    for (const p of BUILTIN_CAPABILITY_PROFILES) {
      const out = validateCapabilityProfileInput({ ...p, builtin: undefined }, catalogue);
      expect(out.ok).toBe(false);
    }
  });

  it('documents the id pattern it enforces', () => {
    expect(CAPABILITY_PROFILE_ID_RE.test('image-only')).toBe(true);
    expect(CAPABILITY_PROFILE_ID_RE.test('Image Only')).toBe(false);
  });
});
