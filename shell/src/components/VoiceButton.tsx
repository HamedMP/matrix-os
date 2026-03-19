"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { MicIcon, MicOffIcon, Loader2Icon } from "lucide-react";

interface VoiceButtonProps {
  isRecording: boolean;
  isProcessing?: boolean;
  isSupported?: boolean;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function VoiceButton({
  isRecording,
  isProcessing = false,
  isSupported = true,
  disabled = false,
  onStart,
  onStop,
}: VoiceButtonProps) {
  const handleClick = useCallback(() => {
    if (isRecording) {
      onStop();
    } else {
      onStart();
    }
  }, [isRecording, onStart, onStop]);

  const title = !isSupported
    ? "Voice input not supported in this browser"
    : isRecording
      ? "Stop recording"
      : isProcessing
        ? "Transcribing..."
        : "Voice input";

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={`size-10 md:size-8 ${
        isRecording
          ? "text-red-500 animate-pulse"
          : "text-muted-foreground"
      }`}
      disabled={disabled || !isSupported || isProcessing}
      onClick={handleClick}
      title={title}
    >
      {isProcessing ? (
        <Loader2Icon className="size-5 md:size-4 animate-spin" />
      ) : isRecording ? (
        <MicOffIcon className="size-5 md:size-4" />
      ) : (
        <MicIcon className="size-5 md:size-4" />
      )}
    </Button>
  );
}
