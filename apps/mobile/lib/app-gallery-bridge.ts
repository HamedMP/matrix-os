import { isAllowedAppGalleryBridgeRequest, isAppGalleryIdentity } from "@matrix-os/contracts/app-gallery-bridge-policy";
import { isAllowedAppStoreGalleryRequest, appStoreBridgeTimeoutMs } from "@matrix-os/contracts/app-store-bridge-policy";

/** Native host policy; route hints from page messages never grant Gallery identity. */
export function isMobileGalleryRequestAllowed(app: string, runtimeSlug: string, path: string, method: string): boolean {
  return isAppGalleryIdentity(app, runtimeSlug) && (isAllowedAppGalleryBridgeRequest(path, method) || isAllowedAppStoreGalleryRequest(path, method));
}
export function mobileGalleryRequest(app: string, runtimeSlug: string, input: unknown): { path: string; init: RequestInit } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Gallery request");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["url", "method", "body"].includes(key)) || typeof value.url !== "string") throw new Error("Invalid Gallery request");
  const method = value.method ?? "GET";
  if (typeof method !== "string" || !isMobileGalleryRequestAllowed(app, runtimeSlug, value.url, method)) throw new Error("Invalid Gallery request");
  if (method === "GET" && value.body !== undefined) throw new Error("Invalid Gallery request");
  if (value.body !== undefined) {
    if (typeof value.body !== "string" || value.body.length > 48 * 1024) throw new Error("Invalid Gallery request");
    const body = JSON.parse(value.body);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid Gallery request");
  }
  return { path: value.url, init: { method, ...(value.body !== undefined ? { body: value.body as string } : {}) } };
}
export function mobileGalleryTimeout(path: unknown): number {
  return typeof path === "string" ? Math.min(120000, Math.max(35000, appStoreBridgeTimeoutMs(path))) : 35000;
}
export function mobileGalleryOpenInput(input: unknown): { name: string; path: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Gallery action");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "name" && key !== "path") || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 || typeof value.path !== "string" || !/^(?:apps\/[a-z0-9][a-z0-9-]{0,63}|matrix-app:[a-z][a-z0-9-]{0,47})$/.test(value.path)) throw new Error("Invalid Gallery action");
  return { name: value.name, path: value.path };
}
