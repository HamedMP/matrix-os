"use client";

import { useState, useCallback, type ReactNode } from "react";
import { useSocket } from "@/hooks/useSocket";
import { useVoice } from "@/hooks/useVoice";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SendIcon, MicIcon, MicOffIcon, Loader2Icon, AudioLinesIcon } from "lucide-react";
import { Attachments, AttachmentButton, useAttachments } from "@/components/ai-elements/attachments";

interface InputBarProps {
  sessionId?: string;
  busy: boolean;
  queueLength?: number;
  onSubmit: (text: string, files?: Array<{ name: string; type: string; data: string }>) => void;
  chips?: ReactNode;
  embedded?: boolean;
  onVoiceModeToggle?: () => void;
  voiceModeActive?: boolean;
}

export function InputBar({ sessionId, busy, queueLength = 0, onSubmit, chips, embedded, onVoiceModeToggle, voiceModeActive }: InputBarProps) {
  const [input, setInput] = useState("");
  const { connected } = useSocket();
  const { attachments, addFiles, removeFile, clearAll, getBase64Files } = useAttachments();

  const {
    isRecording,
    isTranscribing,
    isSupported,
    startRecording,
    stopRecording,
  } = useVoice({
    onTranscription: (text) => {
      setInput(text);
    },
    onError: (err) => {
      console.error("Voice error:", err);
    },
  });

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text && attachments.length === 0) return;

      if (attachments.length > 0) {
        const files = await getBase64Files();
        onSubmit(text || `Attached ${files.length} file(s)`, files);
        clearAll();
      } else {
        onSubmit(text);
      }
      setInput("");
    },
    [input, attachments, onSubmit, getBase64Files, clearAll],
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
      <Attachments attachments={attachments} onRemove={removeFile} />
      <form
        onSubmit={handleSubmit}
        className={
          embedded
            ? "flex w-full items-center gap-2 rounded-lg bg-muted/50 px-3 py-2"
            : "flex w-full max-w-full md:max-w-[560px] items-center gap-2 rounded-xl border border-border bg-card/90 px-3 py-2 shadow-lg backdrop-blur-sm"
        }
      >
        <AttachmentButton
          onFilesSelected={addFiles}
          disabled={!connected}
        />
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
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
          rows={1}
          className="border-0 bg-transparent shadow-none focus-visible:ring-0 text-base md:text-sm min-h-0 max-h-40 resize-none py-1"
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
        {isSupported && onVoiceModeToggle && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={`size-10 md:size-8 ${voiceModeActive ? "text-primary" : "text-muted-foreground"}`}
            disabled={!connected}
            onClick={onVoiceModeToggle}
            title={voiceModeActive ? "Exit voice mode" : "Enter voice mode"}
          >
            <AudioLinesIcon className="size-5 md:size-4" />
          </Button>
        )}
        <Button
          type="submit"
          size="icon"
          className="size-10 md:size-8"
          disabled={!connected || (!input.trim() && attachments.length === 0)}
        >
          <SendIcon className="size-5 md:size-4" />
        </Button>
      </form>
    </div>
  );
}
