// Routes every `matrixos://` link the app receives (cold-start argv, a second
// instance, `open-url`, or an app shim) to the installed-app or shared-app
// handler. Electron-free: the main window is reached through callbacks.
import { isDesktopDeepLink, type DesktopChannelIdentity } from "../../shared/channel-identity";
import type { SharedAppDeepLink } from "../../shared/shared-app-deep-link-ipc";
import { createInstalledAppDeepLinks } from "../installed-apps/deep-link";
import { createDesktopDeepLinkHandler, createSharedAppDeepLinks } from "../shared-app-deep-link";

export interface DesktopDeepLinkRouterOptions {
  identity: DesktopChannelIdentity;
  hasMainWindow(): boolean;
  focusMainWindow(): void;
  /** Reopens a closed main window; a no-op until the app is ready (startup opens it). */
  reopenMainWindow(): void;
  /** Sends a shared-app link to the main renderer; false when there is no live main window. */
  sendSharedAppLink(link: SharedAppDeepLink): boolean;
}

export function createDesktopDeepLinkRouter(options: DesktopDeepLinkRouterOptions) {
  const schemes = options.identity.deepLinkSchemes;
  const isDeepLink = (value: string) => isDesktopDeepLink(value, options.identity);
  // Org-link hand-off (spec 2693): `matrixos://shared-app/<scopeId>`; other links only focus.
  const sharedApps = createSharedAppDeepLinks({ schemes, send: options.sendSharedAppLink });
  // `matrixos://app/<installId>` (spec 2711): held until install records and auth are loaded.
  const installedApps = createInstalledAppDeepLinks({ schemes });
  const handle = createDesktopDeepLinkHandler({
    isDeepLink,
    hasMainWindow: options.hasMainWindow,
    focusMainWindow: options.focusMainWindow,
    reopenMainWindow: options.reopenMainWindow,
    links: sharedApps,
  });

  return {
    isDeepLink,
    sharedApps,
    installedApps,

    /** Windows/Linux cold start passes the link in argv; it is held until its handler is ready. */
    coldStart(argv: readonly string[]): void {
      const link = argv.find(isDeepLink);
      if (link && !installedApps.handle(link)) sharedApps.handle(link);
    },

    /** Installed-app links open their own window without raising the main one. */
    route(url: string): void {
      if (installedApps.handle(url)) return;
      handle(url);
    },

    /** A second instance's argv: true when it carried a link, which is routed. */
    routeArgv(argv: readonly string[]): boolean {
      const link = argv.find(isDeepLink);
      if (!link) return false;
      this.route(link);
      return true;
    },
  };
}
