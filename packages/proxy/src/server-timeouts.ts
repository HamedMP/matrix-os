export const PROXY_INBOUND_TIMEOUT_MS = 10_000;

export interface ConfigurableProxyServer {
  headersTimeout: number;
  requestTimeout: number;
}

export function configureProxyServerTimeouts(server: object): void {
  if (!("headersTimeout" in server) || !("requestTimeout" in server)) {
    throw new Error("Proxy server does not expose HTTP request timeout controls");
  }
  const configurable = server as ConfigurableProxyServer;
  configurable.headersTimeout = PROXY_INBOUND_TIMEOUT_MS;
  configurable.requestTimeout = PROXY_INBOUND_TIMEOUT_MS;
}
