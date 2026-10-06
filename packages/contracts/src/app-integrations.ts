import { z } from "zod/v4";

export const APP_INTEGRATION_CHANNEL = "native-app:integration-read";
export const APP_INTEGRATION_TIMEOUT_MS = 30_000;
export const AppIntegrationAppSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const NameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const AppIntegrationInputSchema = z.strictObject({
  service: NameSchema,
  action: NameSchema,
  connectionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  label: z.string().trim().min(1).max(100),
  params: z.record(z.string().max(128), z.json()).default({}),
}).refine((input) => new TextEncoder().encode(JSON.stringify(input.params)).byteLength <= 32_768);
export const AppIntegrationRequestSchema = z.strictObject({
  type: z.literal("inventory"),
}).or(z.strictObject({ type: z.literal("call"), input: AppIntegrationInputSchema }));
export const AppIntegrationCallSchema = AppIntegrationInputSchema.extend({ app: AppIntegrationAppSchema });
export type AppIntegrationRequest = z.infer<typeof AppIntegrationRequestSchema>;
export type AppIntegrationInput = z.infer<typeof AppIntegrationInputSchema>;

/** Same narrow API in Web Desktop, Web Canvas and native Electron app views. */
export function createAppIntegrationClient(invoke: (request: AppIntegrationRequest) => Promise<unknown>) {
  const request = async (input: AppIntegrationRequest) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([invoke(AppIntegrationRequestSchema.parse(input)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Integration read timed out")), APP_INTEGRATION_TIMEOUT_MS);
      })]);
    } catch (error) {
      console.warn("[app-integrations] read failed:", error instanceof Error ? error.name : "UnknownError");
      throw new Error("App integration read is unavailable");
    } finally { clearTimeout(timer); }
  };
  return Object.freeze({
    integrationReads: () => request({ type: "inventory" }),
    serviceRead: (service: string, action: string, params: AppIntegrationInput["params"], connectionId: string, label: string) =>
      request({ type: "call", input: { service, action, params, connectionId, label } }),
  });
}
