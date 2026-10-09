import { z } from "zod/v4";

export const NATIVE_APP_OPEN_CHANNEL = "native-app:open";
const AppIdentity = z.string().max(256).regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/);
// Folder names are owner-controlled; the authenticated runtime catalog resolves
// their stable manifest identity. Never treat a folder spelling as an app ID.
const AppPath = z.string().min(1).max(4096).refine((value) => {
  if (value.startsWith("matrix-app:")) return /^matrix-app:[a-z0-9][a-z0-9-]{0,63}$/.test(value);
  const path = value.replace(/^(?:~\/|\/files\/)/, "").replace(/\/$/, "");
  if (!path.startsWith("apps/") || /[\\\u0000-\u001f\u007f%?#:]/.test(path)) return false;
  const parts = path.split("/");
  return parts.length <= 18 && parts.every(part => part.length > 0 && part.length <= 255 && part !== "." && part !== "..");
});
export const NativeAppOpenRequestSchema = z.strictObject({ name: z.string().trim().min(1).max(256), path: AppPath });
export type NativeAppOpenRequest = z.infer<typeof NativeAppOpenRequestSchema>;
export const NativeAppOpenTargetSchema = z.strictObject({ slug: AppIdentity, name: z.string().trim().min(1).max(256), appIdentity: AppIdentity });
export type NativeAppOpenTarget = z.infer<typeof NativeAppOpenTargetSchema>;
export const NativeAppOpenEventSchema = NativeAppOpenTargetSchema.extend({
  runtimeSlot: z.string().min(1).max(64), authGeneration: z.number().int().min(0),
}).strict();

/** Matches the web bridge: a launch request, not a completion acknowledgement. */
export function createNativeAppOpenClient(invoke: (request: NativeAppOpenRequest) => Promise<unknown>) {
  return (name: string, path: string): void => {
    const parsed = NativeAppOpenRequestSchema.safeParse({ name, path });
    if (!parsed.success) throw new Error("Invalid app launch");
    void invoke(parsed.data).catch((error: unknown) => {
      console.warn("[app-open] App launch is unavailable", error instanceof Error ? error.name : "UnknownError");
    });
  };
}
