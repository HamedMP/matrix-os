// Electron WebContentsView adapter implementing EmbedViewLike. Each embed runs
// in its own isolated partition. Hosted-shell views have no preload/IPC
// exposure; app views may receive the narrow database-only preload. Navigation
// is gated by an origin allowlist; external links open in the system browser.
import { WebContentsView, shell, type BaseWindow } from "electron";
import { isNavigationAllowed } from "./origin-policy";
import type { Bounds, EmbedViewLike } from "./embed-manager";
import { safeExternalHttpUrl } from "../external-url";
import type { RuntimeBrowserNavigationDecision } from "../../shared/runtime-browser-url";
import { resolveBrowserAddress } from "../../shared/runtime-browser-url";

const MAX_PUBLIC_BROWSER_ORIGINS = 64;

export function createWebContentsView(options: {
  window: BaseWindow;
  partition: string;
  allowedOrigins: string[];
  resolveNavigation?: (url: string) => RuntimeBrowserNavigationDecision;
  allowPublicNavigation?: boolean;
  onState: (state: "loading" | "ready" | "failed") => void;
  denyPermissions?: boolean;
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
  const publicOrigins = new Map<string, true>();
  for (const origin of options.allowedOrigins) publicOrigins.set(origin, true);
  const rememberPublicOrigin = (origin: string) => {
    publicOrigins.delete(origin);
    publicOrigins.set(origin, true);
    while (publicOrigins.size > MAX_PUBLIC_BROWSER_ORIGINS) {
      const oldest = publicOrigins.keys().next().value as string | undefined;
      if (!oldest) break;
      publicOrigins.delete(oldest);
    }
  };
  const publicNavigationUrl = (rawUrl: string): string | null => {
    if (!options.allowPublicNavigation) return null;
    const resolved = resolveBrowserAddress(rawUrl);
    return resolved?.disposition === "public" ? resolved.url : null;
  };
  const isAllowedNavigation = (url: string): boolean => {
    if (isNavigationAllowed(url, options.allowedOrigins)) return true;
    if (!options.allowPublicNavigation) return false;
    try {
      return publicOrigins.has(new URL(url).origin);
    } catch {
      return false;
    }
  };
  if (options.appBridge || options.denyPermissions) {
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

  const loadResolvedNavigation = (decision: RuntimeBrowserNavigationDecision): boolean => {
    if (decision.disposition === "block") return true;
    if (decision.disposition === "external") return false;
    if (!isNavigationAllowed(decision.url, options.allowedOrigins)) {
      options.onState("failed");
      return true;
    }
    void contents.loadURL(decision.url).catch(() => options.onState("failed"));
    return true;
  };

  // Block any navigation outside the allowlist. Browser embeds may rewrite
  // canonical runtime origins back through their ephemeral authenticated
  // tunnel; only explicitly public destinations reach the system browser.
  const blockExternalNavigation = (event: unknown, maybeUrl: unknown) => {
    const url = typeof maybeUrl === "string" ? maybeUrl : typeof event === "string" ? event : null;
    const preventDefault =
      event && typeof event === "object" && "preventDefault" in event
        ? (event as { preventDefault?: unknown }).preventDefault
        : null;
    if (!url || typeof preventDefault !== "function") return;
    if (!isAllowedNavigation(url)) {
      preventDefault.call(event);
      const decision = options.resolveNavigation?.(url);
      if (decision && loadResolvedNavigation(decision)) return;
      const publicUrl = publicNavigationUrl(url);
      if (publicUrl) {
        rememberPublicOrigin(new URL(publicUrl).origin);
        void contents.loadURL(publicUrl).catch(() => options.onState("failed"));
        return;
      }
      const externalUrl = safeExternalHttpUrl(url);
      if (externalUrl) void shell.openExternal(externalUrl);
    }
  };
  contents.on("will-navigate", blockExternalNavigation);
  contents.on("will-redirect", blockExternalNavigation);
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) {
      void contents.loadURL(url).catch(() => options.onState("failed"));
      return { action: "deny" };
    }
    const decision = options.resolveNavigation?.(url);
    if (decision && loadResolvedNavigation(decision)) return { action: "deny" };
    const publicUrl = publicNavigationUrl(url);
    if (publicUrl) {
      rememberPublicOrigin(new URL(publicUrl).origin);
      void contents.loadURL(publicUrl).catch(() => options.onState("failed"));
      return { action: "deny" };
    }
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
