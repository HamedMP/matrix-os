import { parseSharedAppDesktopUrl } from "@matrix-os/contracts";
import { INVOKE_CHANNELS } from "../shared/ipc-contract";
import type { SharedAppDeepLink } from "../shared/shared-app-deep-link-ipc";

/**
 * Routes `matrixos://shared-app/<scopeId>?…` (spec 2693 phase 4) to the main
 * window. The renderer opens the app only if the member's shared-app directory
 * lists that scope; the platform re-checks membership on launch. A link that
 * arrives before the renderer listens is held (one at a time) for it to take.
 */
export function createSharedAppDeepLinks(options: {
  schemes: readonly string[];
  /** Returns true when the main renderer received the event. */
  deliver: (link: SharedAppDeepLink) => boolean;
}) {
  let pending: SharedAppDeepLink | null = null;
  return {
    /** True when `url` was a shared-app link (valid or held); false for other deep links. */
    handle(url: string): boolean {
      const parsed = parseSharedAppDesktopUrl(url, options.schemes);
      if (!parsed) return false;
      const link: SharedAppDeepLink = { scopeId: parsed.scopeId,
        ...(parsed.expectedBuildId ? { expectedBuildId: parsed.expectedBuildId } : {}),
        ...(parsed.expectedShareRevision ? { expectedShareRevision: parsed.expectedShareRevision } : {}) };
      pending = options.deliver(link) ? null : link;
      return true;
    },
    take(): SharedAppDeepLink | null {
      const link = pending;
      pending = null;
      return link;
    },
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
