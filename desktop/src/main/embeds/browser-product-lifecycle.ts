import type { WebContents } from "electron";

export function createBrowserProductLifecycle(options: {
  contents: Pick<WebContents, "getURL" | "isDestroyed" | "loadURL" | "executeJavaScript">;
  origin: string;
  renew: () => Promise<unknown>;
  refreshAdmission: () => void;
  revokeAdmission: () => void;
}) {
  let started = false;
  let active = false;
  let ready = false;
  let closed = false;
  const notify = () => {
    if (!ready || closed || options.contents.isDestroyed()) return;
    try {
      const url = new URL(options.contents.getURL());
      if (url.origin !== options.origin || url.pathname !== "/apps/browser-lab/") return;
      const message = JSON.stringify({ type: "matrix-browser-visibility", active });
      void options.contents.executeJavaScript(`void window.postMessage(${message},${JSON.stringify(options.origin)})`).catch(error => {
        console.warn("[browser] Visibility unavailable", error instanceof Error ? error.name : "unknown");
      });
    } catch (error) {
      if (!(error instanceof TypeError)) console.warn("[browser] Visibility unavailable", error instanceof Error ? error.name : "unknown");
    }
  };
  return {
    async loadUrl(raw: string) {
      if (closed) throw new Error("browser view closed");
      const url = new URL(raw);
      if (url.origin !== options.origin || url.pathname !== "/apps/browser-lab/"
        || !["browser", "desktop"].includes(url.searchParams.get("surface") ?? "")) throw new Error("invalid browser surface");
      if (started) { await options.renew(); url.searchParams.delete("session"); }
      if (closed || options.contents.isDestroyed()) throw new Error("browser view closed");
      ready = false; started = true;
      options.refreshAdmission();
      await options.contents.loadURL(url.toString());
    },
    ready() { ready = true; notify(); },
    setActive(value: boolean) { active = value; notify(); },
    close() { closed = true; options.revokeAdmission(); },
  };
}
