import { z } from "zod/v4";

const SpeechCapabilitySchema = z.enum(["speech:transcribe", "speech:synthesize"]);

const SpeechMonthlyAuthorizationSchema = z.object({
  capability: SpeechCapabilitySchema,
  fundingPolicy: z.literal("speech_monthly_v1"),
}).passthrough();

export function speechReservationCapability(value: string): z.output<typeof SpeechCapabilitySchema> | undefined {
  try {
    return SpeechCapabilitySchema.safeParse(JSON.parse(value)?.capability).data;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export function isSpeechMonthlyAuthorization(value: string): boolean {
  try {
    return SpeechMonthlyAuthorizationSchema.safeParse(JSON.parse(value)).success;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return false;
  }
}
