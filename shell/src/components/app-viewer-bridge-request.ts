import { prepareAppAiRequest } from "./app-ai-request";
import { isAllowedBridgeFetchUrl } from "./app-viewer-bridge-policy";
import { isAllowedMailBridgeBody } from "@matrix-os/contracts";

/** Authorize the same method that the trusted parent will dispatch. */
export function prepareBridgeFetchRequest(appName: string, payload: unknown): { url: string; init: RequestInit } {
  if (!payload || typeof payload !== "object") throw new Error("Invalid bridge fetch payload");
  const { url, init } = payload as { url?: unknown; init?: unknown };
  const source = init && typeof init === "object" ? init as RequestInit : {};
  if (source.method !== undefined && typeof source.method !== "string") throw new Error("Invalid bridge fetch method");
  const method = (source.method ?? "GET").toUpperCase();
  if (typeof url !== "string" || !isAllowedBridgeFetchUrl(appName, url, method)) throw new Error("Blocked bridge fetch URL");
  const requestInit = { ...source, method };
  if (url === "/api/mail/action") {
    const identity = appName;
    if (typeof source.body !== "string" || !isAllowedMailBridgeBody(identity, source.body)) throw new Error("Invalid email app request");
    return { url, init: { method: "POST", headers: { "content-type": "application/json" }, body: source.body } };
  }
  return { url, init: url === "/api/bridge/ai" ? prepareAppAiRequest(appName, requestInit) : requestInit };
}
