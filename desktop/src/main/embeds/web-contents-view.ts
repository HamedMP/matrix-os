// Electron WebContentsView adapter implementing EmbedViewLike. Each embed runs
// in its own isolated partition. Hosted-shell views have no preload/IPC
// exposure; app views may receive the narrow database-only preload. Navigation
// is gated by an origin allowlist; external links open in the system browser.
import { WebContentsView, shell, type BaseWindow, type NativeImage } from "electron";
import { isNavigationAllowed } from "./origin-policy";
import type { Bounds, EmbedViewLike } from "./embed-manager";
import { safeExternalHttpUrl } from "../external-url";
import type { RuntimeBrowserNavigationDecision } from "../../shared/runtime-browser-url";
import { resolveBrowserAddress } from "../../shared/runtime-browser-url";

const MAX_PUBLIC_BROWSER_ORIGINS = 64;
const MAX_EMBED_SNAPSHOT_BYTES = 3_000_000;
const MAX_EMBED_SNAPSHOT_CAPTURE_EDGE = 2_048;
const EMBED_SNAPSHOT_QUALITIES = [72, 54, 36, 24] as const;

function encodeBoundedSnapshot(source: NativeImage): string | null {
  let image = source;
  for (let resizeAttempt = 0; resizeAttempt < 4; resizeAttempt += 1) {
    for (const quality of EMBED_SNAPSHOT_QUALITIES) {
      const jpeg = image.toJPEG(quality);
      if (jpeg.byteLength <= MAX_EMBED_SNAPSHOT_BYTES) {
        return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      }
    }
    const { width, height } = image.getSize();
    if (width <= 320 || height <= 200) break;
    image = image.resize({
      width: Math.max(320, Math.floor(width * 0.7)),
      height: Math.max(200, Math.floor(height * 0.7)),
    });
  }
  return null;
}

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
  let retainedSnapshotDataUrl: string | null = null;
  let snapshotContentGeneration = 0;
  let snapshotCaptureBounds: Bounds | undefined;
  let snapshotCaptureInFlight: {
    generation: number;
    promise: Promise<string | null>;
  } | null = null;
  const captureSnapshot = (): Promise<string | null> => {
    const generation = snapshotContentGeneration;
    if (snapshotCaptureInFlight?.generation === generation) {
      return snapshotCaptureInFlight.promise;
    }
    const capture = (async (): Promise<string | null> => {
      if (contents.isDestroyed()) return retainedSnapshotDataUrl;
      const image = await contents.capturePage(snapshotCaptureBounds);
      if (generation !== snapshotContentGeneration) return retainedSnapshotDataUrl;
      if (image.isEmpty()) return retainedSnapshotDataUrl;
      retainedSnapshotDataUrl = encodeBoundedSnapshot(image) ?? retainedSnapshotDataUrl;
      return retainedSnapshotDataUrl;
    })();
    const inFlight = { generation, promise: capture };
    snapshotCaptureInFlight = inFlight;
    void capture.then(
      () => {
        if (snapshotCaptureInFlight === inFlight) snapshotCaptureInFlight = null;
      },
      () => {
        if (snapshotCaptureInFlight === inFlight) snapshotCaptureInFlight = null;
      },
    );
    return capture;
  };
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
  contents.on("did-start-loading", () => {
    snapshotContentGeneration += 1;
    retainedSnapshotDataUrl = null;
    options.onState("loading");
  });
  contents.on("did-finish-load", () => {
    options.onState("ready");
    // Warm the first retained frame while the view is definitely paintable so
    // an immediate z-order change can fall back if the next capture is late.
    void captureSnapshot().catch((error: unknown) => {
      console.warn(
        "[embeds] retained frame warm-up failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
  });
  contents.on("did-fail-load", (_e, errorCode, _description, _validatedUrl, isMainFrame) => {
    if (isMainFrame === false) return;
    // -3 is ERR_ABORTED (e.g. a redirect); not a real failure.
    if (errorCode !== -3) options.onState("failed");
  });

  let attached = false;
  const detachFromWindow = () => {
    if (!attached) return;
    attached = false;
    // BrowserWindow emits "closed" after Electron has destroyed its native
    // contentView. OTA quit-and-install can therefore reach embed cleanup
    // after the parent is already gone; the child view is detached as part of
    // that destruction, so there is nothing left to remove explicitly.
    if (options.window.isDestroyed()) return;
    options.window.contentView.removeChildView(view);
  };

  return {
    setBounds(bounds: Bounds) {
      view.setBounds(bounds);
      snapshotCaptureBounds = {
        x: 0,
        y: 0,
        width: Math.min(bounds.width, MAX_EMBED_SNAPSHOT_CAPTURE_EDGE),
        height: Math.min(bounds.height, MAX_EMBED_SNAPSHOT_CAPTURE_EDGE),
      };
    },
    setScale(factor: number) {
      contents.setZoomFactor(factor);
    },
    async loadUrl(url: string) {
      await contents.loadURL(url);
    },
    captureSnapshot,
    attach() {
      if (attached) return;
      options.window.contentView.addChildView(view);
      attached = true;
    },
    detach() {
      detachFromWindow();
    },
    destroy() {
      options.appBridge?.unregister(contents.id);
      detachFromWindow();
      // WebContentsView is GC'd once detached and dereferenced; closing the
      // contents releases the renderer process promptly.
      if (!contents.isDestroyed()) contents.close();
    },
  };
}
