// Electron WebContentsView adapter implementing EmbedViewLike. Each embed runs
// in its own isolated partition with no preload/IPC exposure — remote content
// can never reach the trusted core (FR-064). Navigation is gated by an origin
// allowlist; external links open in the system browser.
import { WebContentsView, shell, type BaseWindow } from "electron";
import { isNavigationAllowed } from "./origin-policy";
import type { Bounds, EmbedViewLike } from "./embed-manager";

export function createWebContentsView(options: {
  window: BaseWindow;
  partition: string;
  allowedOrigins: string[];
  onState: (state: "loading" | "ready" | "failed") => void;
}): EmbedViewLike {
  const view = new WebContentsView({
    webPreferences: {
      partition: options.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const contents = view.webContents;

  // Block any navigation outside the allowlist; route external links to the
  // system browser.
  contents.on("will-navigate", (event, url) => {
    if (!isNavigationAllowed(url, options.allowedOrigins)) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-start-loading", () => options.onState("loading"));
  contents.on("did-finish-load", () => options.onState("ready"));
  contents.on("did-fail-load", (_e, errorCode) => {
    // -3 is ERR_ABORTED (e.g. a redirect); not a real failure.
    if (errorCode !== -3) options.onState("failed");
  });

  let attached = false;

  return {
    setBounds(bounds: Bounds) {
      view.setBounds(bounds);
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
