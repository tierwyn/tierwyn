/**
 * List voices from the Kokoro sidecar (native wrapper or Kokoro-FastAPI).
 * GET {base}/v1/audio/voices → { voices: [{ id, name }] } (or a bare string[]).
 */

import { safeFetch } from '../net/outboundUrl.js';

export interface KokoroVoice {
  id: string;
  name: string;
}

/** Prefix → short region/gender hint for the Settings dropdown. */
const PREFIX_HINT: Record<string, string> = {
  af: 'American ♀',
  am: 'American ♂',
  bf: 'British ♀',
  bm: 'British ♂',
  ef: 'Spanish ♀',
  em: 'Spanish ♂',
  ff: 'French ♀',
  hf: 'Hindi ♀',
  hm: 'Hindi ♂',
  if: 'Italian ♀',
  im: 'Italian ♂',
  jf: 'Japanese ♀',
  jm: 'Japanese ♂',
  pf: 'Portuguese ♀',
  pm: 'Portuguese ♂',
  zf: 'Chinese ♀',
  zm: 'Chinese ♂',
};

export function kokoroVoiceLabel(id: string): string {
  const m = /^([a-z]{2})_/.exec(id);
  const hint = m ? PREFIX_HINT[m[1]!] : undefined;
  return hint ? `${id} · ${hint}` : id;
}

export async function listKokoroVoices(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<KokoroVoice[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/audio/voices`;
  const res = await safeFetch(url, { signal }, 'operator-endpoint');
  if (!res.ok) {
    throw new Error(`kokoro voices ${res.status}`);
  }
  const body = await res.json() as unknown;
  return normalizeKokoroVoices(body);
}

/** Pure — unit-testable without a live sidecar. */
export function normalizeKokoroVoices(body: unknown): KokoroVoice[] {
  const raw: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { voices?: unknown }).voices)
      ? (body as { voices: unknown[] }).voices
      : [];

  const out: KokoroVoice[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      const id = item.trim();
      out.push({ id, name: id });
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as { id?: unknown; name?: unknown; voice?: unknown };
      const id = String(o.id ?? o.voice ?? o.name ?? '').trim();
      if (!id) continue;
      const name = String(o.name ?? id).trim() || id;
      out.push({ id, name });
    }
  }
  // Stable sort: American first-ish by prefix, then id.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
