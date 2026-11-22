/**
 * Conversation designation — one optional function chip per conversation.
 *
 * Built-ins live in code (undeletable). Customs live in settings and are
 * capped. Spawn and PATCH only pick from the combined catalogue; a stored
 * token may outlive a deleted custom so old chips keep showing.
 */

export const BUILTIN_DESIGNATIONS = [
  'orchestrator', 'planner', 'implementer', 'reviewer', 'research',
] as const;

export type BuiltinDesignation = typeof BUILTIN_DESIGNATIONS[number];

export const MAX_CUSTOM_DESIGNATIONS = 8;
export const MAX_DESIGNATION_LENGTH = 24;

export type DesignationParseResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

export type OptionalDesignationResult =
  | { ok: true; token: string | null }
  | { ok: false; error: string };

const TOKEN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function parseDesignationToken(raw: unknown): DesignationParseResult {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'designation must be a string' };
  }
  const token = raw.trim().toLowerCase();
  if (!token) {
    return { ok: false, error: 'designation must be one word or a hyphenated-word' };
  }
  if (token.length > MAX_DESIGNATION_LENGTH) {
    return { ok: false, error: `designation must be at most ${MAX_DESIGNATION_LENGTH} characters` };
  }
  if (!TOKEN.test(token)) {
    return { ok: false, error: 'designation must be one word or a hyphenated-word' };
  }
  return { ok: true, token };
}

export function parseOptionalDesignation(raw: unknown): OptionalDesignationResult {
  if (raw === null || raw === undefined) return { ok: true, token: null };
  if (typeof raw === 'string' && raw.trim() === '') return { ok: true, token: null };
  const parsed = parseDesignationToken(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, token: parsed.token };
}

export function designationCatalogue(custom: readonly string[]): string[] {
  return [...BUILTIN_DESIGNATIONS, ...custom];
}

export function isKnownDesignation(token: string, custom: readonly string[]): boolean {
  return designationCatalogue(custom).includes(token);
}

export function addCustomDesignation(
  custom: readonly string[],
  raw: unknown,
): { ok: true; custom: string[] } | { ok: false; error: string } {
  const parsed = parseDesignationToken(raw);
  if (!parsed.ok) return parsed;
  if ((BUILTIN_DESIGNATIONS as readonly string[]).includes(parsed.token)) {
    return { ok: false, error: `"${parsed.token}" is a built-in designation` };
  }
  if (custom.includes(parsed.token)) {
    return { ok: false, error: `"${parsed.token}" is already in the catalogue` };
  }
  if (custom.length >= MAX_CUSTOM_DESIGNATIONS) {
    return { ok: false, error: `at most ${MAX_CUSTOM_DESIGNATIONS} custom designations` };
  }
  return { ok: true, custom: [...custom, parsed.token] };
}

export function removeCustomDesignation(
  custom: readonly string[],
  raw: unknown,
): { ok: true; custom: string[] } | { ok: false; error: string } {
  const parsed = parseDesignationToken(raw);
  if (!parsed.ok) return parsed;
  if ((BUILTIN_DESIGNATIONS as readonly string[]).includes(parsed.token)) {
    return { ok: false, error: 'built-in designations cannot be removed' };
  }
  if (!custom.includes(parsed.token)) {
    return { ok: false, error: `"${parsed.token}" is not a custom designation` };
  }
  return { ok: true, custom: custom.filter((t) => t !== parsed.token) };
}

export function resolveSpawnDesignation(opts: {
  requested?: unknown;
  roleDefault?: string;
  custom: readonly string[];
}): { ok: true; token: string | undefined } | { ok: false; error: string } {
  if (Object.prototype.hasOwnProperty.call(opts, 'requested')) {
    const parsed = parseOptionalDesignation(opts.requested);
    if (!parsed.ok) return parsed;
    if (parsed.token === null) return { ok: true, token: undefined };
    if (!isKnownDesignation(parsed.token, opts.custom)) {
      return { ok: false, error: `unknown designation: ${parsed.token}` };
    }
    return { ok: true, token: parsed.token };
  }
  if (opts.roleDefault && isKnownDesignation(opts.roleDefault, opts.custom)) {
    return { ok: true, token: opts.roleDefault };
  }
  return { ok: true, token: undefined };
}
