/** What dictation is doing in a composer that offers it. */
export type ComposerSpeechPhase = "idle" | "requesting_permission" | "recording" | "transcribing" | "error";

/**
 * Dictation into a composer's draft, as the composer draws it. A composer
 * given none has no microphone: the computer has no speech, or nobody is
 * signed in to use it.
 */
export interface ComposerSpeech {
  phase: ComposerSpeechPhase;
  /** How long the recording has run. */
  elapsedMs: number;
  /** The microphone's loudness, 0 to 1. */
  inputLevel: number;
  /** Counts loudness readings, so two equal readings in a row still move the waveform. */
  inputLevelSequence: number;
  /** Why the last dictation did not work, in words safe to show. */
  error: string | null;
  start(): void;
  /** Ends the recording and transcribes it into the draft. */
  stop(): void;
  /** Drops the recording, or the transcription on its way. */
  cancel(): void;
}

/** True while dictation holds the composer: the message waits until it is done. */
export function isComposerSpeechBusy(speech: ComposerSpeech | undefined): boolean {
  return speech?.phase === "requesting_permission" || speech?.phase === "recording" || speech?.phase === "transcribing";
}

/** "0:07", "1:42": minutes and seconds, as the web app shows them. */
export function formatSpeechElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Puts a transcript after what is already typed, as the web app does. */
export function appendTranscript(draft: string, transcript: string): string {
  const typed = draft.trimEnd();
  return typed.length > 0 ? `${typed} ${transcript}` : transcript;
}
