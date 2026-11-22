import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { VOICE_PROVIDER_PRESETS, type DirectLlmProfile, type VoiceCleanupProvider } from '@tierwyn/shared';
import { clean } from '../adapters/whisper.js';
import {
  createDirectLlmProfile,
  deleteDirectLlmProfile,
  listDirectLlmProfiles,
  updateDirectLlmProfile,
} from '../repositories/settings.js';
import { assertOperatorEndpointIfPresent, OutboundUrlError } from '../net/outboundUrl.js';

/** Injectable for tests, same shape as sidecarDeps. */
export const directLlmDeps = { clean };

function isProvider(v: unknown): v is VoiceCleanupProvider {
  return typeof v === 'string' && v in VOICE_PROVIDER_PRESETS;
}

export function registerDirectLlmRoutes(app: Express, getDb: () => Database): void {
  app.get('/settings/direct-llm', (_req, res) => {
    res.json({ profiles: listDirectLlmProfiles(getDb()) });
  });

  app.post('/settings/direct-llm', (req, res) => {
    const body = (req.body ?? {}) as { label?: unknown; provider?: unknown };
    if (body.provider !== undefined && !isProvider(body.provider)) {
      res.status(400).json({ error: `invalid provider: ${String(body.provider)}` });
      return;
    }
    const input: Partial<Pick<DirectLlmProfile, 'label' | 'provider'>> = {};
    if (typeof body.label === 'string') input.label = body.label;
    if (isProvider(body.provider)) input.provider = body.provider;
    const result = createDirectLlmProfile(getDb(), input);
    res.json(result);
  });

  app.post('/settings/direct-llm/:id/test', async (req, res) => {
    const p = listDirectLlmProfiles(getDb()).find((x) => x.id === req.params.id);
    if (!p) {
      res.status(400).json({ ok: false, error: `unknown direct llm profile: ${req.params.id}` });
      return;
    }
    if (!p.configured) {
      res.status(400).json({ ok: false, error: 'profile not configured — set a model and base URL first' });
      return;
    }
    const started = Date.now();
    try {
      const reply = await directLlmDeps.clean(
        {
          provider: p.provider, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model,
          timeoutSecs: p.timeoutSecs, systemPrompt: 'Reply with the single word OK.',
        },
        'test',
      );
      res.json({ ok: true, reply: reply.slice(0, 200), latencyMs: Date.now() - started });
    } catch (e) {
      res.status(502).json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - started,
      });
    }
  });

  app.post('/settings/direct-llm/:id', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.provider !== undefined && !isProvider(body.provider)) {
      res.status(400).json({ error: `invalid provider: ${String(body.provider)}` });
      return;
    }
    if (body.label !== undefined && typeof body.label !== 'string') {
      res.status(400).json({ error: 'label must be a string' });
      return;
    }
    try {
      await assertOperatorEndpointIfPresent(body.baseUrl);
      res.json({ profiles: updateDirectLlmProfile(getDb(), req.params.id, req.body ?? {}) });
    } catch (err) {
      if (err instanceof OutboundUrlError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid direct llm profile' });
    }
  });

  app.delete('/settings/direct-llm/:id', (req, res) => {
    try {
      res.json(deleteDirectLlmProfile(getDb(), req.params.id));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid direct llm profile' });
    }
  });
}
