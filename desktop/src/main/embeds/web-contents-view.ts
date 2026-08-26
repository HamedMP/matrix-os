// Electron WebContentsView adapter implementing EmbedViewLike. Each embed runs
// in its own isolated partition. Hosted-shell views have no preload/IPC
// exposure; app views may receive the narrow database-only preload. Navigation
// is gated by an origin allowlist; external links open in the system browser.
import { WebContentsView, shell, type BaseWindow } from "electron";
import { isNavigationAllowed } from "./origin-policy";
import type { Bounds, EmbedViewLike } from "./embed-manager";
import { safeExternalHttpUrl } from "../external-url";

export function createWebContentsView(options: {
  window: BaseWindow;
  partition: string;
  allowedOrigins: string[];
  onState: (state: "loading" | "ready" | "failed") => void;
  appBridge?: {
    appIdentity: string;
    routeSlug: string;
    preloadPath: string;
    register: (senderId: number, appIdentity: string, routeSlug: string) => void;
    unregister: (senderId: number) => void;
  };
}): EmbedViewLike {
  const view = new WebContentsView({
    webPreferences: {
      partition: options.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      ...(options.appBridge ? {
        preload: options.appBridge.preloadPath,
        additionalArguments: ["--matrix-app-bridge"],
      } : {}),
    },
  });

  const contents = view.webContents;
  if (options.appBridge) {
    // App views receive only the explicit typed bridge. Browser capabilities
    // that could escape that permission model are denied by default.
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
  }
  if (options.appBridge) {
    options.appBridge.register(
      contents.id,
      options.appBridge.appIdentity,
      options.appBridge.routeSlug,
    );
  }

  // Block any navigation outside the allowlist; route external links to the
  // system browser.
  const blockExternalNavigation = (event: unknown, maybeUrl: unknown) => {
    const url = typeof maybeUrl === "string" ? maybeUrl : typeof event === "string" ? event : null;
    const preventDefault =
      event && typeof event === "object" && "preventDefault" in event
        ? (event as { preventDefault?: unknown }).preventDefault
        : null;
    if (!url || typeof preventDefault !== "function") return;
    if (!isNavigationAllowed(url, options.allowedOrigins)) {
      preventDefault.call(event);
      const externalUrl = safeExternalHttpUrl(url);
      if (externalUrl) void shell.openExternal(externalUrl);
    }
  };
  contents.on("will-navigate", blockExternalNavigation);
  contents.on("will-redirect", blockExternalNavigation);
  contents.setWindowOpenHandler(({ url }) => {
    const externalUrl = safeExternalHttpUrl(url);
    if (externalUrl) void shell.openExternal(externalUrl);
    return { action: "deny" };
  });
  contents.on("did-start-loading", () => options.onState("loading"));
  contents.on("did-finish-load", () => options.onState("ready"));
  contents.on("did-fail-load", (_e, errorCode, _description, _validatedUrl, isMainFrame) => {
    if (isMainFrame === false) return;
    // -3 is ERR_ABORTED (e.g. a redirect); not a real failure.
    if (errorCode !== -3) options.onState("failed");
  });

  let attached = false;

  return {
    setBounds(bounds: Bounds) {
      view.setBounds(bounds);
    },
    setScale(factor: number) {
      contents.setZoomFactor(factor);
    },
    async loadUrl(url: string) {
      await contents.loadURL(url);
    },
    attach() {
      if (attached) return;
      options.window.contentView.addChildView(view);
      attached = true;
    },
    detach() {
      if (!attached) return;
      options.window.contentView.removeChildView(view);
      attached = false;
    },
    destroy() {
      options.appBridge?.unregister(contents.id);
      if (attached) {
        options.window.contentView.removeChildView(view);
        attached = false;
      }
      // WebContentsView is GC'd once detached and dereferenced; closing the
      // contents releases the renderer process promptly.
      if (!contents.isDestroyed()) contents.close();
    },
  };
}
