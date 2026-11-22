import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentsInstallResult } from '@tierwyn/shared';

const TAIL_CAP = 4096;
export const CURLRC = 'speed-limit = 1024\nspeed-time = 30\nconnect-timeout = 30\nretry = 3\n';
const SAFE_PREREQ_RE = /^[a-z0-9][a-z0-9._+-]*$/;

/** Build a non-interactive prerequisite check/install prefix for Linux hosts.
 *  Checks `command -v <bin>` first; if missing, attempts passwordless sudo with
 *  apt-get / dnf / pacman, or fails fast with an explicit actionable error. */
export function buildPrereqPrefix(prereqs?: readonly string[]): string {
  if (!prereqs || prereqs.length === 0) return '';
  const checks: string[] = [];
  for (const bin of prereqs) {
    if (!SAFE_PREREQ_RE.test(bin)) throw new Error(`unsafe prereq binary name: ${bin}`);
    checks.push(
      `if ! command -v ${bin} >/dev/null 2>&1; then ` +
      `if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get update -qq && sudo -n apt-get install -y ${bin}; ` +
      `elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y ${bin}; ` +
      `elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -S --needed --noconfirm ${bin}; ` +
      `fi; ` +
      `command -v ${bin} >/dev/null 2>&1 || { echo "Missing required dependency '${bin}' — install it on the host (e.g. sudo apt-get install -y ${bin}) and retry." >&2; exit 1; }; ` +
      `fi`,
    );
  }
  return checks.join(' && ') + ' && ';
}

const NPM_PREFIX_MARK = ': tierwyn-npm-prefix;';

/** `npm i -g …` against a root-owned prefix (/usr) fails EACCES. Prefix the
 *  command with a runtime check: when the effective global lib dir (`npm prefix -g`
 *  honours an env prefix; npm itself exports npm_config_prefix=/usr to children,
 *  so an env prefix is not trusted blindly) is not writable, point npm at ~/.npm-global for this
 *  run only (env var — the operator's npmrc is never touched). ensureAgentPath
 *  already puts ~/.npm-global/bin on PATH. Non-npm commands pass through.
 *  ponytail: matches a leading `npm` only — an npm agent that gains `prereqs`
 *  (prefix comes first) must wrap before buildPrereqPrefix. */
export function withWritableNpmPrefix(cmd: string): string {
  if (!/^npm\s/.test(cmd) || cmd.includes(NPM_PREFIX_MARK)) return cmd;
  return (
    `{ _p=$(npm prefix -g 2>/dev/null); _d="$_p/lib/node_modules"; [ -d "$_d" ] || _d="$_p/lib"; ` +
    `if [ -z "$_p" ] || [ ! -w "$_d" ]; then unset NPM_CONFIG_PREFIX; export npm_config_prefix="$HOME/.npm-global"; mkdir -p "$npm_config_prefix/bin" "$npm_config_prefix/lib"; fi; ` +
    `${NPM_PREFIX_MARK} } && ${cmd}`
  );
}

/** Run a fixed install command (never caller-supplied) and never reject:
 *  a spawn error resolves code 1, a timeout kill resolves code null. */
export async function runInstall(
  cmd: string,
  opts?: { timeoutMs?: number; sh?: string; prereqs?: readonly string[] },
): Promise<AgentsInstallResult> {
  let fullCmd = cmd;
  try {
    fullCmd = `${buildPrereqPrefix(opts?.prereqs)}${withWritableNpmPrefix(cmd)}`;
  } catch (err) {
    return { code: 1, tail: String(err).slice(-TAIL_CAP) };
  }
  // Vendor `curl | bash` installers run plain curl with no stall timeout: a CDN
  // connection that goes idle mid-download hangs the install until our hard kill.
  // curl reads $CURL_HOME/.curlrc (vendor scripts don't pass -q), so abort+retry
  // any transfer slower than 1 KB/s for 30 s.
  const curlHome = mkdtempSync(join(tmpdir(), 'tierwyn-install-'));
  writeFileSync(join(curlHome, '.curlrc'), CURLRC);
  return new Promise((resolve) => {
    let done = false;
    let tail = '';
    const finish = (r: AgentsInstallResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rmSync(curlHome, { recursive: true, force: true });
      resolve(r);
    };
    const child = spawn(opts?.sh ?? '/bin/sh', ['-c', fullCmd], {
      cwd: homedir(),
      env: { ...process.env, CURL_HOME: curlHome },
      // Group leader so the timeout kill takes the whole tree with it — an
      // orphaned child would otherwise hold the stdio pipes open.
      detached: process.platform !== 'win32',
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* already gone */ }
    }, opts?.timeoutMs ?? 10 * 60_000);
    const onOut = (chunk: Buffer | string) => { tail = (tail + chunk).slice(-TAIL_CAP); };
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onOut);
    child.on('error', (err) => finish({ code: 1, tail: String(err).slice(-TAIL_CAP) }));
    child.on('close', (code) => finish({ code, tail }));
  });
}
