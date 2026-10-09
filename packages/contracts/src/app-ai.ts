import { z } from "zod/v4";
import { ProviderModelReferenceSchema } from "#contract-primitives";
export const APP_AI_TIMEOUT_MS = 30000;
export const APP_AI_CHANNEL = "native-app:ai-generate";
export const APP_AI_ROUTES_CHANNEL = "native-app:ai-routes";
const RouteIdSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/);
export const AppAiRouteSelectionSchema = z.strictObject({
    harnessId: RouteIdSchema,
    accountId: RouteIdSchema.nullable(),
    accessSourceId: RouteIdSchema,
    modelId: ProviderModelReferenceSchema,
});
export const AppAiRouteSchema = AppAiRouteSelectionSchema.extend({
    displayName: z.string().min(1).max(160),
    availability: z.enum(["available", "unavailable"]),
    readiness: z.enum(["ready", "local_profile", "unavailable"]),
    reason: z.enum(["disabled", "not_ready", "completion_unavailable"]).nullable(),
});
export const AppAiRoutesSchema = z.strictObject({
    routes: z.array(AppAiRouteSchema).max(128),
    defaultRoute: AppAiRouteSelectionSchema.nullable(),
});
export type AppAiRouteSelection = z.infer<typeof AppAiRouteSelectionSchema>;
export type AppAiRoute = z.infer<typeof AppAiRouteSchema>;
export type AppAiRoutes = z.infer<typeof AppAiRoutesSchema>;
export const AppAiInputSchema = z.strictObject({
    prompt: z.string().trim().min(1).max(32000),
    route: AppAiRouteSelectionSchema.optional(),
});
export const AppAiRequestSchema = AppAiInputSchema.extend({
    app: z.string().min(1).max(256).regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/),
});
export const AppAiRoutesRequestSchema = z.strictObject({ app: AppAiRequestSchema.shape.app });
export const AppAiResultSchema = z.strictObject({ text: z.string().max(64000) });
export type AppAiInput = z.infer<typeof AppAiInputSchema>;
export type AppAiRequest = z.infer<typeof AppAiRequestSchema>;
export type AppAiResult = z.infer<typeof AppAiResultSchema>;
/** Same API in a sandboxed web iframe and an Electron app view. */
export function createAppAiClient(invoke: (input: AppAiInput) => Promise<unknown>, invokeRoutes?: () => Promise<unknown>) {
    return Object.freeze({
        async routes(): Promise<AppAiRoutes> {
            if (!invokeRoutes)
                throw new Error("App AI route discovery is unavailable");
            try {
                return AppAiRoutesSchema.parse(await invokeRoutes());
            }
            catch (error) {
                console.warn("[app-ai] discovery failed:", error instanceof Error ? error.name : "UnknownError");
                throw new Error("App AI is unavailable");
            }
        },
        async generate(input: AppAiInput): Promise<AppAiResult> {
            const parsed = AppAiInputSchema.safeParse(input);
            if (!parsed.success)
                throw new Error("Invalid app AI request");
            try {
                return AppAiResultSchema.parse(await invoke(parsed.data));
            }
            catch (error) {
                console.warn("[app-ai] request failed:", error instanceof Error ? error.name : "UnknownError");
                throw new Error("App AI is unavailable");
            }
        },
    });
}
// Legacy API submits a kernel task; it has never returned generated text.
export const APP_GENERATE_CHANNEL = "native-app:generate";
export const AppGenerateContextSchema = z.string().min(1).max(32000).refine((value) => value.trim().length > 0);
export const AppGenerateEventSchema = z.strictObject({
    app: AppAiRequestSchema.shape.app,
    context: AppGenerateContextSchema,
    runtimeSlot: z.string().min(1).max(64),
    authGeneration: z.number().int().nonnegative(),
});
export function createAppGenerateClient(invoke: (context: string) => Promise<unknown>) {
    return (context: string): void => {
        const parsed = AppGenerateContextSchema.safeParse(context);
        if (!parsed.success)
            throw new Error("Invalid app task");
        void invoke(parsed.data).catch((error: unknown) => console.warn("[app-generate] App task is unavailable", error instanceof Error ? error.name : "UnknownError"));
    };
}
