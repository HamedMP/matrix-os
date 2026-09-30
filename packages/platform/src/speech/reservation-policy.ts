import { z } from "zod/v4";

const SpeechMonthlyAuthorizationSchema = z.object({
  capability: z.literal("speech:transcribe"),
  fundingPolicy: z.literal("speech_monthly_v1"),
}).passthrough();

export function isSpeechMonthlyAuthorization(value: string): boolean {
  try {
    return SpeechMonthlyAuthorizationSchema.safeParse(JSON.parse(value)).success;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return false;
  }
}
