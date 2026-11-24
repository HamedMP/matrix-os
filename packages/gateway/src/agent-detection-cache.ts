import { lstat, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/**
 * One cached CLI probe scan (`--version`, login status) with stale-while-refresh.
 *
 * - Fresh window: the cached scan is returned as is.
 * - Stale window: an `allow_stale` read returns the cached scan at once and starts
 *   one background refresh, but only when the scan is servable (no transient
 *   probe failure) and the executable fingerprint is unchanged.
 * - Otherwise, or for a `fresh` read, the caller waits for (or joins) a scan.
 *
 * Holds a single entry; `invalidate()` (login/logout) drops it and prevents an
 * older in-flight scan from repopulating it.
 */
export function createDetectionCache<T>(options: {
  scan: () => Promise<T>;
  now: () => number;
  freshMs: number;
  staleMs: number;
  servableWhenStale: (result: T) => boolean;
  fingerprint?: () => Promise<string | null>;
  label: string;
}) {
  let cache: { result: T; verifiedAt: number; fingerprint: string | null } | null = null;
  let inFlight: Promise<T> | null = null;
  let generation = 0;

  function start(): Promise<T> {
    if (inFlight) return inFlight;
    const scanGeneration = generation;
    const task = (async () => {
      const fingerprint = options.fingerprint ? await options.fingerprint() : null;
      const result = await options.scan();
      if (scanGeneration === generation) cache = { result, verifiedAt: options.now(), fingerprint };
      return result;
    })();
    inFlight = task;
    const clear = () => { if (inFlight === task) inFlight = null; };
    task.then(clear, clear);
    return task;
  }

  async function read(mode: "allow_stale" | "fresh" = "allow_stale"): Promise<T> {
    const cached = cache;
    const time = options.now();
    if (cached && time >= cached.verifiedAt && time < cached.verifiedAt + options.freshMs) return cached.result;
    if (mode === "allow_stale" && cached && time >= cached.verifiedAt && time < cached.verifiedAt + options.staleMs
      && options.servableWhenStale(cached.result)) {
      const fingerprint = options.fingerprint ? await options.fingerprint() : null;
      if (fingerprint !== null && fingerprint === cached.fingerprint && cache === cached) {
        if (!inFlight) {
          start().catch((error: unknown) => {
            console.warn(`[agent-launcher] ${options.label} background refresh failed:`, error instanceof Error ? error.name : "UnknownError");
          });
        }
        return cached.result;
      }
    }
    return start();
  }

  return {
    read,
    /** The last completed scan and when it finished; never extends freshness. */
    current: () => cache,
    invalidate(): void {
      generation += 1;
      cache = null;
      inFlight = null;
    },
  };
}

/**
 * Cheap identity for the probed executables. An absolute path is stat'ed so an
 * upgrade in place changes it. PATH-resolved commands have no stable file here.
 */
export async function executableFingerprint(commands: readonly string[]): Promise<string | null> {
  const parts: string[] = [];
  for (const command of commands) {
    if (!isAbsolute(command)) { parts.push(`command:${command}`); continue; }
    try {
      const info = await stat(command);
      parts.push(`${command}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error)) throw error;
      // Missing or unreadable: never serve a stale scan for it.
      return null;
    }
  }
  return parts.join("|");
}

/**
 * Stat identity of credential files (path, inode, size, mtime, ctime). A
 * missing file is a distinct state, so logging in or out outside Matrix
 * (for example `codex logout` in a Terminal tab) changes the fingerprint and
 * a stale signed-in scan is never served.
 */
export async function credentialFileFingerprint(paths: readonly string[]): Promise<string | null> {
  const parts: string[] = [];
  for (const path of paths) {
    try {
      const info = await lstat(path);
      parts.push(`${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error)) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      parts.push(`${path}:absent`);
    }
  }
  return parts.join("|");
}
