/**
 * Admission budget of the app file bridge. Each app identity has its own rate
 * and in-flight budget, so one app hammering the bridge cannot starve another;
 * a global ceiling still bounds the total. The per-app registry is capped and
 * evicts the least recently used idle app.
 */

export interface AppFileAdmissionLimits {
  perAppRatePerMinute: number;
  perAppMaxInFlight: number;
  globalRatePerMinute: number;
  /** Concurrent requests across all apps, including body reads before the app is known. */
  globalMaxInFlight: number;
  maxTrackedApps: number;
  now: () => number;
}

export const APP_FILE_ADMISSION_DEFAULTS: AppFileAdmissionLimits = {
  perAppRatePerMinute: 120,
  perAppMaxInFlight: 8,
  globalRatePerMinute: 600,
  globalMaxInFlight: 32,
  maxTrackedApps: 256,
  now: Date.now,
};

const RATE_WINDOW_MS = 60_000;

interface Bucket { windowStart: number; requests: number; inFlight: number }

/** Releases a slot; a second call is a no-op. */
export type AppFileRelease = () => void;

export interface AppFileAdmission {
  /** A global in-flight slot, taken before the body is read. Null when at capacity. */
  enter(): AppFileRelease | null;
  /** The app's rate and in-flight slot plus one unit of the global rate. Null when either budget is spent. */
  admitApp(app: string): AppFileRelease | null;
  trackedApps(): number;
}

function once(release: () => void): AppFileRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

export function createAppFileAdmission(overrides: Partial<AppFileAdmissionLimits> = {}): AppFileAdmission {
  const limits = { ...APP_FILE_ADMISSION_DEFAULTS, ...overrides };
  const global: Bucket = { windowStart: 0, requests: 0, inFlight: 0 };
  // Insertion order is recency order: a touched app is re-inserted at the end.
  const apps = new Map<string, Bucket>();

  function refresh(bucket: Bucket, now: number): void {
    if (now - bucket.windowStart >= RATE_WINDOW_MS) { bucket.windowStart = now; bucket.requests = 0; }
  }

  /** The app's bucket, making room by evicting the least recently used idle app. Null when every tracked app is busy. */
  function bucketFor(app: string, now: number): Bucket | null {
    const existing = apps.get(app);
    if (existing) {
      apps.delete(app);
      apps.set(app, existing);
      return existing;
    }
    if (apps.size >= limits.maxTrackedApps) {
      let evicted = false;
      for (const [key, bucket] of apps) {
        if (bucket.inFlight === 0) { apps.delete(key); evicted = true; break; }
      }
      if (!evicted) return null;
    }
    const bucket: Bucket = { windowStart: now, requests: 0, inFlight: 0 };
    apps.set(app, bucket);
    return bucket;
  }

  return {
    enter() {
      if (global.inFlight >= limits.globalMaxInFlight) return null;
      global.inFlight++;
      return once(() => { global.inFlight--; });
    },
    admitApp(app) {
      const now = limits.now();
      refresh(global, now);
      if (global.requests >= limits.globalRatePerMinute) return null;
      const bucket = bucketFor(app, now);
      if (!bucket) return null;
      refresh(bucket, now);
      if (bucket.requests >= limits.perAppRatePerMinute || bucket.inFlight >= limits.perAppMaxInFlight) return null;
      global.requests++;
      bucket.requests++;
      bucket.inFlight++;
      return once(() => { bucket.inFlight--; });
    },
    trackedApps: () => apps.size,
  };
}
