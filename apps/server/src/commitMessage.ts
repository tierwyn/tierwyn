import type { Database } from 'better-sqlite3';
import { COMMIT_MESSAGE_SYSTEM_PROMPT, DEFAULT_SIDECAR_TIMEOUTS } from '@tierwyn/shared';
import { sidecarComplete } from './sidecar.js';
import { getSidecarLlmSettings } from './repositories/settings.js';
import { localGitOps, type GitOps } from './git/remoteOps.js';

export { COMMIT_MESSAGE_SYSTEM_PROMPT };

/** Injectable so tests can stub the sidecar without hitting a network. */
export const commitMessageDeps = { sidecarComplete };

export const COMMIT_DIFF_BUDGET = 40_000;
/** Head of an over-budget diff still shown under the stat, so the model keeps
 *  some real content evidence instead of stats alone. */
export const COMMIT_DIFF_HEAD_CHARS = 20_000;
/** How many recent subjects to feed the model as style exemplars. */
export const COMMIT_EXEMPLAR_COUNT = 12;
/** ≥ read-only one-shot default (120s) so agent_readonly commit loops do not time out mid-read. */
export const COMMIT_TIMEOUT_SECS = DEFAULT_SIDECAR_TIMEOUTS.commit;

export function buildCommitMessagePrompt(args: {
  subjects: string[];
  fileCount: number;
  diff: string;
  diffStat?: string;
  /** Overrides the diff head shown under the stat; '' means "diff could not be
   *  materialised at all" and omits the head. Default: first COMMIT_DIFF_HEAD_CHARS. */
  diffHead?: string;
  /** Operator-configured diff head; also drives the whole-diff threshold (2×).
   *  Unset uses COMMIT_DIFF_HEAD_CHARS / COMMIT_DIFF_BUDGET. */
  maxDiffChars?: number;
}): { prompt: string; summarised: boolean } {
  const subjectsBlock = args.subjects.length > 0
    ? args.subjects.map((s) => `- ${s}`).join('\n')
    : '(no commit history yet — no house style to follow)';

  const maxDiffChars = args.maxDiffChars ?? COMMIT_DIFF_HEAD_CHARS;
  const diffBudget = args.maxDiffChars !== undefined ? args.maxDiffChars * 2 : COMMIT_DIFF_BUDGET;

  let summarised = false;
  let diffBlock = args.diff;
  if (args.diff.length > diffBudget) {
    summarised = true;
    const stat = args.diffStat ?? '';
    const head = args.diffHead ?? args.diff.slice(0, maxDiffChars);
    const headNote = head ? `, then the first ${head.length} characters of the diff` : '';
    diffBlock = `[diff too large to include in full (${args.diff.length} characters) — change stat${headNote} below]\n${stat}`
      + (head ? `\n\n[truncated diff]\n${head}` : '');
  }

  const prompt = `Recent commit subjects in this repository (newest first):
${subjectsBlock}

Staged changes (${args.fileCount} file(s)):
${diffBlock}

Write the commit message.`;

  return { prompt, summarised };
}

/** Hard ceiling on generated messages (chars). The model is told to keep bodies
 *  short; this only bounds pathological output before it reaches the textarea,
 *  the DB draft row, and the WS broadcast. */
export const COMMIT_MESSAGE_MAX_CHARS = 4_000;

/**
 * Model text → commit-message text for the textarea. Line 1 becomes the subject;
 * any remaining non-empty lines become the body (blank runs collapsed). The staged
 * diff and recent subjects fed to the model are untrusted repo content (any branch
 * under review can carry instruction-like text). Residual injection risk is accepted:
 * output is plain text the operator reads beside the same diff before pressing
 * Commit; worst case is a misleading message, not a shell or secret leak.
 */
export function sanitiseCommitMessage(raw: string): string {
  const text = raw.trim();
  const fenced = /^(?:```|~~~)/m.test(text);

  // Per-line control strip (bare CR / C0 controls hide prefix text in
  // `git log --oneline`) + trim; drop fence-marker lines. Blank lines are kept
  // because they separate subject from body.
  const lines = text.split(/\r?\n/)
    .map((l) => l.replace(/[\r\x00-\x1f]/g, ' ').trim())
    .filter((l) => !/^(?:```|~~~)/.test(l));

  // Subject = first non-empty line, skipping a trailing-colon preamble only when
  // the reply was fenced or labelled — plain "Subject:\n- body" subjects keep line 1.
  let i = lines.findIndex((l) => l.length > 0);
  if (i === -1) {
    throw new Error('sidecar commit: model returned no usable subject');
  }
  const labelled = /^(?:here.*|the )?(?:commit\s*message|subject)\s*:$/i.test(lines[i]!);
  if (lines.length > i + 1 && /:$/.test(lines[i]!) && (fenced || labelled)) i += 1;

  let subject = lines[i] ?? '';
  const bodyLines = lines.slice(i + 1);

  // Quote + label strip on the subject, twice so Subject: "feat: x" loses both layers.
  for (let k = 0; k < 2; k++) {
    if (
      (subject.startsWith('"') && subject.endsWith('"'))
      || (subject.startsWith("'") && subject.endsWith("'"))
      || (subject.startsWith('`') && subject.endsWith('`'))
    ) {
      subject = subject.slice(1, -1).trim();
    }
    subject = subject.replace(/^(?:commit\s*message|subject)\s*:\s*/i, '').trim();
  }

  // Drop a single trailing period.
  if (subject.endsWith('.')) subject = subject.slice(0, -1).trim();

  if (!subject) {
    throw new Error('sidecar commit: model returned no usable subject');
  }

  // Body: collapse blank runs to a single blank line, trim edges.
  const body: string[] = [];
  for (const l of bodyLines) {
    if (l.length === 0) {
      if (body.length > 0 && body[body.length - 1] !== '') body.push('');
    } else {
      body.push(l);
    }
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();

  let message = body.length > 0 ? `${subject}\n\n${body.join('\n')}` : subject;
  if (message.length > COMMIT_MESSAGE_MAX_CHARS) {
    // Cut at the last line boundary inside the cap so no half line survives.
    message = message.slice(0, COMMIT_MESSAGE_MAX_CHARS);
    const cut = message.lastIndexOf('\n');
    if (cut > 0) message = message.slice(0, cut);
  }
  return message;
}

export async function generateCommitMessage(
  db: Database,
  cwd: string,
  fileCount: number,
  ops: GitOps = localGitOps,
  remoteHostId?: string | null,
): Promise<{ message: string; summarised: boolean; fileCount: number }> {
  const route = getSidecarLlmSettings(db).commit;
  const maxDiffChars = route.maxInputChars;
  const diffBudget = route.maxInputChars !== undefined ? route.maxInputChars * 2 : COMMIT_DIFF_BUDGET;
  const subjects = await ops.recentSubjects(cwd, COMMIT_EXEMPLAR_COUNT);
  let diff: string;
  let diffHead: string | undefined;
  try {
    diff = await ops.stagedDiff(cwd);
  } catch {
    // Diff exceeded gitExec maxBuffer (or similar materialisation failure).
    // Force the --stat path with no diff head; genuine git breakage still
    // fails on stagedDiffStat. Size the sentinel against the live budget so
    // a raised maxInputChars cannot skip --stat.
    diff = 'x'.repeat(diffBudget + 1);
    diffHead = '';
  }
  const diffStat = diff.length > diffBudget ? await ops.stagedDiffStat(cwd) : undefined;
  const { prompt, summarised } = buildCommitMessagePrompt({
    subjects,
    fileCount,
    diff,
    diffStat,
    diffHead,
    maxDiffChars,
  });

  const raw = await commitMessageDeps.sidecarComplete(db, 'commit', prompt, {
    timeoutSecs: COMMIT_TIMEOUT_SECS,
    cwd,
    remoteHostId,
  });

  return {
    message: sanitiseCommitMessage(raw),
    summarised,
    fileCount,
  };
}
