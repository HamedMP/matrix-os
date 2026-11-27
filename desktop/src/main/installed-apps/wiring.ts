// Startup wiring for installed apps (spec 2711). Called once after auth
// restore and the main window, so index.ts only forwards events. Order:
// records → (macOS) sweep, prune and the shim server → held deep link → reopen.
import { screen } from "electron";
import type { NativeAppBridge } from "../embeds/native-app-bridge";
import { createNativeAppOpenResolver } from "../embeds/native-app-open";
import { fetchAppLaunchToken, resolveAppLaunchUrl } from "../embeds/app-launch";
import { requestGateway } from "../embeds/gateway-request";
import { createWebContentsView } from "../embeds/web-contents-view";
import { appEmbedPartition } from "../embeds/embed-manager";
import type { LocalStore } from "../persistence/local-store";
import { fitWindowBoundsToWorkArea } from "../platform/window-bounds";
import type { InstalledAppAuthSnapshot } from "./app-host";
import { createInstalledAppBrowserWindow } from "./app-window";
import type { createInstalledAppDeepLinks } from "./deep-link";
import type { DesktopReleaseChannel } from "../../shared/channel-identity";
import { createMacInstalledApps } from "./mac-wiring";
import { createInstalledAppStore } from "./record-store";
import { createInstalledAppReopen, reopenEach } from "./reopen";
import { createInstalledAppsService } from "./service";

export interface InstalledAppsWiringOptions {
  userData: string;
  store: Pick<LocalStore, "getInstalledAppWindowBounds" | "setInstalledAppWindowBounds" | "get" | "set" | "delete">;
  auth: {
    getStatus(): InstalledAppAuthSnapshot;
    getGatewayOrigin(): string;
    getToken(): string | null;
  };
  appBridge: Pick<NativeAppBridge, "register" | "unregister" | "initialParticipant">;
  /** The shared app preload; app views get only its `--matrix-app-bridge` surface. */
  preloadPath: string;
  focusMain(): void;
  deepLinks: ReturnType<typeof createInstalledAppDeepLinks>;
  /** Routes a link opened with an app shim like any other Matrix deep link. */
  openUrl(url: string): void;
  channel: DesktopReleaseChannel;
  /** A preview pair's handle: its shims get their own server. */
  previewHandle?: string;
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function installInstalledApps(options: InstalledAppsWiringOptions) {
  const { auth, appBridge } = options;
  const records = createInstalledAppStore({ dir: options.userData });
  const resolveApp = createNativeAppOpenResolver({ getGatewayOrigin: () => auth.getGatewayOrigin(), getToken: () => auth.getToken() });

  const service = createInstalledAppsService({
    records,
    windowState: {
      load: (installId) => options.store.getInstalledAppWindowBounds(installId),
      save: (installId, bounds) => options.store.setInstalledAppWindowBounds(installId, bounds),
    },
    fitBounds: (bounds) => fitWindowBoundsToWorkArea(bounds, screen.getDisplayMatching({
      x: bounds.x ?? 0, y: bounds.y ?? 0, width: bounds.width, height: bounds.height,
    }).workArea),
    createWindow: (record, bounds, context) => createInstalledAppBrowserWindow({
      record,
      bounds,
      ...(context.appShim ? { appShim: context.appShim as Electron.AppShimHost } : {}),
      getStatus: () => auth.getStatus(),
      resolveApp,
      focusMain: options.focusMain,
      launch: (target) => {
        const gatewayOrigin = auth.getGatewayOrigin();
        return resolveAppLaunchUrl({
          gatewayOrigin, slug: target.slug, appIdentity: target.appIdentity,
          fetchToken: () => fetchAppLaunchToken((url, init) => requestGateway(auth.getToken(), url, init), gatewayOrigin, target.slug),
        });
      },
      createView: async (window, target, onState) => {
        const participant = await appBridge.initialParticipant(target.slug).catch((error: unknown) => {
          console.warn("[installed-apps] owner collaboration state unavailable", error instanceof Error ? error.name : "UnknownError");
          return null;
        });
        return createWebContentsView({
          window,
          partition: appEmbedPartition(target.slug),
          allowedOrigins: [auth.getGatewayOrigin()],
          onState,
          disableWakeLocks: true,
          appBridge: {
            appIdentity: target.appIdentity,
            routeSlug: target.slug,
            preloadPath: options.preloadPath,
            participant,
            register: (senderId, appIdentity, routeSlug) => appBridge.register(senderId, appIdentity, routeSlug),
            unregister: (senderId) => appBridge.unregister(senderId),
          },
        });
      },
    }),
  });

  const forgetWindowState = (installId: string) => options.store.setInstalledAppWindowBounds(installId, null);
  const mac = process.platform === "darwin" ? createMacInstalledApps({
    records, channel: options.channel, ...(options.previewHandle ? { previewHandle: options.previewHandle } : {}),
    service, auth, forgetWindowState, focusMain: options.focusMain, openUrl: options.openUrl,
  }) : null;
  const reopen = createInstalledAppReopen({ store: {
    get: () => options.store.get("installedAppsReopen"),
    set: (value) => options.store.set("installedAppsReopen", value),
    delete: () => options.store.delete("installedAppsReopen"),
  } });

  /** macOS opens an install through its shim bundle (its own Dock identity); elsewhere, or failing that, a plain window. */
  async function launch(installId: string, launchOptions: { background?: boolean } = {}): Promise<void> {
    if (await mac?.launch(installId, launchOptions)) return;
    await service.open(installId);
  }

  const started = (async () => {
    await mac?.start().catch((error: unknown) => logFailure("app shims unavailable", error));
    options.deepLinks.ready((installId) => { void launch(installId); });
    await reopenEach(await reopen.take(), (installId) => launch(installId, { background: true }));
  })();

  return {
    open: (installId: string) => service.open(installId),
    /** Resolves once records, shims, the held link and reopening are handled. */
    started,
    /** macOS: install and uninstall shim bundles (the Install UI is a later layer). */
    mac,
    authChanged: (status: InstalledAppAuthSnapshot) => service.authChanged(status),
    /** Quit: remember open apps, stop taking links and shims, close app windows, and wait for their window state. */
    async dispose(): Promise<void> {
      options.deepLinks.detach();
      await reopen.save(service.openInstallIds()).catch((error: unknown) => logFailure("could not save open apps", error));
      mac?.stop();
      await service.dispose();
    },
  };
}
