import type { IpcMain, Session } from "electron";
import { INVOKE_CHANNELS, type InvokeChannel, type InvokeResponse } from "../shared/ipc-contract";
import type { AuthService } from "./auth/auth-service";
import type { DesktopStartupMode } from "../shared/startup-mode";

/** Only the trusted native process can opt in; every other value stays normal. */
export function readDesktopStartupMode(value: string | undefined): DesktopStartupMode {
  return value === "1" ? "auth-diagnostic" : "normal";
}

export async function initializeAuthDiagnostic(auth: Pick<AuthService, "init" | "getStatus">) {
  let initializationFailed = false;
  try { await auth.init(); }
  catch (error: unknown) {
    initializationFailed = true;
    console.warn("[auth-diagnostic] local initialization failed", error instanceof Error ? error.name : "unknown error");
  }
  return () => {
    if (initializationFailed) throw new Error("Local auth status could not be read.");
    return auth.getStatus();
  };
}

const AUTH_DIAGNOSTIC_CSP = [
  "default-src 'none'", "script-src 'self'", "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "img-src 'self' data:",
  "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

export function installAuthDiagnosticSession(target: Session, packagedRendererUrl: string): void {
  // This session never gets bearer injection. Local packaged assets only;
  // accidental renderer network calls are blocked before Chromium sends them.
  target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let cancel = true;
    try { cancel = !["file:", "data:", "blob:"].includes(new URL(details.url).protocol); }
    catch (error: unknown) { console.warn("[auth-diagnostic] invalid resource URL", error instanceof Error ? error.name : "unknown error"); }
    callback({ cancel });
  });
  // Inject before loading the packaged document. Network denial does not
  // constrain inline/eval scripts or local frame/object execution; CSP does.
  target.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== "mainFrame" || details.url !== packagedRendererUrl) {
      callback({});
      return;
    }
    const responseHeaders: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      if (key.toLowerCase() !== "content-security-policy") responseHeaders[key] = value;
    }
    responseHeaders["Content-Security-Policy"] = [AUTH_DIAGNOSTIC_CSP];
    callback({ responseHeaders });
  });
  target.setPermissionCheckHandler(() => false);
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

export function registerAuthDiagnosticIpc(ipc: Pick<IpcMain, "handle">, options: {
  isTrustedSender: (event: unknown) => boolean;
  getAuthStatus: () => InvokeResponse<"auth:status">;
  getVersion: () => InvokeResponse<"app:get-version">;
}): void {
  function handle<C extends InvokeChannel>(channel: C, read: () => InvokeResponse<C>) {
    ipc.handle(channel, async (event, payload) => {
      if (!options.isTrustedSender(event)
        || !INVOKE_CHANNELS[channel].request.safeParse(payload ?? {}).success) throw new Error("invalid request");
      try { return INVOKE_CHANNELS[channel].response.parse(read()); }
      catch (error: unknown) {
        console.warn("[auth-diagnostic] local read failed", error instanceof Error ? error.name : "unknown error");
        throw new Error(channel === "auth:status" ? "Local auth status could not be read." : "internal error");
      }
    });
  }
  handle("app:get-startup-mode", () => ({ mode: "auth-diagnostic" }));
  handle("auth:status", options.getAuthStatus);
  handle("app:get-version", options.getVersion);
  // No updater is constructed. Even stale manual update requests fail visibly.
  for (const channel of ["update:check", "update:install"] as const) {
    ipc.handle(channel, async (event, payload) => {
      if (!options.isTrustedSender(event)
        || !INVOKE_CHANNELS[channel].request.safeParse(payload ?? {}).success) throw new Error("invalid request");
      throw new Error("Updates are unavailable in auth-only diagnostics.");
    });
  }
}
