import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DECISION_DEFAULTS, type DecisionSettings } from '@tierwyn/shared';
import { decide, decideDeps, callSystemOne, type Question } from './decide.js';

const settings: DecisionSettings = { ...DECISION_DEFAULTS, enabled: true, apiKey: 'sekret-key-123' };
const questions: Record<string, Question> = {
  a: { type: 'noul', instructions: 'Is a?' },
  b: { type: 'score', instructions: 'How b?', criteria: ['low', 'high'] },
};
const okBody = {
  answers: {
    a: { type: 'noul', noul: 0.2 },
    b: { type: 'score', score: 0.5, probabilities: { '0': 0.5, '1': 0.5 }, confidence: 0.7 },
  },
  model: 'jev-1.13.0',
  usage: { input_tokens: 42 },
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const orig = { ...decideDeps };
afterEach(() => {
  Object.assign(decideDeps, orig);
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('decide', () => {
  it('returns answers + model on 200; sends Bearer, pinned model, batched questions', async () => {
    const f = vi.fn(async () => json(200, okBody));
    decideDeps.fetch = f;
    const r = await decide('state-x', questions, { settings, consumer: 'notify' });
    expect(r?.model).toBe('jev-1.13.0');
    expect(r?.answers.a).toEqual({ type: 'noul', noul: 0.2 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sekret-key-123');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'jev-1.13.0', state: 'state-x', questions });
  });

  it('returns null when fetch aborts past the budget', async () => {
    decideDeps.fetch = (_url, init) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
    });
    expect(await decide('s', questions, { settings, consumer: 'notify', timeoutMs: 20 })).toBeNull();
  });

  it('returns null on 401 and does not retry', async () => {
    const f = vi.fn(async () => json(401, {}));
    decideDeps.fetch = f;
    expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns null on 422', async () => {
    const f = vi.fn(async () => json(422, {}));
    decideDeps.fetch = f;
    expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('retries 429 honouring Retry-After then succeeds', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(429, {}, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(200, okBody));
    decideDeps.fetch = f;
    const sleep = vi.fn(async () => {});
    decideDeps.sleep = sleep;
    const r = await decide('s', questions, { settings, consumer: 'notify', timeoutMs: 5000 });
    expect(r).not.toBeNull();
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('returns null when Retry-After exceeds remaining budget', async () => {
    const f = vi.fn(async () => json(429, {}, { 'retry-after': '10' }));
    decideDeps.fetch = f;
    const sleep = vi.fn(async () => {});
    decideDeps.sleep = sleep;
    expect(await decide('s', questions, { settings, consumer: 'notify', timeoutMs: 2000 })).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('disabled or empty key returns null without calling fetch', async () => {
    const f = vi.fn(async () => json(200, okBody));
    decideDeps.fetch = f;
    expect(await decide('s', questions, { settings: { ...settings, enabled: false }, consumer: 'notify' })).toBeNull();
    expect(await decide('s', questions, { settings: { ...settings, apiKey: '' }, consumer: 'notify' })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('returns null when an answer is missing or mistyped', async () => {
    decideDeps.fetch = async () => json(200, { ...okBody, answers: { a: okBody.answers.a } });
    expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
    decideDeps.fetch = async () => json(200, { ...okBody, answers: { ...okBody.answers, a: { type: 'score', score: 1, confidence: 1 } } });
    expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
    decideDeps.fetch = async () => json(200, { model: 'x' });
    expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
  });

  it('out-of-range noul/confidence/score make that answer absent (fail open), not the whole response', async () => {
    for (const bad of [-3, 7, 1.01, -0.01]) {
      decideDeps.fetch = async () => json(200, { ...okBody, answers: { ...okBody.answers, a: { type: 'noul', noul: bad } } });
      const r = await decide('s', questions, { settings, consumer: 'notify' });
      expect(r).not.toBeNull();
      expect(r?.answers.a).toBeUndefined();
    }
    const badB = (score: number, confidence: number) => ({ type: 'score', score, probabilities: {}, confidence });
    for (const b of [badB(11, 0.5), badB(-1, 0.5), badB(1, 1.5), badB(1, -0.1)]) {
      decideDeps.fetch = async () => json(200, { ...okBody, answers: { ...okBody.answers, b } });
      const r = await decide('s', questions, { settings, consumer: 'notify' });
      expect(r?.answers.b).toBeUndefined();
      expect(r?.answers.a).toEqual({ type: 'noul', noul: 0.2 });
    }
    decideDeps.fetch = async () => json(200, { ...okBody, answers: { ...okBody.answers, a: { type: 'noul', noul: 1 }, b: badB(10, 0) } });
    const edge = await decide('s', questions, { settings, consumer: 'notify' });
    expect(edge?.answers.a).toBeDefined();
    expect(edge?.answers.b).toBeDefined();
  });

  it('drops answer keys that were never asked (unvalidated extras never reach a consumer)', async () => {
    decideDeps.fetch = async () => json(200, {
      ...okBody, answers: { ...okBody.answers, t00: { type: 'noul', noul: 7 }, extra: { type: 'noul', noul: 0.9 } },
    });
    const r = await decide('s', questions, { settings, consumer: 'notify' });
    expect(Object.keys(r!.answers).sort()).toEqual(['a', 'b']);
  });

  it('returns null when the response model differs from the pinned model', async () => {
    decideDeps.fetch = async () => json(200, { ...okBody, model: 'some-other-model' });
    expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
  });

  it('drains the 429 body before retrying', async () => {
    const cancel = vi.fn(async () => {});
    const r429 = json(429, {}, { 'retry-after': '1' });
    Object.defineProperty(r429, 'body', { value: { cancel } });
    decideDeps.fetch = vi.fn().mockResolvedValueOnce(r429).mockResolvedValueOnce(json(200, okBody));
    decideDeps.sleep = async () => {};
    expect(await decide('s', questions, { settings, consumer: 'notify', timeoutMs: 5000 })).not.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('never logs apiKey or state', async () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    decideDeps.fetch = async () => json(200, okBody);
    await decide('distinctive-state-string', questions, { settings, consumer: 'notify' });
    decideDeps.fetch = async () => json(401, {});
    await decide('distinctive-state-string', questions, { settings, consumer: 'notify' });
    const out = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(out).toContain('[decide]');
    expect(out).not.toContain('sekret-key-123');
    expect(out).not.toContain('distinctive-state-string');
  });
  it('labels every log line with the consumer and never logs state, questions or key', async () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const secretQs: Record<string, Question> = { a: { type: 'noul', instructions: 'SECRET-QUESTION?' } };
    decideDeps.fetch = async () => json(200, { answers: { a: { type: 'noul', noul: 0.5 } }, model: 'jev-1.13.0' });
    await decide({ title: 'SECRET-TITLE' }, secretQs, { settings, consumer: 'autotag' });
    expect(log.mock.calls[0]![0]).toMatch(/^\[decide\] consumer=autotag model=/);
    decideDeps.fetch = async () => json(401, {});
    await decide({ title: 'SECRET-TITLE' }, secretQs, { settings, consumer: 'autotag' });
    expect(warn.mock.calls[0]![0]).toMatch(/^\[decide\] consumer=autotag failed:/);
    const out = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    for (const secret of ['SECRET-TITLE', 'SECRET-QUESTION', 'sekret-key-123']) expect(out).not.toContain(secret);
  });

  describe('usage recording', () => {
    const rec = () => {
      const record = vi.fn();
      decideDeps.record = record;
      return record;
    };

    it('records exactly one ok row with tokens, consumer and conversationId', async () => {
      const record = rec();
      decideDeps.fetch = async () => json(200, { ...okBody, usage: { input_tokens: 42, output_tokens: 7 } });
      await decide('s', questions, { settings, consumer: 'autotag', conversationId: 'conv-1' });
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0]).toMatchObject({
        consumer: 'autotag', conversationId: 'conv-1', model: 'jev-1.13.0', inputTokens: 42, outputTokens: 7, outcome: 'ok',
      });
      expect(typeof record.mock.calls[0]![0].ts).toBe('number');
    });

    it('records one failure row with the safe reason and no tokens', async () => {
      const record = rec();
      decideDeps.fetch = async () => json(500, {});
      expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
      expect(record).toHaveBeenCalledTimes(1);
      const row = record.mock.calls[0]![0];
      expect(row).toMatchObject({ consumer: 'notify', outcome: 'http 500' });
      expect(row.inputTokens).toBeUndefined();
      expect(row.outputTokens).toBeUndefined();
    });

    it('records timeout and network error reasons', async () => {
      const record = rec();
      decideDeps.fetch = async () => { throw new TypeError('fetch failed: secret-host'); };
      await decide('s', questions, { settings, consumer: 'notify' });
      expect(record.mock.calls[0]![0].outcome).toBe('network error');
      decideDeps.fetch = (_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)));
      await decide('s', questions, { settings, consumer: 'notify', timeoutMs: 20 });
      expect(record.mock.calls[1]![0].outcome).toBe('timeout');
    });

    it('records once (not per attempt) when 429 retries then succeeds', async () => {
      const record = rec();
      decideDeps.fetch = vi.fn().mockResolvedValueOnce(json(429, {})).mockResolvedValueOnce(json(429, {})).mockResolvedValueOnce(json(200, okBody));
      decideDeps.sleep = async () => {};
      await decide('s', questions, { settings, consumer: 'notify', timeoutMs: 5000 });
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0].outcome).toBe('ok');
    });

    it('records once as http 429 when every attempt is rate limited', async () => {
      const record = rec();
      decideDeps.fetch = vi.fn(async () => json(429, {}));
      decideDeps.sleep = async () => {};
      await decide('s', questions, { settings, consumer: 'notify', timeoutMs: 5000 });
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0].outcome).toBe('http 429');
    });

    it('missing usage → undefined tokens on an ok row', async () => {
      const record = rec();
      const { usage: _u, ...noUsage } = okBody;
      decideDeps.fetch = async () => json(200, noUsage);
      expect(await decide('s', questions, { settings, consumer: 'notify' })).not.toBeNull();
      const row = record.mock.calls[0]![0];
      expect(row.outcome).toBe('ok');
      expect(row.inputTokens).toBeUndefined();
      expect(row.outputTokens).toBeUndefined();
    });

    it('garbage token values → undefined', async () => {
      const record = rec();
      for (const bad of ['12', -1, null, 1.5, {}, [3]]) {
        decideDeps.fetch = async () => json(200, { ...okBody, usage: { input_tokens: bad, output_tokens: bad } });
        await decide('s', questions, { settings, consumer: 'notify' });
      }
      expect(record).toHaveBeenCalledTimes(6);
      for (const [row] of record.mock.calls) {
        expect(row.inputTokens).toBeUndefined();
        expect(row.outputTokens).toBeUndefined();
      }
    });

    it('NaN/Infinity (via a hostile parsed body) → undefined', async () => {
      const record = rec();
      decideDeps.fetch = async () => ({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ ...okBody, usage: { input_tokens: NaN, output_tokens: Infinity } }),
      }) as unknown as Response;
      await decide('s', questions, { settings, consumer: 'notify' });
      expect(record.mock.calls[0]![0].inputTokens).toBeUndefined();
      expect(record.mock.calls[0]![0].outputTokens).toBeUndefined();
    });

    it('a 200 that fails validation still records its tokens, with outcome bad response', async () => {
      const record = rec();
      decideDeps.fetch = async () => json(200, { ...okBody, answers: {}, usage: { input_tokens: 99, output_tokens: 1 } });
      expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
      expect(record.mock.calls[0]![0]).toMatchObject({ outcome: 'bad response', inputTokens: 99, outputTokens: 1 });
    });

    it('an unexpected throw is recorded as the generic reason, never its message', async () => {
      const record = rec();
      decideDeps.fetch = async () => json(200, null);
      expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
      expect(record.mock.calls[0]![0].outcome).toBe('error');
    });

    it('record throwing does not change the verdict (success or failure)', async () => {
      decideDeps.record = () => { throw new Error('disk full'); };
      decideDeps.fetch = async () => json(200, okBody);
      expect((await decide('s', questions, { settings, consumer: 'notify' }))?.model).toBe('jev-1.13.0');
      decideDeps.fetch = async () => json(401, {});
      expect(await decide('s', questions, { settings, consumer: 'notify' })).toBeNull();
    });

    it('disabled Jev records nothing', async () => {
      const record = rec();
      await decide('s', questions, { settings: { ...settings, enabled: false }, consumer: 'notify' });
      expect(record).not.toHaveBeenCalled();
    });

    it('callSystemOne defaults to consumer test with no conversationId', async () => {
      const record = rec();
      decideDeps.fetch = async () => json(200, okBody);
      await callSystemOne(settings, 's', questions);
      expect(record.mock.calls[0]![0]).toMatchObject({ consumer: 'test', conversationId: undefined });
    });
  });
});
