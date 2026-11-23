import { createHttpMessageBoardClient, type BoardEventsSocket, type MessageBoardClient } from "@matrix-os/ui/message-board";
import { buildGatewayUrl } from "../../lib/api";

export interface DesktopBoardClientOptions {
  /** The signed-in platform host; requests reach the selected computer through it. */
  platformHost: string;
  /** The runtime slot captured when the board opened; a switch remounts with a new client. */
  runtimeSlot: string;
  fetch?: typeof fetch;
  createSocket?: (url: string) => BoardEventsSocket;
  /** A 401 means the desktop session expired; the trusted core prompts sign-in. */
  onUnauthorized?: () => void;
}

/**
 * The shared Message Board HTTP client, addressed the way every Electron
 * Desktop request is: through the platform host with the runtime slot, so a
 * preview or secondary computer gets its own board. Auth is the desktop
 * session the main process attaches to platform requests.
 */
export function createDesktopMessageBoardClient(options: DesktopBoardClientOptions): MessageBoardClient {
  const base = options.platformHost.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const routed = (url: string) => url.startsWith(base) ? buildGatewayUrl(base, url.slice(base.length), options.runtimeSlot) : url;
  return createHttpMessageBoardClient({
    baseUrl: base,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetchImpl(routed(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url), init);
      if (response.status === 401) options.onUnauthorized?.();
      return response;
    }) as typeof fetch,
    eventsUrl: (query) => {
      const path = `/ws/board/events?${new URLSearchParams(query).toString()}`;
      return buildGatewayUrl(base.replace(/^http/, "ws"), path, options.runtimeSlot);
    },
    createSocket: options.createSocket ?? ((url) => new WebSocket(url) as unknown as BoardEventsSocket),
  });
}
