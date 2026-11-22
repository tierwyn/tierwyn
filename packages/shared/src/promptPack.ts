import {
  PROMPT_NAME_MAX,
  type PromptCollectionEntry,
  validateCustomPrompt,
} from './promptCollection.js';

export const PROMPT_PACK_KIND = 'tierwyn-prompt-pack';
/** C30: exported files on disk may still carry the pre-rename kind. */
export const PROMPT_PACK_DOC_MAX_BYTES = 262_144;   // matches PACK_DOC_MAX_BYTES
export const PROMPT_PACK_MAX_PROMPTS = 200;

export interface PromptPack {
  kind: typeof PROMPT_PACK_KIND;
  version: 1;
  /** Optional operator-facing label for the file. Not stored on any entry. */
  title?: string;
  prompts: PromptCollectionEntry[];   // every entry origin:'custom'
}

export type ValidatePromptPackResult =
  | { ok: true; pack: PromptPack }
  | { ok: false; error: string };

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validatePromptPack(doc: unknown): ValidatePromptPackResult {
  if (!isRecord(doc)) return { ok: false, error: 'pack must be a JSON object' };

  let encoded: string;
  try {
    encoded = JSON.stringify(doc);
  } catch {
    return { ok: false, error: 'pack is not JSON-serialisable' };
  }
  if (utf8Bytes(encoded) > PROMPT_PACK_DOC_MAX_BYTES) {
    return { ok: false, error: `pack document exceeds ${PROMPT_PACK_DOC_MAX_BYTES} bytes` };
  }

  if (doc.kind !== PROMPT_PACK_KIND) {
    return { ok: false, error: 'not a Tierwyn prompt pack' };
  }
  if (doc.version !== 1) {
    return { ok: false, error: 'unsupported pack version' };
  }
  if (!Array.isArray(doc.prompts)) {
    return { ok: false, error: 'prompts must be an array' };
  }
  if (doc.prompts.length < 1) {
    return { ok: false, error: 'prompts must contain at least 1 prompt' };
  }
  if (doc.prompts.length > PROMPT_PACK_MAX_PROMPTS) {
    return { ok: false, error: `at most ${PROMPT_PACK_MAX_PROMPTS} prompts` };
  }

  const prompts: PromptCollectionEntry[] = [];
  for (let i = 0; i < doc.prompts.length; i++) {
    const inner = validateCustomPrompt(doc.prompts[i]);
    if (!inner.ok) {
      return { ok: false, error: `prompts[${i}]: ${inner.error}` };
    }
    prompts.push(inner.prompt);
  }

  const pack: PromptPack = {
    kind: PROMPT_PACK_KIND,
    version: 1,
    prompts,
  };
  if (doc.title !== undefined) {
    if (typeof doc.title !== 'string') {
      return { ok: false, error: `title must be ≤ ${PROMPT_NAME_MAX} characters` };
    }
    const title = doc.title.trim();
    if (title.length > PROMPT_NAME_MAX) {
      return { ok: false, error: `title must be ≤ ${PROMPT_NAME_MAX} characters` };
    }
    if (title) pack.title = title;
  }
  return { ok: true, pack };
}

/** Client-side: normalise entries into an import-ready document. */
export function buildPromptPack(entries: PromptCollectionEntry[], title?: string): PromptPack {
  const prompts = entries.map((e) => {
    const row: Record<string, unknown> = {
      name: e.name,
      description: e.description,
      body: e.body,
      origin: 'custom',
    };
    if (e.origin !== 'preset' && e.id) row.id = e.id;
    if (e.variables && e.variables.length > 0) row.variables = e.variables;
    return row as unknown as PromptCollectionEntry;
  });
  const pack: PromptPack = { kind: PROMPT_PACK_KIND, version: 1, prompts };
  const trimmed = title?.trim();
  if (trimmed) pack.title = trimmed;
  return pack;
}
