import type { Session, WebContents } from "electron";

export interface BrowserLabViewerAuth {
  getGatewayOrigin(): string;
  getToken(): string | null;
  getAuthGeneration(): number;
}
type ViewerContents = Pick<WebContents, "id" | "session" | "getURL" | "isDestroyed" | "once" | "removeListener">;
interface ViewerRegistration { contents: ViewerContents; origin: string; generation: number; dispose?: () => void }
const ROOT = "/apps/browser-lab";
const FILTER = { urls: ["wss://*/apps/browser-lab/viewer/websockify*", "ws://*/apps/browser-lab/viewer/websockify*"] };

function parseUrl(raw: string): URL | null {
  try { return new URL(raw); }
  catch (error) {
    if (!(error instanceof TypeError)) console.warn("[browser-lab] Transport URL unavailable", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

function atPath(raw: string, origin: string, path: string, children = false): boolean {
  const url = parseUrl(raw);
  return !!url && url.origin === origin && !url.username && !url.password
    && (url.pathname === path || (children && url.pathname.startsWith(`${path}/`)));
}

/** Grants installed Kasm iframe transport one precise capability, never app-wide bearer access. */
export function createBrowserLabViewerAdmission(auth: BrowserLabViewerAuth) {
  const viewers = new Map<number, ViewerRegistration>();
  let session: Session | undefined;
  let installed = false;
  const detachIfEmpty = () => {
    if (installed && viewers.size === 0) {
      session?.webRequest.onBeforeSendHeaders(FILTER, null);
      installed = false;
    }
  };
  const current = (viewer: { contents: ViewerContents; origin: string; generation: number }) =>
    !viewer.contents.isDestroyed() && viewer.generation === auth.getAuthGeneration()
      && viewer.origin === parseUrl(auth.getGatewayOrigin())?.origin;
  const sweep = () => {
    for (const viewer of viewers.values()) if (!current(viewer)) viewer.dispose?.();
    detachIfEmpty();
  };
  return {
    register(contents: ViewerContents): () => void {
      sweep();
      viewers.get(contents.id)?.dispose?.();
      // The single isolated lab partition has at most the bounded embed count.
      if ((session && session !== contents.session) || viewers.size >= 12) return () => {};
      session = contents.session;
      const gateway = parseUrl(auth.getGatewayOrigin());
      if (!gateway || !["https:", "http:"].includes(gateway.protocol)) return () => {};
      const origin = gateway.origin;
      const viewer: ViewerRegistration = { contents, origin, generation: auth.getAuthGeneration() };
      viewers.set(contents.id, viewer);
      const unregister = () => {
        contents.removeListener("destroyed", unregister);
        if (viewers.get(contents.id) === viewer) viewers.delete(contents.id);
        detachIfEmpty();
      };
      viewer.dispose = unregister;
      contents.once("destroyed", unregister);
      if (!installed) {
        installed = true;
        session.webRequest.onBeforeSendHeaders(FILTER, (details, callback) => {
          const requestHeaders = { ...details.requestHeaders };
          sweep();
          const registered = details.webContentsId === undefined ? undefined : viewers.get(details.webContentsId);
          const origins = Object.entries(requestHeaders).filter(([name]) => name.toLowerCase() === "origin");
          if (registered && details.method === "GET" && details.resourceType === "webSocket"
            && origins.length === 1 && origins[0]?.[1] === registered.origin
            && atPath(registered.contents.getURL(), registered.origin, ROOT, true)
            && details.frame && atPath(details.frame.url, registered.origin, `${ROOT}/viewer/`)) {
            try {
              const url = new URL(details.url);
              const gateway = new URL(registered.origin);
              gateway.protocol = gateway.protocol === "https:" ? "wss:" : "ws:";
              const ticket = url.searchParams.get("lab_ticket");
              if (url.origin === gateway.origin && url.pathname === `${ROOT}/viewer/websockify`
                && !url.username && !url.password && !url.hash && url.searchParams.size === 1
                && ticket && /^[a-f0-9]{48}$/.test(ticket)) {
                const token = auth.getToken();
                if (token && current(registered)) {
                  for (const name of Object.keys(requestHeaders)) if (name.toLowerCase() === "authorization") delete requestHeaders[name];
                  requestHeaders.Authorization = `Bearer ${token}`;
                }
              }
            } catch (error) {
              if (!(error instanceof TypeError)) console.warn("[browser-lab] Transport admission unavailable", error instanceof Error ? error.name : "unknown");
            }
          }
          callback({ requestHeaders });
        });
      }
      return unregister;
    },
    close() { for (const viewer of viewers.values()) viewer.dispose?.(); viewers.clear(); detachIfEmpty(); },
  };
}
