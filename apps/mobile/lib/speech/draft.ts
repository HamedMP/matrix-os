const CANONICAL_CHAT_TEXT_MAX_CHARS = 32_000;
const CANONICAL_CHAT_TEXT_MAX_BYTES = 96 * 1024;

export type NativeSpeechDraftMerge =
  | { ok: true; value: string; revision: number }
  | { ok: false; reason: 'stale' | 'too_large'; value: string; revision: number };

export function mergeNativeSpeechDraft(input: {
  current: string;
  currentRevision: number;
  recordingRevision: number;
  transcript: string;
}): NativeSpeechDraftMerge {
  if (input.currentRevision !== input.recordingRevision) {
    return { ok: false, reason: 'stale', value: input.current, revision: input.currentRevision };
  }
  const value = input.current ? `${input.current} ${input.transcript}` : input.transcript;
  if (value.length > CANONICAL_CHAT_TEXT_MAX_CHARS
    || new TextEncoder().encode(value).byteLength > CANONICAL_CHAT_TEXT_MAX_BYTES) {
    return { ok: false, reason: 'too_large', value: input.current, revision: input.currentRevision };
  }
  return { ok: true, value, revision: input.currentRevision + 1 };
}
