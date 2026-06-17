// Origin-scoped Authorization injection (FR-002/FR-003): the renderer never
// holds the credential; the trusted core attaches it at the network layer for
// the active gateway origin ONLY — and only on the renderer session. Embed
// partitions never get this hook (lesson L1: remote content can never ride the
// native principal).

interface WebRequestLike {
  onBeforeSendHeaders(
    listener: (
      details: { url: string; requestHeaders: Record<string, string> },
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void,
  ): void;
}

interface SessionLike {
  webRequest: WebRequestLike;
}

function normalizeWsScheme(url: URL): string {
  if (url.protocol === "ws:") return "http:";
  if (url.protocol === "wss:") return "https:";
  return url.protocol;
}

export function shouldInjectAuth(requestUrl: string, gatewayOrigin: string | null): boolean {
  if (!gatewayOrigin) return false;
  let request: URL;
  let gateway: URL;
  try {
    request = new URL(requestUrl);
    gateway = new URL(gatewayOrigin);
  } catch {
    return false;
  }
  return (
    normalizeWsScheme(request) === normalizeWsScheme(gateway) &&
    request.hostname === gateway.hostname &&
    request.port === gateway.port
  );
}

export function installHeaderInjection(
  rendererSession: SessionLike,
  getToken: () => string | null,
  getGatewayOrigin: () => string | null,
): void {
  rendererSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const token = getToken();
    if (token && shouldInjectAuth(details.url, getGatewayOrigin())) {
      details.requestHeaders["Authorization"] = `Bearer ${token}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}
