// Startup wiring for installed-app windows (spec 2711 layer 2). Called once
// after auth restore and the main window, so index.ts only forwards events.
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
import { createInstalledAppStore } from "./record-store";
import { createInstalledAppsService } from "./service";

export interface InstalledAppsWiringOptions {
  userData: string;
  store: Pick<LocalStore, "getInstalledAppWindowBounds" | "setInstalledAppWindowBounds">;
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
    createWindow: (record, bounds) => createInstalledAppBrowserWindow({
      record,
      bounds,
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

  options.deepLinks.ready((installId) => { void service.open(installId); });

  return {
    open: (installId: string) => service.open(installId),
    authChanged: (status: InstalledAppAuthSnapshot) => service.authChanged(status),
    /** Quit: stop taking links, close app windows, and wait for their window state. */
    async dispose(): Promise<void> {
      options.deepLinks.detach();
      await service.dispose();
    },
  };
}
