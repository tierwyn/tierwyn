/**
 * Assemble the text blob sent to an adapter on handlePrompt.
 *
 * Bare-prompt adapters (grok-bot) never get the spawn/schedule preamble or a
 * Bearer — but they DO receive handoff priming when a ResumePlan produced one.
 * Spawn children also get a host/CWD/RESULT protocol note on every new turn.
 */

export function assembleAgentPromptText(opts: {
  barePrompt: boolean;
  userText: string;
  delegationPreamble?: string;
  primingPrompt?: string;
  /** Prepended first on the non-bare path (remote host facts). Ignored when bare. */
  hostNote?: string;
  /** Prepended ahead of priming for bare adapters only (e.g. host/cwd note). */
  barePrimingNote?: string;
  /** Spawn-child protocol note for bare adapters (host/CWD/RESULT path). */
  bareChildNote?: string;
  /** Recalled memories block. Placed immediately before userText on the non-bare path; ignored when bare. */
  recalledMemories?: string;
}): string {
  if (opts.barePrompt) {
    const primingBlock = opts.primingPrompt
      ? [opts.barePrimingNote, opts.primingPrompt].filter(Boolean).join('\n\n')
      : undefined;
    return [opts.bareChildNote, primingBlock, opts.userText].filter(Boolean).join('\n\n');
  }
  return [opts.hostNote, opts.delegationPreamble, opts.primingPrompt, opts.recalledMemories, opts.userText].filter(Boolean).join('\n\n');
}

/** `{cwd}/.tierwyn/delegates/{roleSlug}-{childId8}-RESULT.md` (C18). */
export function bareChildResultPath(cwd: string, role: string | undefined, childId: string): string {
  const slug = slugRole(role);
  const childId8 = childId.slice(0, 8);
  return `${cwd}/.tierwyn/delegates/${slug}-${childId8}-RESULT.md`;
}

function slugRole(role: string | undefined): string {
  const slug = (role ?? 'grok-bot')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'grok-bot';
}

/** Server-baked host/CWD/RESULT instructions for a bare-prompt spawn child. */
export function buildBareChildProtocolNote(opts: {
  hostname: string;
  cwd: string;
  resultPath: string;
}): string {
  return [
    `Host: ${opts.hostname} · Project directory: ${opts.cwd} · Write your final RESULT to: ${opts.resultPath} (create parent directories if needed).`,
    '',
    'End with a "## Result" that lists (1) every file you touched (full paths), (2) key decisions, (3) anything needed to continue. Also write the same content to the RESULT path above. Do not answer with only "Done" or "OK".',
    '',
    'Host writes: do not change this host\'s desktop or filesystem except writing that RESULT file, unless the task text explicitly asks for more (for example inspecting or editing project files). In "## Result", include "Host writes: none" or "Host writes: yes" followed by the paths. Listing only the RESULT file under "Host writes: yes" is fine.',
    '',
    'Later messages in this chat continue the same task.',
  ].join('\n');
}

/** Host/CWD framing for bare-prompt handoff priming (Grok Bot computer use). */
export function buildBarePrimingHostNote(opts: {
  hostname: string;
  cwd?: string | null;
}): string {
  const host =
    `Computer Hostname for this conversation is "${opts.hostname}" ` +
    `(same value as Server resources → Host System → Hostname).`;
  if (opts.cwd) {
    return (
      `${host} Paths and "CWD" / working-directory references in the handoff ` +
      `summary below refer to this conversation's working directory on that host: ${opts.cwd}.`
    );
  }
  return (
    `${host} Paths and "CWD" / working-directory references in the handoff ` +
    `summary below refer to this conversation's working directory on that host.`
  );
}
