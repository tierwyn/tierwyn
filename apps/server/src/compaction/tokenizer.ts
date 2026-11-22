import { encode } from 'gpt-tokenizer'; // cl100k_base by default

/**
 * Estimate token count for `text`.
 * - If `override` is supplied (e.g. an adapter's estimateTokenCount), use it.
 * - Otherwise use cl100k_base. If encoding throws for any reason, fall back to chars/4.
 */
export function estimateTokens(text: string, override?: (t: string) => number): number {
  if (!text) return 0;
  if (override) return override(text);
  try {
    return encode(text).length;
  } catch (err) {
    console.warn('[tokenizer] cl100k_base encode failed, using chars/4 fallback:', err);
    return Math.ceil(text.length / 4);
  }
}
