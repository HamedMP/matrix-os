import type { RelayMetadata } from "./relay.js";

/**
 * Structured per-hop timing for relayed collaboration requests (ENG-490), so a
 * preview's logs show how much of a shared-app open is spent at the owner VPS.
 *
 * Only coarse, non-identifying fields are written: no actor id, raw path,
 * scope/resource id, app id, or payload. Volume is capped per second so an
 * asset burst cannot flood logs; dropped lines are counted on the next line.
 */
const DEFAULT_MAX_LINES_PER_SECOND = 50;
const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const RUNTIME_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const APP_ASSET = /\/apps\/[^/]+\/assets\//;

function clampMs(value: number | null): number | null {
  if (value === null) return null;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function clampBytes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function createRelayTimingLogger(options: {
  log?: (prefix: string, payload: string) => void;
  now?: () => number;
  maxLinesPerSecond?: number;
} = {}): (metadata: RelayMetadata) => void {
  const log = options.log ?? ((prefix, payload) => console.info(prefix, payload));
  const now = options.now ?? (() => Date.now());
  const maxLines = options.maxLinesPerSecond ?? DEFAULT_MAX_LINES_PER_SECOND;
  let windowStart = Number.NEGATIVE_INFINITY;
  let linesInWindow = 0;
  let dropped = 0;
  return (metadata) => {
    const current = now();
    if (current - windowStart >= 1_000) {
      windowStart = current;
      linesInWindow = 0;
    }
    if (linesInWindow >= maxLines) {
      dropped += 1;
      return;
    }
    linesInWindow += 1;
    const method = metadata.method.toUpperCase();
    const payload = {
      route: metadata.routeKind,
      asset: APP_ASSET.test(metadata.path),
      method: KNOWN_METHODS.has(method) ? method : "OTHER",
      status: Number.isInteger(metadata.status) ? metadata.status : 0,
      outcome: metadata.outcome,
      durationMs: clampMs(metadata.durationMs),
      upstreamHeadersMs: clampMs(metadata.upstreamHeadersMs),
      requestBytes: clampBytes(metadata.requestBytes),
      responseBytes: clampBytes(metadata.responseBytes),
      runtimeId: metadata.runtimeId && RUNTIME_ID.test(metadata.runtimeId) ? metadata.runtimeId : null,
      ...(dropped > 0 ? { droppedSinceLast: dropped } : {}),
    };
    dropped = 0;
    log("[collaboration-relay] timing", JSON.stringify(payload));
  };
}
