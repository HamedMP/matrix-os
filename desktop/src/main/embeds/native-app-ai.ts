import { APP_AI_TIMEOUT_MS, AppAiInputSchema, AppAiResultSchema, AppIdentitySchema, MAX_APP_DATABASE_REPLY_BYTES, type AppAiInput } from "@matrix-os/contracts";
import { requestNativeAppJson, type NativeAppRequesterOptions } from "./native-app-capabilities";

/** Uses the registered sender's lifetime and the fixed authenticated AI route. */
export function createNativeAppAiRequester(options: NativeAppRequesterOptions) {
  return async (app: string, rawInput: AppAiInput, signal?: AbortSignal) => {
    try {
      const identity = AppIdentitySchema.parse(app);
      const input = AppAiInputSchema.parse(rawInput);
      return AppAiResultSchema.parse(await requestNativeAppJson(options, "/api/bridge/ai", {
        method: "POST", body: JSON.stringify({ app: identity, ...input }),
      }, MAX_APP_DATABASE_REPLY_BYTES, signal, APP_AI_TIMEOUT_MS + 2_000));
    } catch (error) {
      console.warn("[native-app-ai] request failed", error instanceof Error ? error.name : "UnknownError");
      throw new Error("App AI is unavailable");
    }
  };
}
