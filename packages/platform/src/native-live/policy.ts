import { z } from "zod/v4";

export const NATIVE_LIVE_MODEL = "gemini-3.8-live";
const Money = z.coerce.number().int().positive().max(1_000_000_000);
const PolicySchema = z.object({
  revision: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/),
  allowedHandles: z.array(z.string().regex(/^[a-z][a-z0-9-]{2,30}$/)).min(1).max(100),
  sessionBudgetMicrousd: Money,
  monthlyOwnerBudgetMicrousd: Money,
  maximumActiveSessions: z.coerce.number().int().min(1).max(100),
  maximumSessionMs: z.coerce.number().int().min(60_000).max(1_800_000),
}).refine(p => p.sessionBudgetMicrousd <= p.monthlyOwnerBudgetMicrousd);
export type NativeLivePolicy = z.output<typeof PolicySchema>;

export function loadNativeLivePolicy(env: NodeJS.ProcessEnv): NativeLivePolicy | undefined {
  if (env.MATRIX_PLATFORM_LIVE_ENABLED !== "true") return undefined;
  const parsed = PolicySchema.safeParse({
    revision: env.MATRIX_PLATFORM_LIVE_POLICY_REVISION,
    allowedHandles: env.MATRIX_PLATFORM_LIVE_ALLOWED_HANDLES?.split(",").map(s => s.trim()),
    sessionBudgetMicrousd: env.MATRIX_PLATFORM_LIVE_SESSION_BUDGET_MICROUSD ?? 2_000_000,
    monthlyOwnerBudgetMicrousd: env.MATRIX_PLATFORM_LIVE_MONTHLY_OWNER_BUDGET_MICROUSD ?? 20_000_000,
    maximumActiveSessions: env.MATRIX_PLATFORM_LIVE_MAXIMUM_ACTIVE_SESSIONS ?? 20,
    maximumSessionMs: env.MATRIX_PLATFORM_LIVE_MAXIMUM_SESSION_MS ?? 1_800_000,
  });
  return parsed.success ? parsed.data : undefined;
}

const FunctionSchema = z.object({
  name: z.enum(["delegate_task", "find_chats", "check_task", "remember"]),
  description: z.string().max(2_000).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).strip();
const SetupSchema = z.object({
  systemInstruction: z.object({ parts: z.array(z.object({ text: z.string().max(16_000) }).strict()).min(1).max(2) }).strict().optional(),
  tools: z.array(z.object({ functionDeclarations: z.array(FunctionSchema).min(1).max(4) }).strict()).max(1).default([]),
}).strip();
export function constrainNativeLiveSetup(raw: unknown) {
  if (JSON.stringify(raw).length > 64_000) throw new Error("Invalid Live setup");
  const setup = SetupSchema.parse(raw);
  return { ...setup, model: `models/${NATIVE_LIVE_MODEL}`,
    tools: setup.tools.map(block => ({ functionDeclarations: block.functionDeclarations.map(tool => ({ ...tool, behavior: "NON_BLOCKING" })) })),
    generationConfig: { responseModalities: ["AUDIO"], maxOutputTokens: 1024,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } } },
    realtimeInputConfig: { automaticActivityDetection: { disabled: false, silenceDurationMs: 1200 } },
    inputAudioTranscription: {}, outputAudioTranscription: {},
    contextWindowCompression: { triggerTokens: 8192, slidingWindow: { targetTokens: 4096 } },
  };
}

export const LiveUsageSchema = z.object({
  promptTokenCount: z.number().int().nonnegative().max(100_000_000),
  responseTokenCount: z.number().int().nonnegative().max(100_000_000),
  thoughtsTokenCount: z.number().int().nonnegative().max(100_000_000).default(0),
  toolUsePromptTokenCount: z.number().int().nonnegative().max(100_000_000).default(0),
}).strip();
/** Audio-rate upper bound, not invoice-exact settlement. Thinking/transcript
 * and repeated context are deliberately included; no customer debit occurs.
 * Pricing snapshot: Google pricing, Gemini 3.8 Live, 2026-10-05.
 */
export function usageUpperBound(raw: unknown): number {
  const usage = LiveUsageSchema.parse(raw);
  return (usage.promptTokenCount + usage.toolUsePromptTokenCount) * 3
    + (usage.responseTokenCount + usage.thoughtsTokenCount) * 12;
}
