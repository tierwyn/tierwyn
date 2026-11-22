import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import type { ProbedRateLimits } from '../claude-code/probeUsage.js';

export type { ProbedRateLimits };

export const KIRO_USAGE_PROBE_ARGS = ['chat', '--no-interactive', '/usage'] as const;

const TTL_MS = 20_000;
const TIMEOUT_MS = 8_000;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

let cache: { at: number; data: ProbedRateLimits } | undefined;
let inflight: Promise<ProbedRateLimits> | undefined;

const contextCache = new Map<string, { at: number; data: KiroContextUsage }>();
const contextInflight = new Map<string, Promise<KiroContextUsage>>();

export type KiroUsageSpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

export interface KiroContextUsage {
  contextWindowPct?: number;
  contextBreakdown?: {
    filesPct?: number;
    toolsPct?: number;
    responsesPct?: number;
    promptsPct?: number;
  };
}

export function kiroContextProbeArgs(resumeId: string): string[] {
  return ['chat', '--no-interactive', '--resume-id', resumeId, '/context'];
}

export function resetKiroUsageProbeForTests(): void {
  cache = undefined;
  inflight = undefined;
  contextCache.clear();
  contextInflight.clear();
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '').replace(/\r/g, '');
}

/** Map `kiro-cli chat --no-interactive /usage` output onto monthly credits.
 *  Older kiro-cli prints the table on stderr, newer versions on stdout — both are captured. */
export function parseKiroUsageText(raw: string): ProbedRateLimits {
  const text = stripAnsi(raw);
  const out: ProbedRateLimits = {};

  const header = text.match(/Estimated Usage \| resets on (\S+)(?: \| (.+))?$/m);
  if (header) {
    const at = Date.parse(header[1]);
    if (Number.isFinite(at)) out.monthlyResetsAt = at;
    const plan = header[2]?.trim();
    if (plan) out.subscriptionType = plan;
  }

  // First limited row wins. `(N used)` add-on/overage rows have no plan limit.
  const row = text.match(/^(.+?) \((\d+(?:\.\d+)?) of (\d+(?:\.\d+)?) covered in plan\)/m);
  if (row) {
    const used = Number(row[2]);
    const limit = Number(row[3]);
    if (Number.isFinite(used)) out.creditsUsed = used;
    if (Number.isFinite(limit)) out.creditsLimit = limit;
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      out.monthlyPct = clampPct((used / limit) * 100);
    }
  }

  return out;
}

/** Map `kiro-cli chat --no-interactive --resume-id <id> /context` output text. */
export function parseKiroContextText(raw: string): KiroContextUsage {
  const text = stripAnsi(raw);
  const out: KiroContextUsage = {};

  const overall = text.match(/Context window:\s*(\d+(?:\.\d+)?)%\s*used/i);
  if (overall) {
    const n = Number(overall[1]);
    if (Number.isFinite(n)) out.contextWindowPct = clampPct(n);
  }

  const breakdown: NonNullable<KiroContextUsage['contextBreakdown']> = {};
  const files = text.match(/Context files\s+(\d+(?:\.\d+)?)%/i);
  const tools = text.match(/Tools\s+(\d+(?:\.\d+)?)%/i);
  const responses = text.match(/Kiro responses\s+(\d+(?:\.\d+)?)%/i);
  const prompts = text.match(/Your prompts\s+(\d+(?:\.\d+)?)%/i);
  if (files) {
    const n = Number(files[1]);
    if (Number.isFinite(n)) breakdown.filesPct = clampPct(n);
  }
  if (tools) {
    const n = Number(tools[1]);
    if (Number.isFinite(n)) breakdown.toolsPct = clampPct(n);
  }
  if (responses) {
    const n = Number(responses[1]);
    if (Number.isFinite(n)) breakdown.responsesPct = clampPct(n);
  }
  if (prompts) {
    const n = Number(prompts[1]);
    if (Number.isFinite(n)) breakdown.promptsPct = clampPct(n);
  }
  if (Object.keys(breakdown).length > 0) out.contextBreakdown = breakdown;
  return out;
}

export async function probeKiroRateLimits(opts?: {
  cwd?: string;
  force?: boolean;
  spawnFn?: KiroUsageSpawnFn;
}): Promise<ProbedRateLimits> {
  if (!opts?.force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = doUsageProbe(opts).finally(() => { inflight = undefined; });
  return inflight;
}

export async function probeKiroContext(opts: {
  resumeId: string;
  cwd?: string;
  force?: boolean;
  spawnFn?: KiroUsageSpawnFn;
}): Promise<KiroContextUsage> {
  const key = opts.resumeId;
  if (!key) return {};
  if (!opts.force) {
    const hit = contextCache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  }
  const existing = contextInflight.get(key);
  if (existing) return existing;
  const pending = doContextProbe(opts).finally(() => { contextInflight.delete(key); });
  contextInflight.set(key, pending);
  return pending;
}

async function doUsageProbe(opts?: {
  cwd?: string;
  spawnFn?: KiroUsageSpawnFn;
}): Promise<ProbedRateLimits> {
  const data = parseKiroUsageText(await captureOutput(
    [...KIRO_USAGE_PROBE_ARGS],
    opts,
  ));
  cache = { at: Date.now(), data };
  return data;
}

async function doContextProbe(opts: {
  resumeId: string;
  cwd?: string;
  spawnFn?: KiroUsageSpawnFn;
}): Promise<KiroContextUsage> {
  const data = parseKiroContextText(await captureOutput(
    kiroContextProbeArgs(opts.resumeId),
    opts,
  ));
  contextCache.set(opts.resumeId, { at: Date.now(), data });
  return data;
}

/** Resolves to combined stdout+stderr text, or '' on any spawn/timeout/error. */
async function captureOutput(
  args: string[],
  opts?: { cwd?: string; spawnFn?: KiroUsageSpawnFn },
): Promise<string> {
  const spawnFn = opts?.spawnFn ?? ((cmd, args, o) => nodeSpawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'kiro') }));
  let child: ChildProcess;
  try {
    child = spawnFn('kiro-cli', args, { cwd: opts?.cwd });
  } catch {
    return '';
  }

  const chunks: string[] = [];
  child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));
  child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
  child.stdin?.on('error', () => {});
  child.stdin?.end();

  const raw = await new Promise<string>((resolve) => {
    const finish = (text: string) => {
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      finish('');
    }, TIMEOUT_MS);

    child.on('error', () => finish(''));
    child.on('close', () => finish(chunks.join('')));
  });

  return raw;
}
