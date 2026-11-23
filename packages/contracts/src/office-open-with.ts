import { z } from "zod/v4";
import { APP_FILE_MAX_BYTES, AppFilePathSchema, isAppReachableFilePath } from "#app-files";

/**
 * Open-with contract: which default app owns a file type, and how Files hands
 * a file to that app.
 *
 * Files writes an `OpenRequest` to the target app's key-value store under
 * `OPEN_REQUEST_KV_KEY`, then launches or focuses the app. The app reads the
 * request on load (`MatrixOS.files.openRequest()`) and on later changes
 * (`MatrixOS.files.onOpenRequest(cb)`).
 */
export const OFFICE_APP_SLUGS = ["docs", "sheets"] as const;
export type OfficeAppSlug = (typeof OFFICE_APP_SLUGS)[number];

/** Lower-case extension, without the dot, to the app that opens it. */
export const OFFICE_FILE_TYPES: Readonly<Record<string, { readonly app: OfficeAppSlug; readonly mimeType: string }>> = Object.freeze({
  docx: Object.freeze({ app: "docs", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
  xlsx: Object.freeze({ app: "sheets", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  csv: Object.freeze({ app: "sheets", mimeType: "text/csv" }),
  tsv: Object.freeze({ app: "sheets", mimeType: "text/tab-separated-values" }),
});

function officeFileType(name: string) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // A leading dot marks a hidden file with no stem; `~$` marks an owner lock file.
  if (dot <= 0 || base.startsWith("~$")) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  return Object.hasOwn(OFFICE_FILE_TYPES, extension) ? OFFICE_FILE_TYPES[extension]! : null;
}
/** The default app for a file name or path: `.docx` opens in docs; `.xlsx`,
 * `.csv` and `.tsv` open in sheets; anything else has no default app. */
export function defaultAppForFile(name: string): OfficeAppSlug | null {
  return officeFileType(name)?.app ?? null;
}
/**
 * True when Files should hand `path` to its default app: it has one, the app
 * file route can reach it (not a dot directory, `system/`, `agents/` or a
 * denied subtree) and, when the listing knows its size, it fits the app read
 * cap. Anything else opens in Preview, which can still show it.
 */
export function canOpenWithDefaultApp(path: string, sizeBytes?: number | null): boolean {
  if (!defaultAppForFile(path) || !isAppReachableFilePath(path)) return false;
  return sizeBytes === undefined || sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes <= APP_FILE_MAX_BYTES;
}
/** The media type of a file that has a default app, or null. */
export function officeMimeTypeForFile(name: string): string | null {
  return officeFileType(name)?.mimeType ?? null;
}

/** Key in the target app's key-value store. The store keeps only `[a-zA-Z0-9_-]`. */
export const OPEN_REQUEST_KV_KEY = "open-request";
/** A request older than this is dropped. It covers a first launch that builds the app. */
export const OPEN_REQUEST_TTL_MS = 10 * 60_000;
/** Tolerated clock difference for a request stamped in the future. */
export const OPEN_REQUEST_MAX_FUTURE_SKEW_MS = 60_000;
export const OPEN_REQUEST_MAX_LISTENERS = 32;
const SEEN_NONCES = 32;

export const OpenRequestSchema = z.strictObject({
  /** Home-relative path, same rules as the file bridge. */
  path: AppFilePathSchema,
  /** ISO 8601 UTC time at which Files made the request. */
  requestedAt: z.iso.datetime(),
  /** Unique per request, so an app opens each request once. */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});
export type OpenRequest = z.infer<typeof OpenRequestSchema>;

export interface OpenRequestStamp { now: Date | number; nonce: string }

/** Builds a request. The caller supplies the time and a fresh nonce
 * (`crypto.randomUUID()`), which keeps this function pure. Throws on invalid input. */
export function createOpenRequest(path: string, stamp: OpenRequestStamp): OpenRequest {
  const time = new Date(stamp.now);
  if (Number.isNaN(time.getTime())) throw new RangeError("Invalid open request time");
  return OpenRequestSchema.parse({ path, requestedAt: time.toISOString(), nonce: stamp.nonce });
}

export interface OpenWithHandoff { app: OfficeAppSlug; key: typeof OPEN_REQUEST_KV_KEY; request: OpenRequest }
/** What Files must write, and for which app, to open `path`. Null when the
 * file has no default app, the path is not a valid home-relative path, or it
 * lies in a subtree the app file route refuses. */
export function openWithHandoff(path: string, stamp: OpenRequestStamp): OpenWithHandoff | null {
  const app = defaultAppForFile(path);
  if (!app || !AppFilePathSchema.safeParse(path).success || !isAppReachableFilePath(path)) return null;
  return { app, key: OPEN_REQUEST_KV_KEY, request: createOpenRequest(path, stamp) };
}

/** Returns the stored value as a request only when it is well formed and fresh. */
export function parseOpenRequest(value: unknown, nowMs: number): OpenRequest | null {
  const parsed = OpenRequestSchema.safeParse(value);
  if (!parsed.success) return null;
  const age = nowMs - Date.parse(parsed.data.requestedAt);
  return age <= OPEN_REQUEST_TTL_MS && age >= -OPEN_REQUEST_MAX_FUTURE_SKEW_MS ? parsed.data : null;
}

/** The key-value half of the app bridge, as the inbox needs it. */
export interface OpenRequestHost {
  /** Identity of the running app; changes reported for another app are ignored. */
  app?: string;
  readData(key: string): Promise<unknown>;
  writeData(key: string, value: unknown): Promise<void>;
  onDataChange(listener: (key: string, app: string) => void): () => void;
  now?: () => number;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Reference behaviour of `MatrixOS.files.openRequest` and `onOpenRequest`.
 * A request is delivered at most once per inbox, by nonce, and the stored
 * value is cleared after it is read, so reopening the app later does not
 * reopen the file. Stale and malformed values are cleared without delivery.
 */
export function createOpenRequestInbox(host: OpenRequestHost) {
  const seen: string[] = [];
  const listeners: Array<(request: OpenRequest) => void> = [];
  let unsubscribe: (() => void) | null = null;

  async function openRequest(): Promise<OpenRequest | null> {
    let stored: unknown;
    try { stored = await host.readData(OPEN_REQUEST_KV_KEY); }
    catch (error) {
      console.warn("[open-request] read unavailable", errorName(error));
      return null;
    }
    if (stored === null || stored === undefined) return null;
    const request = parseOpenRequest(stored, host.now ? host.now() : Date.now());
    const fresh = request !== null && !seen.includes(request.nonce);
    if (fresh) {
      seen.push(request.nonce);
      if (seen.length > SEEN_NONCES) seen.shift();
    }
    // Consume the value. A failed clear is safe: the nonce is remembered and the request expires.
    void host.writeData(OPEN_REQUEST_KV_KEY, null).catch((error: unknown) => console.warn("[open-request] clear unavailable", errorName(error)));
    return fresh ? request : null;
  }

  function onChange(key: string, app: string): void {
    if (key !== OPEN_REQUEST_KV_KEY || (host.app !== undefined && app !== host.app)) return;
    void openRequest().then((request) => {
      if (!request) return;
      for (const listener of [...listeners]) {
        try { listener(request); }
        catch (error) { console.warn("[open-request] listener failed", errorName(error)); }
      }
    });
  }

  function onOpenRequest(listener: (request: OpenRequest) => void): () => void {
    if (typeof listener !== "function" || listeners.length >= OPEN_REQUEST_MAX_LISTENERS) throw new Error("Open requests are unavailable");
    listeners.push(listener);
    unsubscribe ??= host.onDataChange(onChange);
    return () => {
      const index = listeners.indexOf(listener);
      if (index < 0) return;
      listeners.splice(index, 1);
      if (listeners.length === 0 && unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
  }

  return Object.freeze({ openRequest, onOpenRequest });
}
export type OpenRequestInbox = ReturnType<typeof createOpenRequestInbox>;
