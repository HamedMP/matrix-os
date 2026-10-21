import type { Context } from 'hono';
import type { z } from 'zod/v4';
import type { AppStoreErrorCodeSchema } from '@matrix-os/contracts/app-store';
export class AppStoreError extends Error {
  constructor(readonly code: z.infer<typeof AppStoreErrorCodeSchema>) { super(`App Store ${code}`); }
}
export function storeFailure(c: Context, error: unknown) {
  if (error instanceof AppStoreError) {
    const statuses = { invalid: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, limit: 429, unavailable: 503 } as const;
    return c.json({ error: error.code }, statuses[error.code]);
  }
  if (error instanceof Error && error.name === 'BodyLimitError') return c.json({ error: 'limit' }, 413);
  console.error('[app-store] Request failed', error);
  return c.json({ error: 'unavailable' }, 503);
}
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
