import { z } from "zod/v4";
import { SpeechSafeErrorResponseSchema } from "#speech";

export const SPEECH_SYNTHESIS_STREAM_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const SPEECH_SYNTHESIS_STREAM_MAX_CHUNK_BYTES = 65_536;
export const SPEECH_SYNTHESIS_STREAM_MAX_LINE_BYTES = 96 * 1024;
// Derive, rather than duplicate, the existing safe error vocabulary.
export const SpeechSafeErrorCodeSchema = z.union(
  SpeechSafeErrorResponseSchema.shape.error.options.map((option) => option.shape.code),
);
const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PcmDataSchema = z.string().min(4).max(Math.ceil(65_536 / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((data) => {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const bytes = data.length / 4 * 3 - padding;
    if (bytes < 2 || bytes > 65_536 || bytes % 2 !== 0) return false;
    // Padding bits must be zero (canonical base64); no Buffer dependency in contracts.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    return padding === 0 || (alphabet.indexOf(data[data.length - padding - 1]!) & (padding === 2 ? 15 : 3)) === 0;
  }, "Invalid PCM chunk");

export const SpeechSynthesisStreamFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("audio"), sequence: SequenceSchema, data: PcmDataSchema }).strict(),
  z.object({ type: z.literal("end"), sequence: SequenceSchema, format: z.literal("pcm_s16le_24000_mono"), durationMs: z.number().int().nonnegative().max(600_000) }).strict(),
  z.object({ type: z.literal("error"), sequence: SequenceSchema, code: SpeechSafeErrorCodeSchema }).strict(),
]);
export type SpeechSynthesisStreamFrame = z.infer<typeof SpeechSynthesisStreamFrameSchema>;
