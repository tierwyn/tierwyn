import type { Express, Request, Response } from 'express';
import express from 'express';
import type { Database } from 'better-sqlite3';
import { MIN_SECRET_LEN } from '../plugins/host.js';
import { vaultAvailable, vaultClear, vaultSet, vaultUnavailableReason } from '../plugins/vault.js';
import { INTEGRATIONS_VAULT_ID, refreshMcpRedactSet } from '../secrets/mcpRedact.js';
import { sidecarComplete, sidecarSiteReady } from '../sidecar.js';
import { catalogue } from '../catalogue.js';
import {
  AA_VAULT_KEY,
  AaError,
  dropAaCache,
  ensureCatalogue,
  formatTemplateDraft,
  matchAaSlug,
  peekAaCache,
  resolveAaKey,
  rowMetrics,
  type AaMatchKind,
  type AaRow,
} from '../aa/catalogue.js';

const MAX_KEY_LEN = 512;
const MAX_ROLE = 80;
const MAX_SIBLINGS = 12;
const MAX_WHEN = 200;

export const SUGGEST_SYSTEM = `You write ONE short "use when" routing hint for a model in an AI-agent delegation roster.
Rules: one line, at most 120 characters, no quotes, no markdown, no marketing words
(e.g. "powerful", "cutting-edge", "state-of-the-art"). Ground every claim ONLY in the
metrics and role given; never invent capabilities. Match the style of the existing hints.
Prefer task guidance ("use for …") plus at most two concrete numbers. Output only the line.`;

export const aaDeps = {
  sidecarComplete,
  sidecarSiteReady,
};

export interface AaRouteDeps {
  getDb: () => Database;
}

function fmtMetric(n: number | null): string {
  if (n == null) return 'n/a';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function postprocessDraft(text: string): string | null {
  const line = text.split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  let s = line.replace(/^['"`]+|['"`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > 160) {
    const cut = s.slice(0, 160);
    const sp = cut.lastIndexOf(' ');
    s = (sp > 0 ? cut.slice(0, sp) : cut).trim();
  }
  return s || null;
}

function candidateView(rows: AaRow[]): Array<{ slug: string; name: string; intel: number | null }> {
  return rows.map((r) => ({ slug: r.slug, name: r.name, intel: r.intel }));
}

function sendAaError(res: Response, e: unknown): void {
  if (e instanceof AaError) {
    if (e.code === 'aa_unauthorized') {
      res.status(502).json({ error: 'AA rejected the key (401)' });
      return;
    }
    if (e.code === 'aa_tier') {
      res.status(502).json({ error: 'Your AA tier does not cover this endpoint (403)' });
      return;
    }
    if (e.code === 'aa_quota') {
      res.status(429).json({ error: `AA quota exhausted; retry after ${e.retryAfter ?? 'a while'}` });
      return;
    }
  }
  res.status(502).json({ error: 'AA unreachable' });
}

function buildUserPrompt(opts: {
  role: string;
  agentType: string;
  label: string;
  aaName: string;
  match: AaMatchKind;
  metrics: ReturnType<typeof rowMetrics>;
  siblings: string[];
}): string {
  const m = opts.metrics;
  const hints = opts.siblings.length
    ? opts.siblings.map((s) => `- ${s}`).join('\n')
    : '- (none)';
  return [
    `Role: ${opts.role || '(unnamed)'}`,
    `Agent harness: ${opts.agentType}   Model: ${opts.label} (AA: ${opts.aaName}, match=${opts.match})`,
    `Metrics (Artificial Analysis): intel ${fmtMetric(m.intel)}, engineering ${fmtMetric(m.eng)}, $${fmtMetric(m.priceIn)}/$${fmtMetric(m.priceOut)} per Mtok, ${fmtMetric(m.tps)} tok/s`,
    'Roster context: highest intel among siblings is not known; compare only to these numbers.',
    'Existing hints in this template:',
    hints,
  ].join('\n');
}

function afterKeyMutation(db: Database): void {
  dropAaCache();
  refreshMcpRedactSet(db);
}

export function registerAaRoutes(app: Express, deps: AaRouteDeps): void {
  const r = express.Router();
  r.use(express.json({ limit: '32kb' }));

  r.get('/aa', (_req: Request, res: Response) => {
    const db = deps.getDb();
    const resolved = resolveAaKey(db);
    const peek = peekAaCache();
    res.json({
      configured: resolved !== null,
      source: resolved?.source ?? null,
      vaultAvailable: vaultAvailable(),
      tier: peek?.tier ?? null,
      fetchedAt: peek?.fetchedAt ?? null,
    });
  });

  r.put('/aa/key', (req: Request, res: Response) => {
    const value = typeof req.body?.value === 'string' ? req.body.value.trim() : '';
    if (value.length < MIN_SECRET_LEN || value.length > MAX_KEY_LEN) {
      res.status(400).json({ error: `value must be ${MIN_SECRET_LEN}–${MAX_KEY_LEN} characters` });
      return;
    }
    if (!vaultAvailable()) {
      res.status(503).json({ error: vaultUnavailableReason() });
      return;
    }
    const db = deps.getDb();
    vaultSet(db, INTEGRATIONS_VAULT_ID, AA_VAULT_KEY, value);
    afterKeyMutation(db);
    res.json({ ok: true });
  });

  r.delete('/aa/key', (_req: Request, res: Response) => {
    const db = deps.getDb();
    const cleared = vaultAvailable() ? vaultClear(db, INTEGRATIONS_VAULT_ID, AA_VAULT_KEY) : false;
    afterKeyMutation(db);
    res.json({ ok: true, cleared });
  });

  r.get('/aa/models', async (_req: Request, res: Response) => {
    const db = deps.getDb();
    const resolved = resolveAaKey(db);
    if (!resolved) {
      res.status(409).json({ error: 'Set an Artificial Analysis API key first' });
      return;
    }
    try {
      const cat = await ensureCatalogue(resolved.key);
      res.json({
        models: candidateView(cat.rows),
        tier: cat.tier,
        fetchedAt: cat.fetchedAt,
        ...(cat.stale ? { stale: true as const } : {}),
      });
    } catch (e) {
      sendAaError(res, e);
    }
  });

  r.post('/aa/suggest', async (req: Request, res: Response) => {
    const db = deps.getDb();
    const resolved = resolveAaKey(db);
    if (!resolved) {
      res.status(409).json({ error: 'Set an Artificial Analysis API key first' });
      return;
    }
    const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : '';
    if (!profileId) {
      res.status(400).json({ error: 'profileId is required' });
      return;
    }
    const profile = catalogue.getProfile(profileId);
    if (!profile) {
      res.status(400).json({ error: `unknown profile: ${profileId}` });
      return;
    }
    const role = typeof req.body?.role === 'string' ? req.body.role.trim().slice(0, MAX_ROLE) : '';
    const aaSlug = typeof req.body?.aaSlug === 'string' ? req.body.aaSlug.trim() : '';
    const rawSiblings = Array.isArray(req.body?.siblingWhens) ? req.body.siblingWhens : [];
    const siblings = rawSiblings
      .filter((s: unknown): s is string => typeof s === 'string')
      .map((s: string) => s.trim().slice(0, MAX_WHEN))
      .filter(Boolean)
      .slice(0, MAX_SIBLINGS);

    let cat;
    try {
      cat = await ensureCatalogue(resolved.key);
    } catch (e) {
      sendAaError(res, e);
      return;
    }

    let match: AaMatchKind;
    let row: AaRow | null;
    let candidates: AaRow[];
    if (aaSlug) {
      const found = cat.rows.find((x) => x.slug === aaSlug) ?? null;
      if (!found) {
        res.status(400).json({ error: `unknown AA slug: ${aaSlug}` });
        return;
      }
      match = 'override';
      row = found;
      const ranked = matchAaSlug(profile, cat.rows);
      candidates = [found, ...ranked.candidates.filter((c) => c.slug !== found.slug)].slice(0, 8);
    } else {
      const ranked = matchAaSlug(profile, cat.rows);
      match = ranked.match;
      row = ranked.row;
      candidates = ranked.candidates;
    }

    const stale = cat.stale ? { stale: true as const } : {};
    if (!row) {
      res.json({
        draft: null,
        source: 'template',
        match,
        aaModel: null,
        candidates: candidateView(candidates),
        metrics: null,
        tier: cat.tier,
        ...stale,
      });
      return;
    }

    const metrics = rowMetrics(row);
    let draft: string | null = null;
    let source: 'llm' | 'template' = 'template';
    let llmError: string | undefined;

    if (aaDeps.sidecarSiteReady(db, 'enhance')) {
      const userPrompt = buildUserPrompt({
        role,
        agentType: profile.agentType,
        label: profile.label,
        aaName: row.name,
        match,
        metrics,
        siblings,
      });
      try {
        const raw = await aaDeps.sidecarComplete(db, 'enhance', userPrompt, {
          systemPrompt: SUGGEST_SYSTEM,
          timeoutSecs: 30,
          oneShotMode: 'none', // ponytail: AA has no project cwd — always tools-off, even on an agent_readonly row (matches quick enhance)
        });
        draft = postprocessDraft(raw);
        if (draft) source = 'llm';
        else llmError = 'empty LLM reply';
      } catch (e) {
        llmError = e instanceof Error ? e.message : String(e);
      }
    } else {
      llmError = 'LLM not configured (Settings → Sidecar job routing → Enhance)';
    }
    if (!draft) draft = formatTemplateDraft(metrics);

    res.json({
      draft,
      source,
      ...(source === 'template' && llmError ? { llmError } : {}),
      match,
      aaModel: { slug: row.slug, name: row.name },
      candidates: candidateView(candidates),
      metrics,
      tier: cat.tier,
      ...stale,
    });
  });

  app.use('/settings', r);
}
