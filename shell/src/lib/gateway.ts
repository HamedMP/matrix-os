/** Resolve the gateway URL for API calls. In cloud (*.matrix-os.com), uses the current origin. */
export function getGatewayUrl(): string {
  if (typeof window !== "undefined" && window.location.hostname.endsWith(".matrix-os.com")) {
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";
}

/** Resolve the gateway WebSocket URL. In cloud, uses the current host with wss. */
export function getGatewayWs(): string {
  if (typeof window !== "undefined" && window.location.hostname.endsWith(".matrix-os.com")) {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws`;
  }
  if (process.env.NEXT_PUBLIC_GATEWAY_WS) return process.env.NEXT_PUBLIC_GATEWAY_WS;
  if (typeof window === "undefined") return "ws://localhost:4000/ws";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:4000/ws`;
}
