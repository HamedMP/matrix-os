import { CancelCircleIcon, CircleStop, LoaderIcon, MicIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

import { SpeechInputWaveform } from "./SpeechInputWaveform.js";
import type { usePlatformSpeechDraft } from "./use-platform-speech-draft.js";

type SpeechDraft = Pick<ReturnType<typeof usePlatformSpeechDraft>,
  "phase" | "error" | "isSupported" | "elapsedMs" | "inputLevel" | "inputLevelSequence" | "start" | "stop" | "cancel">;

// What the mic button says and shows in each speech phase; other phases start recording.
const ACTIVE_PHASES: Partial<Record<SpeechDraft["phase"], { label: string; icon: IconSvgElement; spin?: boolean }>> = {
  requesting_permission: { label: "Cancel microphone request", icon: LoaderIcon, spin: true },
  recording: { label: "Stop recording", icon: CircleStop },
  transcribing: { label: "Cancel transcription", icon: CancelCircleIcon },
};
const IDLE = { label: "Start voice input", icon: MicIcon, spin: false };

/**
 * Composer mic control shared by Web and Electron Desktop Chat: the waveform
 * and timer while recording, an error bubble, and one button that starts,
 * stops, or cancels the host's speech draft.
 */
export function ChatSpeechInputButton({ speech, disabled }: { speech: SpeechDraft; disabled: boolean }) {
  const phase = ACTIVE_PHASES[speech.phase];
  const active = phase !== undefined;
  if (!speech.isSupported && !active && !speech.error) return null;
  const { label, icon, spin } = phase ?? IDLE;
  const activate = () => {
    if (speech.phase === "recording") speech.stop();
    else if (active) speech.cancel();
    else void speech.start();
  };
  return (
    <div className="relative flex items-center gap-1">
      {speech.error ? (
        <span
          role="alert"
          className="absolute bottom-[calc(100%+0.5rem)] right-0 w-max max-w-64 rounded-lg border px-2.5 py-1.5 text-xs shadow-lg"
          style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)", color: "var(--danger)" }}
        >
          {speech.error}
        </span>
      ) : null}
      {speech.phase === "recording" ? (
        <>
          <SpeechInputWaveform
            level={speech.inputLevel}
            sampleSequence={speech.inputLevelSequence}
            className="mx-1 text-[var(--danger)]"
          />
          <span aria-live="polite" className="px-1 text-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            {Math.floor(speech.elapsedMs / 60_000)}:{String(Math.floor(speech.elapsedMs / 1_000) % 60).padStart(2, "0")}
          </span>
        </>
      ) : null}
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled && !active}
        onClick={activate}
        className="flex h-9 w-9 items-center justify-center rounded-full outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--accent))] disabled:opacity-40"
        style={{ color: speech.phase === "recording" ? "var(--danger)" : "var(--text-secondary)" }}
      >
        <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} aria-hidden className={spin ? "animate-spin motion-reduce:animate-none" : undefined} />
      </button>
    </div>
  );
}
