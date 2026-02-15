"use client";

import { useState, useCallback, type ReactNode } from "react";
import { useSocket } from "@/hooks/useSocket";
import { useVoice } from "@/hooks/useVoice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SendIcon, MicIcon, MicOffIcon, Loader2Icon } from "lucide-react";

interface InputBarProps {
  sessionId?: string;
  busy: boolean;
  queueLength?: number;
  onSubmit: (text: string) => void;
  chips?: ReactNode;
}

export function InputBar({ sessionId, busy, queueLength = 0, onSubmit, chips }: InputBarProps) {
  const [input, setInput] = useState("");
  const { connected } = useSocket();

  const {
    isRecording,
    isTranscribing,
    isSupported,
    startRecording,
    stopRecording,
  } = useVoice({
    onTranscription: (text) => {
      onSubmit(text);
    },
    onError: (err) => {
      console.error("Voice error:", err);
    },
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text) return;
      onSubmit(text);
      setInput("");
    },
    [input, onSubmit],
  );

  const handleMicClick = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-2">
      {chips}
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-full md:max-w-[560px] items-center gap-2 rounded-xl border border-border bg-card/90 px-3 py-2 shadow-lg backdrop-blur-sm"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            isTranscribing
              ? "Transcribing..."
              : isRecording
                ? "Listening..."
                : connected
                  ? "Ask Matrix OS..."
                  : "Connecting..."
          }
          disabled={!connected || isRecording}
          className="border-0 bg-transparent shadow-none focus-visible:ring-0 text-base md:text-sm"
        />
        {queueLength > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {queueLength} queued
          </span>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={`size-10 md:size-8 ${
            isRecording
              ? "text-red-500 animate-pulse"
              : "text-muted-foreground"
          }`}
          disabled={!connected || !isSupported || isTranscribing}
          onClick={handleMicClick}
          title={
            !isSupported
              ? "Voice input not supported in this browser"
              : isRecording
                ? "Stop recording"
                : isTranscribing
                  ? "Transcribing..."
                  : "Voice input"
          }
        >
          {isTranscribing ? (
            <Loader2Icon className="size-5 md:size-4 animate-spin" />
          ) : isRecording ? (
            <MicOffIcon className="size-5 md:size-4" />
          ) : (
            <MicIcon className="size-5 md:size-4" />
          )}
        </Button>
        <Button
          type="submit"
          size="icon"
          className="size-10 md:size-8"
          disabled={!connected || !input.trim()}
        >
          <SendIcon className="size-5 md:size-4" />
        </Button>
      </form>
    </div>
  );
}
