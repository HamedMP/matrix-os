import { z } from "zod/v4";
import { isAllowedAppGalleryBridgeRequest, isAppGalleryIdentity, isAppGalleryInventoryIdentity } from "@matrix-os/contracts/app-gallery-bridge-policy";
import { parseGalleryInventory } from "@matrix-os/contracts/app-gallery-inventory";

export const NATIVE_APP_GATEWAY_CHANNEL = "native-app:gateway-fetch";
export const NATIVE_APP_ACTIVITY_BRIDGE_ARG = "--matrix-app-activity-bridge";
export const NATIVE_APP_GALLERY_BRIDGE_ARG = "--matrix-app-gallery-bridge";
export const NATIVE_APP_INTEGRATIONS_BRIDGE_ARG = "--matrix-app-integrations-bridge";
export const NATIVE_APP_GATEWAY_TIMEOUT_MS = 10_000;
export const NATIVE_APP_GALLERY_INSTALL_TIMEOUT_MS = 35_000;

export function isNativeAppActivityIdentity(appIdentity: string, routeSlug: string): boolean {
  return appIdentity === "resource-manager" && routeSlug === "resource-manager";
}
const ActivityQuerySchema = z.strictObject({
  processLimit: z.string().regex(/^(?:[1-9][0-9]?|100)$/).optional(),
  includeSuggestions: z.enum(["true", "false"]).optional(),
});
function isActivityRead(url: string, method: string): boolean {
  if (method !== "GET" || !/^\/api\/system\/activity(?:\?[^#]*)?$/.test(url)) return false;
  const params = new URLSearchParams(url.split("?")[1]);
  return Object.keys(Object.fromEntries(params)).length === [...params].length
    && ActivityQuerySchema.safeParse(Object.fromEntries(params)).success;
}
function emptyJsonBody(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch (error) {
    if (!(error instanceof SyntaxError)) console.warn("[native-app-bridge] invalid installation body");
    return false;
  }
}

/** Shape validation precedes sender-bound capability authorization in main. */
export const NativeAppGatewayRequestSchema = z.strictObject({
  url: z.string().max(256),
  init: z.strictObject({
    method: z.enum(["GET", "POST"]).optional(),
    headers: z.strictObject({ "Content-Type": z.literal("application/json").optional(), "content-type": z.literal("application/json").optional() }).optional(),
    body: z.string().max(4096).refine(emptyJsonBody).optional(),
  }).optional(),
}).refine(({ url, init }) => {
  const method = init?.method ?? "GET";
  if (!isActivityRead(url, method) && !isAllowedAppGalleryBridgeRequest(url, method)) return false;
  return method === "POST" ? init?.body !== undefined : init?.body === undefined && init?.headers === undefined;
});
export type NativeAppGatewayRequest = z.infer<typeof NativeAppGatewayRequestSchema>;

export function isAllowedNativeAppGatewayRequest(appIdentity: string, routeSlug: string, request: NativeAppGatewayRequest): boolean {
  const method = request.init?.method ?? "GET";
  if (isNativeAppActivityIdentity(appIdentity, routeSlug)) return isActivityRead(request.url, method);
  if (isAppGalleryIdentity(appIdentity, routeSlug)) return isAllowedAppGalleryBridgeRequest(request.url, method);
  return isAppGalleryInventoryIdentity(appIdentity, routeSlug) && request.url === "/api/bridge/service" && method === "GET";
}
export function nativeAppGatewayTimeout(request: NativeAppGatewayRequest): number {
  return request.init?.method === "POST" ? NATIVE_APP_GALLERY_INSTALL_TIMEOUT_MS : NATIVE_APP_GATEWAY_TIMEOUT_MS;
}
export function createNativeAppGatewayFetch(invoke: (request: NativeAppGatewayRequest) => Promise<unknown>) {
  return async <T>(url: string, init?: RequestInit, timeoutMs = NATIVE_APP_GATEWAY_TIMEOUT_MS): Promise<T> => {
    const parsed = NativeAppGatewayRequestSchema.safeParse({ url, ...(init ? { init } : {}) });
    if (!parsed.success) throw new Error("invalid app gateway request");
    const maximum = nativeAppGatewayTimeout(parsed.data);
    const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, maximum)) : maximum;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([invoke(parsed.data), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("app gateway request timed out")), timeout);
      })]) as T;
    } catch (error) {
      console.warn("[native-app-bridge] gateway request failed:", error instanceof Error ? error.name : typeof error);
      throw new Error("app gateway request failed");
    } finally { clearTimeout(timer); }
  };
}
export function createNativeAppIntegrations(invoke: (request: NativeAppGatewayRequest) => Promise<unknown>) {
  return async () => {
    const value = await createNativeAppGatewayFetch(invoke)<unknown>("/api/bridge/service");
    if (!value || typeof value !== "object" || !("services" in value)) throw new Error("Connection inventory unavailable");
    return parseGalleryInventory(value.services);
  };
}
