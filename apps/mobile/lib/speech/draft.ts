const CANONICAL_CHAT_TEXT_MAX_CHARS = 32_000;
const CANONICAL_CHAT_TEXT_MAX_BYTES = 96 * 1024;

export type NativeSpeechDraftMerge =
  | { ok: true; value: string; generation: number }
  | { ok: false; reason: 'stale' | 'too_large'; value: string; generation: number };

export function mergeNativeSpeechDraft(input: {
  current: string;
  currentGeneration: number;
  recordingGeneration: number;
  transcript: string;
}): NativeSpeechDraftMerge {
  if (input.currentGeneration !== input.recordingGeneration) {
    return { ok: false, reason: 'stale', value: input.current, generation: input.currentGeneration };
  }
  const value = input.current ? `${input.current} ${input.transcript}` : input.transcript;
  if (value.length > CANONICAL_CHAT_TEXT_MAX_CHARS
    || new TextEncoder().encode(value).byteLength > CANONICAL_CHAT_TEXT_MAX_BYTES) {
    return { ok: false, reason: 'too_large', value: input.current, generation: input.currentGeneration };
  }
  return { ok: true, value, generation: input.currentGeneration + 1 };
}
