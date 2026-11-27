// IPC contract for installing Matrix apps as desktop apps (spec 2711, layer 4).
// Only the main window may call these channels. Install takes an app
// reference that the main process resolves through the authenticated catalog,
// never a path on disk; uninstall takes a random install id. Failures cross
// IPC as allowlisted codes only, never as messages.
import { z } from "zod/v4";
import { NativeAppOpenRequestSchema } from "./native-app-open";

const Ok = z.strictObject({ ok: z.boolean() });
const InstallId = z.uuid();
const AppIdentity = z.string().max(256).regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/);

export const INSTALLED_APP_PLATFORMS = ["mac", "windows", "linux"] as const;
export type InstalledAppPlatform = typeof INSTALLED_APP_PLATFORMS[number];

/** What the renderer may know about one install: no paths, hashes or icons. */
export const InstalledAppSummarySchema = z.strictObject({
  installId: InstallId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  appIdentity: AppIdentity,
  runtimeSlot: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(128),
});
export type InstalledAppSummary = z.infer<typeof InstalledAppSummarySchema>;

export const INSTALL_APP_ERROR_CODES = ["unavailable", "auth-required", "not-found", "limit", "failed"] as const;
export type InstallAppErrorCode = typeof INSTALL_APP_ERROR_CODES[number];
const ErrorCode = z.enum(INSTALL_APP_ERROR_CODES);

export const InstalledAppsListSchema = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(false) }),
  z.strictObject({
    available: z.literal(true),
    platform: z.enum(INSTALLED_APP_PLATFORMS),
    apps: z.array(InstalledAppSummarySchema).max(64),
  }),
]);
export type InstalledAppsList = z.infer<typeof InstalledAppsListSchema>;

export const InstallAppResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), app: InstalledAppSummarySchema }),
  z.strictObject({ ok: z.literal(false), error: ErrorCode }),
]);
export type InstallAppResult = z.infer<typeof InstallAppResultSchema>;

export const UninstallAppResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: ErrorCode }),
]);
export type UninstallAppResult = z.infer<typeof UninstallAppResultSchema>;

const ByInstallId = z.strictObject({ installId: InstallId });

export const INSTALLED_APPS_INVOKE = {
  "installed-apps:list": { request: z.strictObject({}), response: InstalledAppsListSchema },
  "installed-apps:install": { request: NativeAppOpenRequestSchema, response: InstallAppResultSchema },
  "installed-apps:uninstall": { request: ByInstallId, response: UninstallAppResultSchema },
  "installed-apps:open": { request: ByInstallId, response: Ok },
  /** Reveals the install in Finder, Explorer or the file manager. */
  "installed-apps:show": { request: ByInstallId, response: Ok },
} as const;

export const INSTALLED_APPS_EVENTS = {
  /** Installs changed (here, from an app's own menu, or by a start-up prune). */
  "installed-apps:changed": z.strictObject({}),
} as const;
