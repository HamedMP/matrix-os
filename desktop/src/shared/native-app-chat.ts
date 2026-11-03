import { z } from "zod/v4";

export const NATIVE_APP_OPEN_CHAT_CHANNEL = "native-app:open-chat";
export const NATIVE_APP_CHAT_COMPLETION_CHANNEL = "app:open-chat-complete";

const RecipeId = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const RequestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

export const NativeAppOpenChatRequestSchema = z.strictObject({
  view: z.literal("recipes"),
  recipeId: RecipeId.optional(),
});
export type NativeAppOpenChatRequest = z.infer<typeof NativeAppOpenChatRequestSchema>;

export const NativeAppOpenChatEventSchema = NativeAppOpenChatRequestSchema.extend({
  requestId: RequestId,
  runtimeSlot: z.string().min(1).max(64),
  authGeneration: z.number().int().min(0),
}).strict();
export type NativeAppOpenChatEvent = z.infer<typeof NativeAppOpenChatEventSchema>;

export const NativeAppChatCancellationSchema = z.strictObject({ requestId: RequestId });
export type NativeAppChatCancellation = z.infer<typeof NativeAppChatCancellationSchema>;

export const NativeAppChatNavigationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: z.enum(["recipe_unavailable", "navigation_unavailable"]) }),
]);
export type NativeAppChatNavigationResult = z.infer<typeof NativeAppChatNavigationResultSchema>;

export const NativeAppChatCompletionSchema = z.discriminatedUnion("ok", [
  z.strictObject({ requestId: RequestId, ok: z.literal(true) }),
  z.strictObject({
    requestId: RequestId,
    ok: z.literal(false),
    error: z.enum(["recipe_unavailable", "navigation_unavailable"]),
  }),
]);
export type NativeAppChatCompletion = z.infer<typeof NativeAppChatCompletionSchema>;

/** Unlike openApp, Chat navigation is acknowledged so embedded apps can show failures. */
export function createNativeAppOpenChatClient(
  invoke: (request: NativeAppOpenChatRequest) => Promise<unknown>,
) {
  return async (rawRequest: NativeAppOpenChatRequest): Promise<void> => {
    const parsed = NativeAppOpenChatRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new Error("Invalid Chat navigation");
    try {
      await invoke(parsed.data);
    } catch (failure: unknown) {
      console.warn("[native-app-chat] invocation failed:", failure instanceof Error ? failure.name : "UnknownError");
      throw new Error("Chat navigation is unavailable");
    }
  };
}
