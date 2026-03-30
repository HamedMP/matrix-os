/**
 * Resolve the gateway URL for API calls.
 * Browser: always use current origin (requests go through shell proxy which injects auth).
 * Server: use GATEWAY_URL env var (direct container-internal access).
 */
export function getGatewayUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return process.env.GATEWAY_URL ?? "http://localhost:4000";
}

/**
 * Resolve the gateway WebSocket URL.
 * Browser: always use current host (shell proxy handles /ws).
 * Server: use direct gateway URL.
 */
export function getGatewayWs(): string {
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws`;
  }
  return process.env.NEXT_PUBLIC_GATEWAY_WS ?? "ws://localhost:4000/ws";
}
