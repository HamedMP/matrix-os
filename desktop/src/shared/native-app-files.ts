import { z } from "zod/v4";
import {
  APP_FILES_CHANNEL,
  APP_FILE_ERROR_MESSAGES,
  createAppFilesClient,
  isBridgeFileError,
  type AppFileErrorCode,
  type AppFileInput,
  type AppFileWriteOptions,
} from "@matrix-os/contracts/app-files";
import { OPEN_REQUEST_KV_KEY, createOpenRequestInbox, type OpenRequest } from "@matrix-os/contracts/office-open-with";

/**
 * Electron Desktop half of `MatrixOS.files`. File operations go to the main
 * process on `APP_FILES_CHANNEL`; the main process binds the app identity and
 * posts to the gateway file route. Open requests go on their own channel,
 * which can read and clear only the `open-request` key of the bound app.
 */
export { APP_FILES_CHANNEL };
export const NATIVE_APP_OPEN_REQUEST_CHANNEL = "native-app:open-request";
export const NativeAppOpenRequestActionSchema = z.strictObject({ action: z.enum(["read", "clear"]) });
export type NativeAppOpenRequestAction = z.infer<typeof NativeAppOpenRequestActionSchema>;
const OpenRequestReadReplySchema = z.strictObject({ value: z.unknown() });

/** How often a visible app with open-request listeners checks for a new request. */
export const OPEN_REQUEST_POLL_MS = 5_000;

/** The key-value envelope used by the web bridge, so both hosts read each other's values. */
const STORED_VALUE_PREFIX = "__matrix_os_value_v1__:";
export function encodeNativeAppStoredValue(value: unknown): string {
  return `${STORED_VALUE_PREFIX}${JSON.stringify(value === undefined ? { undefined: true } : { value })}`;
}
export function decodeNativeAppStoredValue(stored: unknown): unknown {
  if (typeof stored !== "string" || !stored.startsWith(STORED_VALUE_PREFIX)) return stored;
  try {
    const envelope: unknown = JSON.parse(stored.slice(STORED_VALUE_PREFIX.length));
    if (!envelope || typeof envelope !== "object") return stored;
    if ((envelope as { undefined?: unknown }).undefined === true) return undefined;
    if (Object.hasOwn(envelope, "value")) return (envelope as { value: unknown }).value;
  } catch (error: unknown) {
    console.warn("[native-app-files] stored value is not an envelope", error instanceof Error ? error.name : "UnknownError");
  }
  return stored;
}

/**
 * `contextBridge` copies a thrown error without its `name` and `code`, so the
 * preload returns this result and the page-world wrapper throws the
 * `BridgeFileError` shape from it.
 */
export type NativeAppFileResult<T> = { ok: true; value: T } | { ok: false; code: AppFileErrorCode; message: string };

async function settle<T>(run: () => Promise<T>): Promise<NativeAppFileResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    if (!isBridgeFileError(error)) console.warn("[native-app-files] request failed", error instanceof Error ? error.name : "UnknownError");
    const code: AppFileErrorCode = isBridgeFileError(error) ? error.code : "unavailable";
    return { ok: false, code, message: APP_FILE_ERROR_MESSAGES[code] };
  }
}

export interface NativeAppFilesBridgeDependencies {
  invokeFiles: (input: AppFileInput) => Promise<unknown>;
  invokeOpenRequest: (request: NativeAppOpenRequestAction) => Promise<unknown>;
  /** Calls `check` whenever a new open request may have arrived. Returns a stop function. */
  watchOpenRequests: (check: () => void) => () => void;
}

/** The object the preload exposes as `files`. */
export function createNativeAppFilesBridge(deps: NativeAppFilesBridgeDependencies) {
  const client = createAppFilesClient(deps.invokeFiles);
  const inbox = createOpenRequestInbox({
    async readData(key) {
      if (key !== OPEN_REQUEST_KV_KEY) throw new Error("Open requests are unavailable");
      return OpenRequestReadReplySchema.parse(await deps.invokeOpenRequest({ action: "read" })).value;
    },
    async writeData(key, value) {
      // The inbox only ever clears the request after reading it.
      if (key !== OPEN_REQUEST_KV_KEY || value !== null) throw new Error("Open requests are unavailable");
      await deps.invokeOpenRequest({ action: "clear" });
    },
    onDataChange(listener) {
      return deps.watchOpenRequests(() => listener(OPEN_REQUEST_KV_KEY, ""));
    },
  });
  return Object.freeze({
    list: (dir: string, options?: { limit?: number }) => settle(() => client.list(dir, options)),
    stat: (path: string) => settle(() => client.stat(path)),
    read: (path: string) => settle(() => client.read(path)),
    write: (path: string, bytes: Uint8Array, options: AppFileWriteOptions) => settle(() => client.write(path, bytes, options)),
    mkdir: (path: string) => settle(() => client.mkdir(path)),
    openRequest: (): Promise<OpenRequest | null> => inbox.openRequest(),
    onOpenRequest: (callback: (request: OpenRequest) => void): (() => void) => inbox.onOpenRequest(callback),
  });
}
export type NativeAppFilesBridge = ReturnType<typeof createNativeAppFilesBridge>;

/**
 * Electron has no key-value change events, so an app view checks for a new
 * request when it becomes visible or focused (Files launches or focuses the
 * app right after writing the request) and on a slow timer while visible.
 */
export function watchOpenRequestSignals(view: Pick<Window, "addEventListener" | "removeEventListener"> & { document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> }, check: () => void, intervalMs = OPEN_REQUEST_POLL_MS): () => void {
  const onSignal = () => { if (view.document.visibilityState === "visible") check(); };
  view.document.addEventListener("visibilitychange", onSignal);
  view.addEventListener("focus", onSignal);
  const timer = setInterval(onSignal, intervalMs);
  return () => {
    clearInterval(timer);
    view.document.removeEventListener("visibilitychange", onSignal);
    view.removeEventListener("focus", onSignal);
  };
}
