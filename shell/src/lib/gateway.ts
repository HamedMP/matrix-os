/**
 * Resolve the gateway URL for API calls.
 * Browser: use the current origin, plus the explicit `/vm/<handle>` prefix when
 * the shell runs under an explicit vm route (preview VPSes and multi-machine
 * switching). Root-path `/api` and `/files` calls route through the
 * shell-route cookie to the user's default machine, so an explicit-vm shell
 * that called the bare origin would silently hit the wrong computer; the
 * `/vm/<handle>` prefix makes the target machine explicit on every call.
 * Server: use GATEWAY_URL env var (direct container-internal access).
 */
export function getGatewayUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin + getExplicitVmPrefix();
  }
  return process.env.GATEWAY_URL ?? "http://localhost:4000";
}

/**
 * Resolve the gateway WebSocket URL.
 * Browser: current host through the shell proxy, with the same explicit-vm
 * prefix as getGatewayUrl (the platform maps `/vm/<handle>/ws` to the machine's
 * `/ws` upstream).
 * Server: use direct gateway URL.
 */
export function getGatewayWs(): string {
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}${getExplicitVmPrefix()}/ws`;
  }
  return process.env.NEXT_PUBLIC_GATEWAY_WS ?? "ws://localhost:4000/ws";
}

/** The `/vm/<handle>` prefix of the current explicit vm route, or "" at the root. */
function getExplicitVmPrefix(): string {
  const pathname = window.location?.pathname ?? "";
  const match = pathname.match(/^\/vm\/([A-Za-z0-9_-]{1,64})(?:\/|$)/);
  if (!match) return "";
  const runtimeSlot = new URLSearchParams(window.location?.search ?? "").get("runtime");
  return runtimeSlot && /^[A-Za-z0-9_-]{1,32}$/.test(runtimeSlot)
    ? `/vm/${match[1]}/~runtime/${runtimeSlot}`
    : `/vm/${match[1]}`;
}
