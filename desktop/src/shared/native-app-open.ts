import { z } from "zod/v4";

export const NATIVE_APP_OPEN_CHANNEL = "native-app:open";
const AppIdentity = z.string().max(256).regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/);
const AppPath = z.string().max(512).regex(/^(?:~\/|\/files\/)?apps\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*(?:\/(?:dist\/)?index\.html)?\/?$/);
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
