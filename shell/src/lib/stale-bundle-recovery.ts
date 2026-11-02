export const STALE_BUNDLE_RECOVERY_STORAGE_KEY = "matrix:stale-bundle-recovery:v1";

const NEXT_STATIC_ASSET_PATTERN = /\/_next\/static\//i;
const WEBPACK_RUNTIME_PATTERN = /\bwebpack-[a-z0-9_-]{8,}\.js\b/i;
const CHUNK_LOAD_MESSAGE_PATTERN = /(?:Loading (?:CSS )?chunk\s+.+\s+failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module)/i;

export interface StaleBundleFailure {
  fingerprint: string;
  kind: "chunk-load";
}

interface RecoveryClaim {
  attemptedAt: number;
  fingerprint: string;
  version: 1;
}

interface RecoveryDependencies {
  now?: () => number;
  reload?: () => void;
  storage?: Storage;
}

export function classifyStaleBundleError(error: unknown): StaleBundleFailure | null {
  if (!(error instanceof Error)) return null;

  const details = `${error.message}\n${error.stack ?? ""}`;
  const isWebpackChunkError = error.name === "ChunkLoadError";
  const isNextAssetLoadError = NEXT_STATIC_ASSET_PATTERN.test(details)
    && CHUNK_LOAD_MESSAGE_PATTERN.test(error.message);
  if (!isWebpackChunkError && !isNextAssetLoadError) return null;

  return {
    fingerprint: details.match(WEBPACK_RUNTIME_PATTERN)?.[0]?.toLowerCase() ?? "unknown-next-runtime",
    kind: "chunk-load",
  };
}

export function recoverFromStaleBundleError(
  error: unknown,
  dependencies: RecoveryDependencies = {},
): boolean {
  const failure = classifyStaleBundleError(error);
  if (!failure) return false;
  const browserWindow = typeof window === "undefined" ? undefined : window;
  if (!dependencies.storage && !browserWindow) return false;

  const storage = dependencies.storage ?? browserWindow!.sessionStorage;
  const reload = dependencies.reload ?? (() => browserWindow!.location.reload());
  const now = dependencies.now ?? Date.now;

  try {
    const stored = storage.getItem(STALE_BUNDLE_RECOVERY_STORAGE_KEY);
    if (stored) {
      const claim = parseRecoveryClaim(stored);
      if (!claim || claim.fingerprint === failure.fingerprint) return false;
    }

    const claim: RecoveryClaim = {
      attemptedAt: now(),
      fingerprint: failure.fingerprint,
      version: 1,
    };
    storage.setItem(STALE_BUNDLE_RECOVERY_STORAGE_KEY, JSON.stringify(claim));
    reload();
    return true;
  } catch (err: unknown) {
    console.warn(
      "[stale-bundle-recovery] Automatic reload unavailable:",
      err instanceof Error ? err.name : typeof err,
    );
    return false;
  }
}

function parseRecoveryClaim(value: string): RecoveryClaim | null {
  try {
    const candidate: unknown = JSON.parse(value);
    if (!candidate || typeof candidate !== "object") return null;
    const claim = candidate as Partial<RecoveryClaim>;
    return claim.version === 1
      && typeof claim.attemptedAt === "number"
      && Number.isFinite(claim.attemptedAt)
      && typeof claim.fingerprint === "string"
      && claim.fingerprint.length > 0
      && claim.fingerprint.length <= 128
      ? claim as RecoveryClaim
      : null;
  } catch (err: unknown) {
    console.warn(
      "[stale-bundle-recovery] Ignoring an invalid recovery claim:",
      err instanceof Error ? err.name : typeof err,
    );
    return null;
  }
}
