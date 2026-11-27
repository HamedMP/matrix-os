// Main-process handlers for the installed-apps IPC (spec 2711, layer 4).
// Only the main window's own page may call them. Every request and response
// is checked against the shared contract; failures leave as allowlisted codes
// and are logged here by error name only (no paths or provider messages).
import { INVOKE_CHANNELS, type InvokeChannel } from "../../shared/ipc-contract";
import type { InstallAppErrorCode, InstalledAppPlatform, InstalledAppSummary } from "../../shared/installed-apps-ipc";
import type { NativeAppOpenRequest } from "../../shared/native-app-open";
import { NativeAppOpenError } from "../embeds/native-app-open";
import { InstalledAppLimitError } from "./record-store";
import type { InstalledAppRecord } from "./record";

export class InstalledAppsUnavailableError extends Error {
  constructor() {
    super("Installed apps are unavailable");
    this.name = "InstalledAppsUnavailableError";
  }
}

/** The computer or sign-in changed while an install was resolving; nothing was saved. */
export class InstalledAppSessionChangedError extends Error {
  constructor() {
    super("Session changed during install");
    this.name = "InstalledAppSessionChangedError";
  }
}

export interface InstalledAppsControl {
  /** The platform installs run on; null when installing is unavailable here. */
  platform(): InstalledAppPlatform | null;
  list(): Promise<InstalledAppRecord[]>;
  /** Resolves the reference through the authenticated catalog, then installs it. */
  install(request: NativeAppOpenRequest): Promise<InstalledAppRecord>;
  uninstall(installId: string): Promise<boolean>;
  open(installId: string): Promise<void>;
  /** Reveals the install's bundle or launcher; false when there is none. */
  show(installId: string): Promise<boolean>;
}

interface IpcLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>): void;
}

function summary(record: InstalledAppRecord): InstalledAppSummary {
  return { installId: record.installId, slug: record.slug, appIdentity: record.appIdentity, runtimeSlot: record.runtimeSlot, name: record.name };
}

export function installErrorCode(error: unknown): InstallAppErrorCode {
  if (error instanceof NativeAppOpenError) {
    return error.reason === "auth-required" ? "auth-required" : error.reason === "not-found" ? "not-found" : "unavailable";
  }
  if (error instanceof InstalledAppLimitError) return "limit";
  if (error instanceof InstalledAppsUnavailableError) return "unavailable";
  return "failed";
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function registerInstalledAppsIpc(ipc: IpcLike, options: {
  isMainWindowSender(event: unknown): boolean;
  /** Resolved at registration; it reports "unavailable" itself until installed apps start. */
  control: InstalledAppsControl;
}): void {
  const control = options.control;
  const methods = ["platform", "list", "install", "uninstall", "open", "show"] as const;
  if (typeof options.isMainWindowSender !== "function" || !control
    || methods.some((method) => typeof control[method] !== "function")) {
    throw new Error("installed apps IPC unavailable");
  }

  function handle<C extends InvokeChannel>(channel: C, handler: (request: never, control: InstalledAppsControl | null) => Promise<unknown>): void {
    ipc.handle(channel, async (event, payload) => {
      const request = INVOKE_CHANNELS[channel].request.safeParse(payload ?? {});
      if (!request.success || !options.isMainWindowSender(event)) throw new Error("invalid request");
      let result: unknown;
      try {
        result = await handler(request.data as never, control.platform() ? control : null);
      } catch (error: unknown) {
        logFailure(`${channel} failed`, error);
        throw new Error("internal error");
      }
      const response = INVOKE_CHANNELS[channel].response.safeParse(result);
      if (!response.success) {
        console.warn(`[installed-apps] ${channel} produced an invalid response`);
        throw new Error("internal error");
      }
      return response.data;
    });
  }

  handle("installed-apps:list", async (_request: Record<string, never>, control) => {
    const platform = control?.platform();
    if (!control || !platform) return { available: false };
    return { available: true, platform, apps: (await control.list()).map(summary) };
  });

  handle("installed-apps:install", async (request: NativeAppOpenRequest, control) => {
    if (!control) return { ok: false, error: "unavailable" };
    try {
      return { ok: true, app: summary(await control.install(request)) };
    } catch (error: unknown) {
      logFailure("install failed", error);
      return { ok: false, error: installErrorCode(error) };
    }
  });

  handle("installed-apps:uninstall", async (request: { installId: string }, control) => {
    if (!control) return { ok: false, error: "unavailable" };
    try {
      return (await control.uninstall(request.installId)) ? { ok: true } : { ok: false, error: "not-found" };
    } catch (error: unknown) {
      logFailure("uninstall failed", error);
      return { ok: false, error: installErrorCode(error) };
    }
  });

  handle("installed-apps:open", async (request: { installId: string }, control) => {
    if (!control) return { ok: false };
    await control.open(request.installId);
    return { ok: true };
  });

  handle("installed-apps:show", async (request: { installId: string }, control) => {
    return { ok: control ? await control.show(request.installId) : false };
  });
}
