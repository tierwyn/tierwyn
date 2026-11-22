import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

function locateJsonlFile(claudeHome: string, nativeId: string): { dir: string; path: string } | null {
  const projectsDir = join(claudeHome, 'projects');
  if (!existsSync(projectsDir)) return null;
  for (const project of readdirSync(projectsDir)) {
    const file = join(projectsDir, project, `${nativeId}.jsonl`);
    if (existsSync(file)) return { dir: join(projectsDir, project), path: file };
  }
  return null;
}

function isRealUserPrompt(obj: Record<string, unknown>): boolean {
  if (obj.type !== 'user') return false;
  const message = obj.message as { role?: string; content?: unknown } | undefined;
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) return false;
  const blocks = message.content as { type?: string; text?: string }[];
  if (blocks.some((b) => b.type === 'tool_result')) return false;
  if ('toolUseResult' in obj) return false;
  return blocks.some((b) => b.type === 'text' && typeof b.text === 'string');
}

/** Fork a Claude JSONL session file, keeping the first `toTurn` user turns. */
export async function forkClaudeJsonl(
  claudeHome: string,
  nativeId: string,
  toTurn: number,
): Promise<string> {
  const located = locateJsonlFile(claudeHome, nativeId);
  if (!located) throw new Error(`native session file not found: ${nativeId}`);

  const raw = readFileSync(located.path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  let userTurn = 0;
  const kept: string[] = [];
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      kept.push(line);
      continue;
    }
    if (isRealUserPrompt(obj)) {
      userTurn += 1;
      if (userTurn > toTurn) break;
    }
    kept.push(line);
  }

  const newNative = randomUUID();
  const rewritten = kept.map((line) => {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if ('sessionId' in obj) {
        obj.sessionId = newNative;
        return JSON.stringify(obj);
      }
    } catch { /* keep raw line */ }
    return line;
  });

  writeFileSync(join(located.dir, `${newNative}.jsonl`), rewritten.join('\n') + (rewritten.length ? '\n' : ''));
  return newNative;
}

/** Fork a Claude JSONL session file, removing the Nth user turn (1-indexed,
 *  matching forkClaudeJsonl's isRealUserPrompt counting) and rewiring the
 *  parentUuid chain so the result remains resumable. Returns a new native
 *  session id; the original file is left on disk (fork, not mutate).
 *
 *  Cases:
 *   - Middle turn: chain rewired (afterHead.parentUuid = beforeTail.uuid),
 *     turns before AND after survive. Tool_use/tool_result pairs in the
 *     deleted turn stay together (excision is bounded by the next user
 *     prompt, and the agent always emits a tool_result before the next prompt).
 *   - Last turn: delegates to forkClaudeJsonl(claudeHome, nativeId, turnToRemove - 1)
 *     (a clean prefix truncation, no rewire needed).
 *   - First turn: beforeTail may be a preamble line (e.g. queue-operation) or
 *     null; afterHead.parentUuid is set to beforeTail?.uuid ?? null.
 *   - Single-turn file (only one user turn total): rejected — excising the
 *     only turn would leave an empty session. The caller should map this to
 *     a 400/409 with "delete the whole conversation instead" messaging.
 *
 *  Throws if the native file is not found, if turnToRemove is out of range,
 *  or if the file has only one user turn. */
export async function exciseTurnFromJsonl(
  claudeHome: string,
  nativeId: string,
  turnToRemove: number,
): Promise<string> {
  if (turnToRemove < 1) throw new Error(`turnToRemove must be >= 1 (got ${turnToRemove})`);

  const located = locateJsonlFile(claudeHome, nativeId);
  if (!located) throw new Error(`native session file not found: ${nativeId}`);

  const raw = readFileSync(located.path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Parse each line once; record (parsed, raw) so we keep unparseable lines verbatim.
  const parsed: { obj: Record<string, unknown> | null; raw: string }[] = lines.map((line) => {
    try {
      return { obj: JSON.parse(line) as Record<string, unknown>, raw: line };
    } catch {
      return { obj: null, raw: line };
    }
  });

  // Collect the line index of every user-prompt start (1-indexed turn ordinal).
  const promptLineIndices: number[] = [];
  parsed.forEach((entry, idx) => {
    if (entry.obj && isRealUserPrompt(entry.obj)) promptLineIndices.push(idx);
  });

  const totalTurns = promptLineIndices.length;
  if (totalTurns < 2) {
    throw new Error('cannot excise the only turn in a single-turn session; delete the conversation instead');
  }
  if (turnToRemove > totalTurns) {
    throw new Error(`turnToRemove ${turnToRemove} out of range (session has ${totalTurns} turn(s))`);
  }

  // Fast path: last-turn excision collapses to a prefix truncation.
  if (turnToRemove === totalTurns) {
    return forkClaudeJsonl(claudeHome, nativeId, turnToRemove - 1);
  }

  const startLine = promptLineIndices[turnToRemove - 1];
  const endLine = promptLineIndices[turnToRemove]; // guaranteed to exist (not last turn)

  // beforeTail = last kept line strictly before startLine (may be undefined).
  const beforeTail = startLine > 0 ? parsed[startLine - 1] : null;
  // afterHead = first kept line at/after endLine (the start of the next surviving turn).
  const afterHead = parsed[endLine];

  // Rewire: only afterHead needs its parentUuid changed. Lines after afterHead
  // still point at afterHead.obj.uuid which is preserved, so their chain is intact.
  // If afterHead has no parentUuid field we leave it untouched (the agent tolerates this;
  // verified for assistant text lines which always carry parentUuid in the Claude format).
  if (afterHead.obj && Object.prototype.hasOwnProperty.call(afterHead.obj, 'parentUuid')) {
    afterHead.obj.parentUuid = beforeTail?.obj?.uuid ?? null;
  }

  // Build the kept list: parsed[0..startLine) ++ parsed[endLine..).
  const keptEntries = [...parsed.slice(0, startLine), ...parsed.slice(endLine)];

  const newNative = randomUUID();
  const rewritten = keptEntries.map((entry) => {
    if (entry.obj && 'sessionId' in entry.obj) {
      entry.obj.sessionId = newNative;
      return JSON.stringify(entry.obj);
    }
    return entry.raw;
  });

  writeFileSync(join(located.dir, `${newNative}.jsonl`), rewritten.join('\n') + (rewritten.length ? '\n' : ''));
  return newNative;
}

export { isRealUserPrompt, locateJsonlFile };
