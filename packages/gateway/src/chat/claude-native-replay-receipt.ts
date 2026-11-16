import { z } from "zod/v4";

const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_PROMPT_BYTES = 64_000;
const NativeToolUseId = z.string().max(256).regex(/^toolu_[a-zA-Z0-9_-]+$/);
export const ClaudeNativeReplayMessageId = z.string().max(256).regex(/^msg_[a-zA-Z0-9_-]+$/);
const MaxDateMs = 8_640_000_000_000_000;
export const ClaudeNativeReplayInstant = z.int().positive().max(MaxDateMs);
// Claude's native jitter can make a real fire time a fractional millisecond.
export const ClaudeNativeReplayFireAt = z.number().finite().positive().max(MaxDateMs);
export const ClaudeNativeScheduleReplaySchema = z.strictObject({
  toolUseId: NativeToolUseId,
  assistantMessageId: ClaudeNativeReplayMessageId,
  prompt: z.string().min(1).max(16_000).refine(value =>
    value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value) <= MAX_PROMPT_BYTES),
  receivedAtMs: ClaudeNativeReplayInstant,
  nextFireAtMs: ClaudeNativeReplayFireAt,
}).refine(value => value.nextFireAtMs >= value.receivedAtMs - MAX_CLOCK_SKEW_MS);

export type ClaudeNativeScheduleReplay = z.infer<typeof ClaudeNativeScheduleReplaySchema>;
