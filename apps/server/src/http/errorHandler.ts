import type { NextFunction, Request, Response } from 'express';

/**
 * Terminal Express error middleware. Formats 4xx/5xx as `{ error }` with no
 * stack traces — `express.json` parse failures (400) and payload-too-large (413)
 * land here, as do unhandled route throws (500).
 */
export function apiErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) { next(err); return; }
  const raw = (err as { status?: unknown; statusCode?: unknown })?.status
    ?? (err as { statusCode?: unknown })?.statusCode;
  const status = typeof raw === 'number' && raw >= 400 && raw <= 599 ? raw : 500;
  if (status >= 500) console.error('[http] unhandled', req.method, req.path, err);
  res.status(status).json({
    error: status === 400 ? 'bad request' : status === 413 ? 'payload too large' : 'internal error',
  });
}
