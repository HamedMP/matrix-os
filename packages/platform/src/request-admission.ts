import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { timingSafeTokenEquals } from './platform-token.js';
import { EDGE_SECRET_HEADER } from './session-routing-proxy.js';
const RUNTIME_SELECTION_RATE_WINDOW_MS = 60_000;
const RUNTIME_SELECTION_RATE_MAX_KEYS = 10_000;

interface RateWindow {
  count: number;
  resetAt: number;
}

export function createBoundedRateLimiter(maxAttempts: number) {
  const windows = new Map<string, RateWindow>();
  return {
    check(key: string): boolean {
      const now = Date.now();
      const existing = windows.get(key);
      const window = !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + RUNTIME_SELECTION_RATE_WINDOW_MS }
        : existing;
      if (window.count >= maxAttempts) {
        windows.delete(key);
        windows.set(key, window);
        return false;
      }
      window.count += 1;
      windows.delete(key);
      windows.set(key, window);
      if (windows.size > RUNTIME_SELECTION_RATE_MAX_KEYS) {
        const oldestKey = windows.keys().next().value;
        if (oldestKey !== undefined && oldestKey !== key) windows.delete(oldestKey);
      }
      return true;
    },
  };
}

export function runtimeSelectionSourceKey(c: Context, edgeSecret: string | undefined): string {
  const presentedEdgeSecret = c.req.header(EDGE_SECRET_HEADER);
  const trustedEdge = Boolean(
    edgeSecret
    && presentedEdgeSecret
    && timingSafeTokenEquals(presentedEdgeSecret, edgeSecret),
  );
  if (trustedEdge) {
    const edgeSource = c.req.header('cf-connecting-ip')?.trim()
      ?? c.req.header('x-real-ip')?.trim()
      ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? 'unknown';
    return `edge:${edgeSource.slice(0, 128)}`;
  }

  if (process.env.K_SERVICE) {
    const forwarded = c.req.header('x-forwarded-for')
      ?.split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const clientAddress = forwarded?.at(-2);
    const loadBalancerAddress = forwarded?.at(-1);
    if (
      clientAddress
      && loadBalancerAddress
      && isIP(clientAddress) !== 0
      && isIP(loadBalancerAddress) !== 0
    ) {
      return `cloud-run:${clientAddress.slice(0, 128)}`;
    }
  }

  // Outside verified proxy paths, forwarding headers are client-controlled.
  try {
    const directAddress = getConnInfo(c).remote.address;
    if (typeof directAddress === 'string' && isIP(directAddress) !== 0) {
      return `direct:${directAddress.slice(0, 128)}`;
    }
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn('[platform] Direct connection source unavailable:', err instanceof Error ? err.name : typeof err);
    }
  }
  return 'direct';
}

