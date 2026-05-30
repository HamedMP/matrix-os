"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Orb, type AgentState } from "@/components/ui/orb";
import { useVoice } from "@/hooks/useVoice";
import { Button } from "@/components/ui/button";
import { XIcon, MicIcon, MicOffIcon } from "lucide-react";

interface VoiceModeProps {
  onClose: () => void;
  onSubmit: (text: string) => void;
}

export function VoiceMode({ onClose, onSubmit }: VoiceModeProps) {
  const [transcript, setTranscript] = useState<string[]>([]);
  // The last recorder error, if any. Sticky: it stays on the subtitle line
  // through the idle phase and is only cleared when the user starts a new
  // recording. Kept as state (read in render) rather than synced via an
  // effect so the orb/subtitle derive purely from the recorder phase.
  const [errorText, setErrorText] = useState<string | null>(null);
  const animFrameRef = useRef<number>(0);

  const {
    isRecording,
    isTranscribing,
    isPlaying,
    isSupported,
    startRecording,
    stopRecording,
  } = useVoice({
    onTranscription: (text) => {
      setTranscript((prev) => [...prev, `You: ${text}`]);
      onSubmit(text);
    },
    onError: (err) => {
      setErrorText(`Error: ${err}`);
    },
  });

  // The orb state and subtitle are a pure function of the recorder phase
  // (plus the sticky error), so they are derived during render instead of
  // mirrored into state via an effect. Recording > transcribing > playing >
  // error > idle, matching the prior effect's priority order.
  const agentState: AgentState = isRecording
    ? "listening"
    : isTranscribing
      ? "thinking"
      : isPlaying
        ? "talking"
        : null;
  const currentText = isRecording
    ? "Listening..."
    : isTranscribing
      ? "Thinking..."
      : isPlaying
        ? "Speaking..."
        : (errorText ?? "Tap mic to speak");

  const handleMicToggle = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      // Clear any prior error the moment the user starts a new recording —
      // the phase derivation will then show "Listening...".
      setErrorText(null);
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only cleanup must cancel whatever frame is pending at teardown, so it must read .current at cleanup time; snapshotting at mount would always capture the initial 0 and never cancel.
  useEffect(() => {
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-md">
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-4 right-4 size-10"
        onClick={onClose}
      >
        <XIcon className="size-5" />
      </Button>

      <div className="flex flex-col items-center gap-8 w-full max-w-md px-4">
        <div className="h-48 w-48 rounded-full overflow-hidden">
          <Orb
            colors={["#c2703a", "#ece5f0"]}
            agentState={agentState}
            volumeMode="manual"
            manualInput={isRecording ? 0.5 : 0}
            manualOutput={isPlaying ? 0.7 : 0}
            seed={42}
          />
        </div>

        <p className="text-sm text-muted-foreground text-center min-h-[1.5rem]">
          {currentText}
        </p>

        <div className="w-full max-h-48 overflow-y-auto rounded-lg bg-muted/30 p-3 space-y-1">
          {transcript.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center">
              Start speaking to begin a conversation
            </p>
          ) : (
            transcript.slice(-6).map((line, i) => (
              <p key={i} className="text-sm">
                {line}
              </p>
            ))
          )}
        </div>

        <Button
          size="lg"
          variant={isRecording ? "destructive" : "default"}
          className="rounded-full size-16"
          onClick={handleMicToggle}
          disabled={!isSupported || isTranscribing}
        >
          {isRecording ? (
            <MicOffIcon className="size-6" />
          ) : (
            <MicIcon className="size-6" />
          )}
        </Button>
      </div>
    </div>
  );
}
