import { describe, it, expect } from 'vitest';
import express from 'express';
import { apiErrorHandler } from './errorHandler.js';

describe('apiErrorHandler', () => {
  it('POST malformed JSON → 400 { error: bad request } with no stack', async () => {
    const app = express();
    app.use(express.json());
    app.post('/echo', (req, res) => res.json(req.body));
    app.use(apiErrorHandler);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      const text = await r.text();
      expect(r.status).toBe(400);
      expect(JSON.parse(text)).toEqual({ error: 'bad request' });
      expect(text).not.toMatch(/stack/i);
      expect(text).not.toMatch(/SyntaxError/);
    } finally {
      server.close();
    }
  });
});
