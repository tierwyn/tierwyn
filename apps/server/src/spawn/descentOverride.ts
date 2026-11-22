export type DescentOverrideResult =
  | { ok: true; profileId: string | undefined }
  | { ok: false; error: string };

type Role = { role: string; profileId: string };
type Template = { roles: Role[] };

function pickRoster(child?: Template, parent?: Template): Template | undefined {
  if (child && child.roles.length > 0) return child;
  if (parent && parent.roles.length > 0) return parent;
  return undefined;
}

export function resolveDescentOverride(input: {
  bearer: boolean;
  manual: boolean;
  childTemplate?: Template;
  parentTemplate?: Template;
  role?: string;
  profileId?: string;
  /** Plan Task 6 discrepancy: ids unknown to the catalogue defer to the route's
   *  `profile unavailable` check instead of the roster rejection. Omitted → always reject. */
  isKnownProfile?: (id: string) => boolean;
}): DescentOverrideResult {
  const role = input.role?.trim() || undefined;
  const profileId = input.profileId?.trim() || undefined;
  if (!role && !profileId) return { ok: true, profileId: undefined };

  if (input.manual) {
    const search = [...(input.childTemplate?.roles ?? []), ...(input.parentTemplate?.roles ?? [])];
    if (role) {
      const hit = search.find((r) => r.role === role);
      if (!hit) return { ok: false, error: `role "${role}" not found in the conversation template` };
      if (profileId && profileId !== hit.profileId) {
        return { ok: false, error: `role "${role}" maps to profile ${hit.profileId}, not ${profileId}` };
      }
      return { ok: true, profileId: hit.profileId };
    }
    return { ok: true, profileId };
  }

  if (input.bearer) {
    const roster = pickRoster(input.childTemplate, input.parentTemplate);
    if (!roster) return { ok: false, error: 'parent has no spawn template' };
    if (role) {
      const hit = roster.roles.find((r) => r.role === role);
      if (!hit) return { ok: false, error: `role "${role}" not found in the conversation template` };
      if (profileId && profileId !== hit.profileId) {
        return { ok: false, error: `role "${role}" maps to profile ${hit.profileId}, not ${profileId}` };
      }
      return { ok: true, profileId: hit.profileId };
    }
    const hit = roster.roles.find((r) => r.profileId === profileId);
    if (!hit && (!profileId || !input.isKnownProfile || input.isKnownProfile(profileId))) {
      return { ok: false, error: 'profile not in parent template roster' };
    }
    return { ok: true, profileId };
  }

  return { ok: false, error: 'parent has no spawn template' };
}
