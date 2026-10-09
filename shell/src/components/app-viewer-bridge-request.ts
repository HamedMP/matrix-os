import { prepareAppBridgeFetch } from "./app-capability-request";
import { isAllowedBridgeFetchUrl } from "./app-viewer-bridge-policy";

/** Connections belong to the signed-in owner on the platform, not to a VPS. */
export function resolveBridgeFetchUrl(gatewayUrl: string, url: string): string {
  return url === "/api/integrations"
    ? new URL(url, gatewayUrl).toString()
    : `${gatewayUrl}${url}`;
}

/** Authorize the same method that the trusted parent will dispatch. */
export function prepareBridgeFetchRequest(appName: string, payload: unknown): { url: string; init: RequestInit } {
  if (!payload || typeof payload !== "object") throw new Error("Invalid bridge fetch payload");
  const { url, init } = payload as { url?: unknown; init?: unknown };
  const source = init && typeof init === "object" ? init as RequestInit : {};
  if (source.method !== undefined && typeof source.method !== "string") throw new Error("Invalid bridge fetch method");
  const method = (source.method ?? "GET").toUpperCase();
  if (typeof url !== "string" || !isAllowedBridgeFetchUrl(appName, url, method)) throw new Error("Blocked bridge fetch URL");
  const requestInit = { ...source, method };
  return prepareAppBridgeFetch(appName, url, requestInit);
}
