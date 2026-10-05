import { boundedJson } from "@matrix-os/ui/voice-session";

/** Credentials remain in the trusted core. This adapter captures the runtime
 * for the shared controller's entire lifetime, including its late cleanup.
 */
export function createDesktopAoedeFetcher(options: { baseUrl: string; runtimeSlot: string; fetcher?: typeof fetch }): typeof fetch {
  const base = new URL(options.baseUrl);
  const slot = options.runtimeSlot;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(slot)) throw new TypeError("Invalid runtime");
  const fetcher = options.fetcher ?? fetch;
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/api/`)) throw new TypeError("Invalid assistant target");
    if (slot !== "primary") url.searchParams.set("runtime", slot);
    if (/\/voice\/capabilities$/.test(url.pathname)) url.searchParams.set("surface", "electron_desktop");
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const response = await fetcher(input instanceof Request ? new Request(url, input) : url.href, { ...init, signal });
    if (!response.ok || !/\/voice\/sessions(?:\/vs_[A-Za-z0-9_-]+\/reconnect)?$/.test(url.pathname)) return response;
    const value = await boundedJson(response);
    if (!value || typeof value !== "object") throw new TypeError("Invalid voice grant");
    const transport = (value as { transport?: unknown }).transport;
    if (transport && typeof transport === "object" && "url" in transport) {
      const path = transport.url;
      if (typeof path !== "string" || !/^\/ws\/chats\/[A-Za-z0-9_-]+\/voice\/vs_[A-Za-z0-9_-]+$/.test(path)) throw new TypeError("Invalid voice grant");
      const ws = new URL(base);
      ws.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      ws.pathname = `${base.pathname.replace(/\/$/, "")}${slot === "primary" ? "" : `/vm/${slot}`}${path}`;
      ws.search = ""; ws.hash = "";
      transport.url = ws.href;
    }
    return new Response(JSON.stringify(value), { status: response.status, headers: { "content-type": "application/json" } });
  };
}
