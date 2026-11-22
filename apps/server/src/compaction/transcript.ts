import type { TranscriptEvent } from '@tierwyn/shared';
import { estimateTokens } from './tokenizer.js';
import { sanitizeToken } from '../spawn/prose.js';

// ponytail: tool I/O is ~90% of the tokens fed to the summariser but carries
// almost none of the narrative signal (tool_results are file dumps / command
// output; tool_call inputs are verbose JSON). When compactToolIo is on
// (summary/compactor path) we trim tool_result bodies to head+tail and reduce
// tool_call to name + primary arg. The `transcript` handoff mode leaves it OFF
// to honour its "full transcript verbatim — use it as context" contract.
const TOOL_RESULT_BUDGET = 500; // chars; longer bodies keep head+tail only
const TOOL_INPUT_KEYS = ['file_path', 'path', 'command', 'query', 'pattern', 'url', 'prompt', 'description'];

/** Reduce a tool_call input object to its most identifying argument (which file,
 *  what command) rather than the full JSON. Falls back to a key list. */
function summariseToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  for (const k of TOOL_INPUT_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v) {
      return `${k}=${v.length > 120 ? v.slice(0, 120) + '…' : v}`;
    }
  }
  const keys = Object.keys(rec);
  return keys.length ? `{${keys.join(',')}}` : '';
}

/** Keep the head and tail of a long tool_result; the middle is rarely load-bearing
 *  for compaction and is where the token bloat lives. */
function truncateBody(body: string): string {
  if (body.length <= TOOL_RESULT_BUDGET) return body;
  const head = body.slice(0, 400);
  const tail = body.slice(-80);
  return `${head}\n…[${body.length - 480} chars elided]…\n${tail}`;
}

/** Operator !-shell blocks must never render as TOOL(shell) — that would misattribute
 *  the action to the agent. Caps role-tag parallels USER:/ASSISTANT:/TOOL(...) lanes. */
const SHELL_ATTRIB_HEADER =
  "OPERATOR SHELL (run by the human operator via Tierwyn's ! prefix — NOT by you, the agent):";

function lineFor(
  e: TranscriptEvent,
  compactToolIo: boolean,
  shellIds: Set<string>,
): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'prompt': {
      if (p.source === 'subagent_notify') {
        const sub = (p.subagent as { role?: string } | undefined);
        const role = sanitizeToken(sub?.role, 'sub-agent');
        return `SUBAGENT (${role}): ${String(p.text ?? '')}`;
      }
      if (p.source === 'peer_message') {
        const sub = (p.subagent as { role?: string } | undefined);
        const role = sanitizeToken(sub?.role, 'peer');
        return `PEER (${role}): ${String(p.text ?? '')}`;
      }
      if (p.source === 'parent_message') {
        const sub = (p.subagent as { role?: string } | undefined);
        const role = sanitizeToken(sub?.role, 'ancestor');
        return `PARENT (${role}): ${String(p.text ?? '')}`;
      }
      const text = String(p.text ?? '');
      const atts = (p.attachments as { mediaType?: string; name?: string }[] | undefined) ?? [];
      const images = atts.filter((a) => (a.mediaType ?? '').toLowerCase().startsWith('image/'));
      if (images.length === 0) return `USER: ${text}`;
      const names = images.map((a) => a.name).filter(Boolean).join(', ');
      const tag = names
        ? `[${images.length} image(s) attached: ${names}]`
        : `[${images.length} image(s) attached]`;
      return `USER: ${text ? `${text} ` : ''}${tag}`;
    }
    case 'message': {
      const chunk = String(p.chunk ?? '');
      return chunk ? `ASSISTANT: ${chunk}` : null;
    }
    case 'tool_call': {
      const name = String(p.name ?? '?');
      if (name === 'shell') {
        const cmd = String((p.input as { command?: string } | undefined)?.command ?? '');
        return `${SHELL_ATTRIB_HEADER}\n$ ${cmd}`;
      }
      if (!compactToolIo) return `TOOL(${name}): ${JSON.stringify(p.input ?? {})}`;
      const summary = summariseToolInput(p.input);
      return summary ? `TOOL(${name}): ${summary}` : `TOOL(${name})`;
    }
    case 'tool_result': {
      const content = String(p.content ?? '');
      if (shellIds.has(String(p.toolUseId ?? ''))) {
        return `OPERATOR SHELL OUTPUT:\n${compactToolIo ? truncateBody(content) : content}`;
      }
      return `TOOL_RESULT: ${compactToolIo ? truncateBody(content) : content}`;
    }
    case 'file_change': return `FILE ${String(p.kind ?? 'modified')}: ${String(p.path ?? '')}`;
    case 'error': return `ERROR: ${String(p.message ?? '')}`;
    default: return null;
  }
}

export function buildTranscript(
  events: TranscriptEvent[],
  opts: { maxTokens: number; compactToolIo?: boolean; proseOnly?: boolean },
): string {
  const compactToolIo = opts.compactToolIo ?? false;
  const proseOnly = opts.proseOnly ?? false;
  // Pre-pass: tool_result payloads have no name — pair shell results via toolUseId.
  const shellIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'tool_call' && (e.payload as { name?: string }).name === 'shell') {
      const id = (e.payload as { toolUseId?: string }).toolUseId;
      if (id) shellIds.add(id);
    }
  }
  const lines: string[] = [];
  for (const e of events) {
    if (proseOnly && e.type !== 'prompt' && e.type !== 'message') continue;
    const line = lineFor(e, compactToolIo, shellIds);
    if (line) lines.push(line);
  }

  const kept: string[] = [];
  let tokens = 0;
  let truncated = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = estimateTokens(lines[i]);
    if (tokens + t > opts.maxTokens && kept.length > 0) { truncated = true; break; }
    kept.unshift(lines[i]);
    tokens += t;
  }

  const body = kept.join('\n');
  return truncated ? `[earlier history truncated]\n${body}` : body;
}
