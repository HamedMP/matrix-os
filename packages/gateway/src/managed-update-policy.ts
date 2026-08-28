import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';

export function createManagedUpdatePolicy(options: { env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch } = {}) {
  const env = options.env ?? process.env;
  const managed = Boolean(env.MATRIX_MACHINE_ID);
  // Single bounded cache entry, expires after 30s and never outlives the hold.
  let cached: { allowed: boolean; until: number } | undefined;
  let pending: Promise<boolean> | undefined;
  function operator(authorization?: string): boolean {
    if (!env.UPGRADE_TOKEN || !authorization) return false;
    const a = Buffer.from(authorization), b = Buffer.from(`Bearer ${env.UPGRADE_TOKEN}`);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async function selectionAllowed(): Promise<boolean> {
    if (!managed) return true;
    if (cached && cached.until > Date.now()) return cached.allowed;
    if (pending) return pending;
    pending = (async () => {
      let allowed = false, until = Date.now() + 30_000;
      try {
        if (!env.PLATFORM_INTERNAL_URL || !env.UPGRADE_TOKEN || !/^[A-Za-z0-9_-]{1,128}$/.test(env.MATRIX_MACHINE_ID!)) return false;
        const url = new URL(`/backend-management/machines/${env.MATRIX_MACHINE_ID}/policy`, env.PLATFORM_INTERNAL_URL);
        const response = await (options.fetchFn ?? fetch)(url.toString(), {
          headers: { authorization: `Bearer ${env.UPGRADE_TOKEN}` }, signal: AbortSignal.timeout(3000), redirect: 'error',
        });
        if (!response.ok) { await response.body?.cancel(); return false; }
        const reader = response.body?.getReader();
        if (!reader) return false;
        let size = 0, text = '';
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 4096) { await reader.cancel(); throw new Error('Oversized policy'); }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
        const policy = z.object({ managed: z.literal(true), versionSelectionAllowed: z.boolean(), holdUntil: z.iso.datetime().nullable() }).parse(JSON.parse(text));
        allowed = policy.versionSelectionAllowed && Boolean(policy.holdUntil && Date.parse(policy.holdUntil) > Date.now());
        if (allowed) until = Math.min(until, Date.parse(policy.holdUntil!));
      } catch (err: unknown) {
        console.warn('[managed-update] Support policy unavailable', err instanceof Error ? err.name : typeof err);
      } finally { cached = { allowed, until }; }
      return allowed;
    })();
    try { return await pending; } finally { pending = undefined; }
  }
  return { managed, operator, selectionAllowed, async canSelect(authorization?: string, customerProxy?: string) { return !managed || (customerProxy !== '1' && operator(authorization)) || await selectionAllowed(); } };
}
