import { MAX_APP_KV_REQUEST_BYTES } from "@matrix-os/contracts";
import { defaultAppForFile, openWithHandoff, type OfficeAppSlug } from "@matrix-os/contracts/office-open-with";
import { encodeNativeAppStoredValue } from "../../../../shared/native-app-files";
import type { ApiClient } from "../../lib/api";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useTabs } from "../../stores/tabs";

/** Same budget the web shell gives the open-request write. */
const OPEN_REQUEST_WRITE_TIMEOUT_MS = 10_000;

export const OFFICE_APP_TITLES: Readonly<Record<OfficeAppSlug, string>> = Object.freeze({ docs: "Docs", sheets: "Sheets" });

/** Menu label for a file that has a default app, such as "Open in Docs". */
export function openWithLabel(path: string): string | null {
  const app = defaultAppForFile(path);
  return app ? `Open in ${OFFICE_APP_TITLES[app]}` : null;
}

/**
 * The file a double-click in the browser should open with its default app:
 * the row under the pointer, only when it is the selected file and has a
 * default app. Rows carry `data-files-entry-path`; directories never become
 * the file selection.
 */
export function openWithTargetPath(target: EventTarget | null, selectedFilePath: string | null): string | null {
  if (!selectedFilePath || !target || typeof (target as Element).closest !== "function") return null;
  const row = (target as Element).closest("[data-files-entry-path]");
  const path = row?.getAttribute("data-files-entry-path") ?? null;
  return path === selectedFilePath && defaultAppForFile(path) ? path : null;
}

/** Opens or focuses the default app's tab, the same way an app launch does. */
export function launchOfficeApp(app: OfficeAppSlug): void {
  const tabId = useTabs.getState().openTab({ kind: "app", slug: app, title: OFFICE_APP_TITLES[app], appIdentity: app });
  useDesktopSurfaces.getState().activateSurface(tabId);
}

export type OpenWithDefaultAppResult =
  | { status: "no-default-app" }
  | { status: "opened"; app: OfficeAppSlug }
  | { status: "failed"; app: OfficeAppSlug }
  | { status: "stale"; app: OfficeAppSlug };

export interface OpenWithDefaultAppOptions {
  /** Gateway client bound to the computer whose file this is. */
  api: Pick<ApiClient, "post">;
  launch?: (app: OfficeAppSlug) => void;
  /** False once the computer or sign-in changed; the app is then not launched. */
  isCurrent?: () => boolean;
  now?: () => number;
  nonce?: () => string;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Hands `path` to its default app: writes an open request to that app's
 * key-value store, then opens or focuses the app. The app is launched only
 * after the write succeeds, so it never starts without its request. The app
 * picks the request up with `MatrixOS.files.openRequest()` or `onOpenRequest`.
 */
export async function openFileWithDefaultApp(path: string, options: OpenWithDefaultAppOptions): Promise<OpenWithDefaultAppResult> {
  const handoff = openWithHandoff(path, {
    now: options.now ? options.now() : Date.now(),
    nonce: options.nonce ? options.nonce() : crypto.randomUUID(),
  });
  if (!handoff) return { status: "no-default-app" };
  const { app, key, request } = handoff;
  try {
    const body = { action: "write", app, key, value: encodeNativeAppStoredValue(request) };
    if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_APP_KV_REQUEST_BYTES) return { status: "failed", app };
    await options.api.post("/api/bridge/data", body, { maxBytes: 4096, omitErrorBody: true, timeoutMs: OPEN_REQUEST_WRITE_TIMEOUT_MS });
    if (options.isCurrent && !options.isCurrent()) return { status: "stale", app };
    (options.launch ?? launchOfficeApp)(app);
    return { status: "opened", app };
  } catch (error: unknown) {
    console.warn("[open-with] default app handoff failed", errorName(error));
    return { status: "failed", app };
  }
}

/** The notification for a failed handoff. Names only the file, never the path. */
export function openWithFailureMessage(app: OfficeAppSlug, path: string): string {
  return `${OFFICE_APP_TITLES[app]} could not open ${path.slice(path.lastIndexOf("/") + 1)}. Try again in a moment.`;
}
