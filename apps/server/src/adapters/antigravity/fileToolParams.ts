/**
 * Antigravity stream-json often emits file-tool parameters as path-only
 * (`{ TargetFile }`). The native conversation DB step payload still carries
 * the full edit body (CodeContent / TargetContent / ReplacementContent).
 * These helpers recover that body so Conversation Overview / Turn Info can
 * render diffs.
 */

import { openAgentSqliteReadonly } from '../agentSqlite.js';
import path from 'path';
import type { PartialEvent } from './mapping.js';

/** Keys that make a tool_call input diffable in the web UI. */
const FILE_BODY_KEYS = [
  'CodeContent',
  'Contents',
  'TargetContent',
  'ReplacementContent',
  'old_string',
  'new_string',
  'content',
  'new_content',
  'streamContent',
  // agy 1.5 edit_file / write_file
  'Target',
  'Replacement',
  'Content',
] as const;

const FILE_MUTATING_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
  'write_file',
  'edit_file',
  // delete_file has no body to enrich
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasFileBody(input: Record<string, unknown>): boolean {
  return FILE_BODY_KEYS.some((k) => {
    const v = input[k];
    return typeof v === 'string' && v.length > 0;
  });
}

/** True when stream-json left us with a path (or empty) and no edit body. */
export function agyToolInputNeedsEnrichment(input: unknown): boolean {
  const rec = asRecord(input);
  if (hasFileBody(rec)) return false;
  return true;
}

/**
 * Scan a native agy step_payload for the richest JSON object that carries
 * file-edit body fields. Returns null when none found.
 */
export function extractAgyFileToolParamsFromStepPayload(payload: Buffer | string): Record<string, unknown> | null {
  const raw = typeof payload === 'string' ? payload : payload.toString('utf8');
  let best: Record<string, unknown> | null = null;
  let bestScore = 0;

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < raw.length; j++) {
      if (raw[j] === '{') depth++;
      else if (raw[j] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(raw.slice(i, j + 1)) as unknown;
            const rec = asRecord(obj);
            if (!hasFileBody(rec)) break;
            let score = Object.keys(rec).length;
            for (const k of FILE_BODY_KEYS) {
              if (typeof rec[k] === 'string') score += 10;
            }
            if (score > bestScore) {
              best = rec;
              bestScore = score;
            }
          } catch {
            // Not JSON at this offset.
          }
          break;
        }
      }
    }
  }
  return best;
}

/** Read one conversation step and extract file-tool body params, if any. */
export function readAgyStepFileToolParams(
  conversationsDir: string,
  conversationId: string,
  stepIndex: number,
): Record<string, unknown> | null {
  if (!conversationId || !Number.isFinite(stepIndex)) return null;
  const dbPath = path.join(conversationsDir, `${conversationId}.db`);
  let db: ReturnType<typeof openAgentSqliteReadonly> | undefined;
  try {
    db = openAgentSqliteReadonly(dbPath);
    const row = db.prepare('SELECT step_payload FROM steps WHERE idx = ?').get(stepIndex) as
      | { step_payload: Buffer | Uint8Array }
      | undefined;
    if (!row?.step_payload) return null;
    return extractAgyFileToolParamsFromStepPayload(Buffer.from(row.step_payload));
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export type EnrichAgyMappedFileToolsOpts = {
  conversationsDir: string;
  /** Injectable for tests; defaults to readAgyStepFileToolParams. */
  readParams?: (
    conversationsDir: string,
    conversationId: string,
    stepIndex: number,
  ) => Record<string, unknown> | null;
};

/**
 * After AgyStreamMapper.map(), ensure file-mutating tool_call events carry
 * edit bodies recovered from the native conversation DB so Conversation
 * Overview / Turn Info can join file_change → diff.
 */
export function enrichAgyMappedFileTools(
  mapped: PartialEvent[],
  frame: Record<string, unknown>,
  opts: EnrichAgyMappedFileToolsOpts,
): PartialEvent[] {
  if (frame.event !== 'step_update') return mapped;
  const step = asRecord(frame.step_update);
  if (String(step.step_type ?? '') !== 'tool') return mapped;

  const info = asRecord(step.tool_info);
  const name = String(info.name ?? step.tool_name ?? '');
  if (!FILE_MUTATING_TOOLS.has(name)) return mapped;

  const conversationId = String(step.conversation_id ?? '');
  const stepIndex = Number(step.step_index ?? NaN);
  if (!conversationId || !Number.isFinite(stepIndex)) return mapped;

  // Enrich only — never inject. The mapper emits exactly one file-tool
  // tool_call (on DONE); injecting one on ACTIVE (when the native DB already
  // holds the body) duplicated the card under the same toolUseId.
  const existing = mapped.find((e) => e.type === 'tool_call');
  if (!existing || existing.type !== 'tool_call') return mapped;
  const payload = existing.payload as { toolUseId: string; input?: unknown };
  const existingInput = asRecord(payload.input);
  if (!agyToolInputNeedsEnrichment(existingInput)) return mapped;

  const read = opts.readParams ?? readAgyStepFileToolParams;
  const rich = read(opts.conversationsDir, conversationId, stepIndex);
  if (!rich || !hasFileBody(rich)) return mapped;

  const enrichedCall: PartialEvent = {
    type: 'tool_call',
    payload: { toolUseId: payload.toolUseId, name, input: { ...existingInput, ...rich } },
  };
  return mapped.map((e) => (e === existing ? enrichedCall : e));
}
