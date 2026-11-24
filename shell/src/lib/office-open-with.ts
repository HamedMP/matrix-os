import { MAX_APP_KV_REQUEST_BYTES } from "@matrix-os/contracts";
import { openWithHandoff, type OfficeAppSlug } from "@matrix-os/contracts/office-open-with";
import { useWindowManager } from "@/hooks/useWindowManager";
import { routeAppBridgeLaunch } from "./builtin-apps";
import { encodeBridgeStoredValue } from "./os-bridge";

/** Same budget the app viewer gives owner key-value writes. */
const OPEN_REQUEST_WRITE_TIMEOUT_MS = 10_000;

export const OFFICE_APP_TITLES: Readonly<Record<OfficeAppSlug, string>> = Object.freeze({ docs: "Docs", sheets: "Sheets" });

/** Catalog path of a default app, the same path the launcher opens. */
export function officeAppLaunchPath(app: OfficeAppSlug): string {
  return `apps/${app}/index.html`;
}

/** Binary document formats: never fetch these as text for a preview. */
export function isBinaryOfficeFile(name: string): boolean {
  return /\.(docx|xlsx)$/i.test(name);
}

export type OpenWithDefaultAppResult =
  | { status: "no-default-app" }
  | { status: "opened"; app: OfficeAppSlug }
  | { status: "failed"; app: OfficeAppSlug };

export interface OpenWithDefaultAppOptions {
  /** Gateway origin of the Files window's authority. */
  gatewayUrl: string;
  /** Opens or focuses the app window. Defaults to the window manager. */
  launch?: (name: string, path: string) => void;
  now?: () => number;
  nonce?: () => string;
}

function launchInWindowManager(name: string, path: string): void {
  // The store restores and focuses an existing window at this canonical path.
  useWindowManager.getState().openWindow(name, path, 0);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

async function writeOpenRequest(gatewayUrl: string, body: string): Promise<boolean> {
  if (new TextEncoder().encode(body).length > MAX_APP_KV_REQUEST_BYTES) return false;
  const response = await fetch(`${gatewayUrl}/api/bridge/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(OPEN_REQUEST_WRITE_TIMEOUT_MS),
    redirect: "error",
  });
  try {
    await response.body?.cancel();
  } catch (error: unknown) {
    console.warn("[open-with] response release failed", errorName(error));
  }
  return response.ok;
}

/**
 * Hands `path` to its default app: stores an open request in that app's
 * key-value store through the owner data route, then launches or focuses the
 * app through the same routing app launches use. The app is launched only
 * after the write succeeds, so it never starts without its request.
 */
export async function openFileWithDefaultApp(path: string, options: OpenWithDefaultAppOptions): Promise<OpenWithDefaultAppResult> {
  const handoff = openWithHandoff(path, {
    now: options.now ? options.now() : Date.now(),
    nonce: options.nonce ? options.nonce() : crypto.randomUUID(),
  });
  if (!handoff) return { status: "no-default-app" };
  const { app, key, request } = handoff;
  try {
    const body = JSON.stringify({ action: "write", app, key, value: encodeBridgeStoredValue(request) });
    if (!await writeOpenRequest(options.gatewayUrl, body)) return { status: "failed", app };
    routeAppBridgeLaunch(OFFICE_APP_TITLES[app], officeAppLaunchPath(app), options.launch ?? launchInWindowManager);
    return { status: "opened", app };
  } catch (error: unknown) {
    console.warn("[open-with] default app handoff failed", errorName(error));
    return { status: "failed", app };
  }
}

/** The notification shown when a handoff fails. Names only the file, never the path. */
export function openWithFailureMessage(app: OfficeAppSlug, path: string, previewed: boolean): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return `${OFFICE_APP_TITLES[app]} could not open ${name}. ${previewed ? "It opened in Preview instead." : "Try again in a moment."}`;
}
