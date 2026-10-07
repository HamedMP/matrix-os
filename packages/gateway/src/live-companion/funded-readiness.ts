import { z } from "zod/v4";
import { loadPlatformSpeechRuntimeConfig } from "../speech/platform-client.js";
import type { GeminiLiveConnection } from "../onboarding/gemini-live.js";

const Readiness = z.object({ available: z.boolean(), ownerId: z.string().min(1).max(160).optional(),
  maximumSessionMs: z.number().int().min(60_000).max(1_800_000).optional() }).strict();
export interface FundedNativeLiveAccess {
  connection: GeminiLiveConnection;
  allowed(principalId: string): Promise<boolean>;
}
export function createFundedNativeLiveAccess(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): FundedNativeLiveAccess | undefined {
  let config: ReturnType<typeof loadPlatformSpeechRuntimeConfig>;
  try { config = loadPlatformSpeechRuntimeConfig({ ...env, MATRIX_PLATFORM_SPEECH_ENABLED: "true" }); }
  catch (error: unknown) { console.warn("[native-live] runtime configuration unavailable", error instanceof Error ? error.name : "UnknownError"); return undefined; }
  if (!config || config.requestOwnerId !== config.identity.ownerId) return undefined;
  const origin = new URL(config.baseUrl);
  const handle = env.MATRIX_HANDLE!;
  const readiness = new URL(config.baseUrl.replace(/\/speech$/, "/native-live/capabilities"));
  readiness.searchParams.set("runtimeSlot", config.identity.runtimeSlot);
  const snapshot = config;
  return {
    connection: { proxy: { platformUrl: origin.origin, handle, token: config.runtimeAuthToken, endpoint: "native-live", runtimeSlot: config.identity.runtimeSlot } },
    async allowed(principalId: string) {
      if (principalId !== snapshot.requestOwnerId) return false;
      try {
        const response = await fetchImpl(readiness.toString(), { headers: { authorization: `Bearer ${snapshot.runtimeAuthToken}` },
          redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return false;
        if (!response.body) return false;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "", size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 4_096) { await reader.cancel(); return false; }
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
        const state = Readiness.safeParse(JSON.parse(text));
        return state.success && state.data.available && state.data.ownerId === principalId && state.data.maximumSessionMs !== undefined;
      } catch (error: unknown) { console.warn("[native-live] readiness unavailable", error instanceof Error ? error.name : "UnknownError"); return false; }
    },
  };
}
