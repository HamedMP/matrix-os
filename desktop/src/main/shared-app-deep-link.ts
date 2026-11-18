import { parseSharedAppDesktopUrl } from "@matrix-os/contracts";
import { INVOKE_CHANNELS } from "../shared/ipc-contract";
import type { SharedAppDeepLink } from "../shared/shared-app-deep-link-ipc";

/**
 * Routes `matrixos://shared-app/<scopeId>?…` (spec 2693 phase 4) to the main
 * window. The renderer opens the app only if the member's shared-app directory
 * lists that scope; the platform re-checks membership on launch.
 *
 * Delivery follows the renderer, not the page's load state: the renderer
 * subscribes to the event and then takes any held link, so after its first
 * take every link is sent at once. Until then (and again after a reload or
 * crash) a link is held, one at a time, for the next take.
 */
export function createSharedAppDeepLinks(options: {
  schemes: readonly string[];
  /** Sends the event to the main renderer; false when there is no live main window. */
  send: (link: SharedAppDeepLink) => boolean;
}) {
  let pending: SharedAppDeepLink | null = null;
  let listening = false;
  return {
    /** True when `url` was a shared-app link (sent or held); false for other deep links. */
    handle(url: string): boolean {
      const parsed = parseSharedAppDesktopUrl(url, options.schemes);
      if (!parsed) return false;
      const link: SharedAppDeepLink = { scopeId: parsed.scopeId,
        ...(parsed.expectedBuildId ? { expectedBuildId: parsed.expectedBuildId } : {}),
        ...(parsed.expectedShareRevision ? { expectedShareRevision: parsed.expectedShareRevision } : {}) };
      pending = listening && options.send(link) ? null : link;
      return true;
    },
    /** The renderer is subscribed once it takes: later links are sent directly. */
    take(): SharedAppDeepLink | null {
      listening = true;
      const link = pending;
      pending = null;
      return link;
    },
    /** The main renderer reloaded, crashed or closed: hold links until it takes again. */
    rendererReset(): void {
      listening = false;
    },
  };
}

/**
 * Routes any Matrix deep link: focuses the main window, or reopens it through
 * the app's single-flight path when it was closed (Terminal can keep Electron
 * running without it), then hands the link to the shared-app router, which
 * holds it until the reopened renderer takes it.
 */
export function createDesktopDeepLinkHandler(options: {
  isDeepLink(url: string): boolean;
  hasMainWindow(): boolean;
  focusMainWindow(): void;
  reopenMainWindow(): void;
  links: { handle(url: string): boolean };
}) {
  return (url: string): void => {
    if (!options.isDeepLink(url)) return;
    if (options.hasMainWindow()) options.focusMainWindow();
    else options.reopenMainWindow();
    options.links.handle(url);
  };
}

export function registerSharedAppDeepLinkIpc(ipc: {
  handle(channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>): void;
}, options: { isMainWindowSender(event: unknown): boolean; take(): SharedAppDeepLink | null }): void {
  if (typeof options.isMainWindowSender !== "function" || typeof options.take !== "function") {
    throw new Error("shared app deep links unavailable");
  }
  ipc.handle("deeplink:take-shared-app", async (event, payload) => {
    if (!INVOKE_CHANNELS["deeplink:take-shared-app"].request.safeParse(payload ?? {}).success
      || !options.isMainWindowSender(event)) throw new Error("invalid request");
    return { link: options.take() };
  });
}
