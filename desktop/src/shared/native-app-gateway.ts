import { z } from "zod/v4";

export const NATIVE_APP_GATEWAY_CHANNEL = "native-app:gateway-fetch";
export const NATIVE_APP_GATEWAY_TIMEOUT_MS = 10_000;

const ActivityQuerySchema = z.strictObject({
  processLimit: z.string().regex(/^(?:[1-9][0-9]?|100)$/).optional(),
  includeSuggestions: z.enum(["true", "false"]).optional(),
});

// This compatibility method intentionally grants only Resource Manager's read.
// Do not turn it into arbitrary authenticated gateway access for installed apps.
export const NativeAppGatewayRequestSchema = z.strictObject({
  url: z.string().max(256).refine((url) => {
    if (!/^\/api\/system\/activity(?:\?[^#]*)?$/.test(url)) return false;
    const params = new URLSearchParams(url.split("?")[1]);
    const values = Object.fromEntries(params);
    return Object.keys(values).length === [...params].length
      && ActivityQuerySchema.safeParse(values).success;
  }),
  init: z.strictObject({ method: z.literal("GET").optional() }).optional(),
});

export type NativeAppGatewayRequest = z.infer<typeof NativeAppGatewayRequestSchema>;

export function createNativeAppGatewayFetch(
  invoke: (request: NativeAppGatewayRequest) => Promise<unknown>,
) {
  return async <T>(url: string, init?: RequestInit, timeoutMs = NATIVE_APP_GATEWAY_TIMEOUT_MS): Promise<T> => {
    const parsed = NativeAppGatewayRequestSchema.safeParse({ url, ...(init ? { init } : {}) });
    if (!parsed.success) throw new Error("invalid app gateway request");
    const timeout = Number.isFinite(timeoutMs)
      ? Math.max(1, Math.min(timeoutMs, NATIVE_APP_GATEWAY_TIMEOUT_MS))
      : NATIVE_APP_GATEWAY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        invoke(parsed.data),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("app gateway request timed out")), timeout);
        }),
      ]) as T;
    } catch (error: unknown) {
      console.warn("[native-app-bridge] gateway read failed:",
        error instanceof Error ? error.name : typeof error);
      // Main logs the underlying error; apps only receive a fixed safe message.
      throw new Error("app gateway request failed");
    } finally {
      clearTimeout(timer);
    }
  };
}
