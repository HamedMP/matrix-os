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
  const [agentState, setAgentState] = useState<AgentState>(null);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [currentText, setCurrentText] = useState("");
  const animFrameRef = useRef<number>(0);

  const {
    isRecording,
    isTranscribing,
    isPlaying,
    isSupported,
    startRecording,
    stopRecording,
    playAudio,
  } = useVoice({
    onTranscription: (text) => {
      setTranscript((prev) => [...prev, `You: ${text}`]);
      setCurrentText("");
      setAgentState("thinking");
      onSubmit(text);
    },
    onError: (err) => {
      setCurrentText(`Error: ${err}`);
      setAgentState(null);
    },
  });

  useEffect(() => {
    if (isRecording) {
      setAgentState("listening");
      setCurrentText("Listening...");
    } else if (isTranscribing) {
      setAgentState("thinking");
      setCurrentText("Thinking...");
    } else if (isPlaying) {
      setAgentState("talking");
      setCurrentText("Speaking...");
    } else {
      setAgentState(null);
      if (!currentText.startsWith("Error:")) {
        setCurrentText("Tap mic to speak");
      }
    }
  }, [isRecording, isTranscribing, isPlaying]);

  const handleMicToggle = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

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
