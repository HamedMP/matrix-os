/** Browser composition for the standalone assistant's canonical voice client. */
import { getGatewayWs } from "./gateway";

const VOICE_GRANT_RESPONSE_PATH =
  /\/api\/chats\/[A-Za-z0-9_-]+\/voice\/sessions(?:\/[A-Za-z0-9_-]+\/reconnect)?$/;

export function voiceMediaSupported(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function";
}

/** Bind a root-relative voice lease to the current gateway WebSocket origin. */
export function resolveVoiceTransportUrl(path: string, gatewayWs: string = getGatewayWs()): string {
  const base = new URL(gatewayWs);
  const prefix = base.pathname.replace(/\/ws\/?$/, "");
  return new URL(`${prefix}${path}`, base.origin).href;
}

function absolutizeTransport(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const transport = (body as { transport?: unknown }).transport;
  if (typeof transport !== "object" || transport === null) return false;
  let rewritten = false;
  for (const key of ["url", "controlUrl"] as const) {
    const value = (transport as Record<string, unknown>)[key];
    if (typeof value === "string" && value.startsWith("/")) {
      (transport as Record<string, unknown>)[key] = resolveVoiceTransportUrl(value);
      rewritten = true;
    }
  }
  return rewritten;
}

/** Rewrite voice transport grants while leaving every other response untouched. */
export function createVoiceSessionFetcher(base: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await base(input, init);
    if (!response.ok) return response;
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL ? input.href : input.url;
    let pathname: string;
    try {
      pathname = new URL(requestUrl).pathname;
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      return response;
    }
    if (!VOICE_GRANT_RESPONSE_PATH.test(pathname)) return response;
    const passthrough = response.clone();
    let body: unknown;
    try {
      body = await response.json();
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return passthrough;
    }
    if (!absolutizeTransport(body)) return passthrough;
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
