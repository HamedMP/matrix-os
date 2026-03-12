"use client";

// Inspired by AI Elements speech-input pattern, uses Web Speech API
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MicIcon, MicOffIcon, Loader2Icon } from "lucide-react";

export type SpeechState = "idle" | "listening" | "processing";

export interface UseSpeechInputOptions {
  onTranscript?: (text: string) => void;
  onInterim?: (text: string) => void;
  lang?: string;
  continuous?: boolean;
}

export interface UseSpeechInputReturn {
  state: SpeechState;
  isSupported: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionEventLike {
  results: SpeechRecognitionResultListLike;
  resultIndex: number;
}

interface SpeechRecognitionResultListLike {
  length: number;
  item: (index: number) => SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  item: (index: number) => { transcript: string };
  [index: number]: { transcript: string };
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as new () => SpeechRecognitionLike) ??
    (w.webkitSpeechRecognition as new () => SpeechRecognitionLike) ??
    null
  );
}

export function useSpeechInput(opts?: UseSpeechInputOptions): UseSpeechInputReturn {
  const [state, setState] = useState<SpeechState>("idle");
  const [isSupported, setIsSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setIsSupported(getSpeechRecognition() !== null);
  }, []);

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    setState("idle");
  }, []);

  const start = useCallback(() => {
    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor) return;

    if (recognitionRef.current) {
      recognitionRef.current.abort();
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = opts?.continuous ?? false;
    recognition.interimResults = true;
    recognition.lang = opts?.lang ?? "en-US";

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let interimTranscript = "";
      let finalTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (finalTranscript) {
        opts?.onTranscript?.(finalTranscript);
      }
      if (interimTranscript) {
        opts?.onInterim?.(interimTranscript);
      }
    };

    recognition.onerror = () => {
      setState("idle");
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      setState("idle");
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState("listening");
  }, [opts]);

  const toggle = useCallback(() => {
    if (state === "listening") {
      stop();
    } else {
      start();
    }
  }, [state, start, stop]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  return { state, isSupported, start, stop, toggle };
}

export type SpeechInputProps = {
  onTranscript?: (text: string) => void;
  onInterim?: (text: string) => void;
  disabled?: boolean;
  className?: string;
};

export function SpeechInput({
  onTranscript,
  onInterim,
  disabled,
  className,
}: SpeechInputProps) {
  const { state, isSupported, toggle } = useSpeechInput({
    onTranscript,
    onInterim,
  });

  if (!isSupported) return null;

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={cn(
        "size-10 md:size-8 relative",
        state === "listening" ? "text-red-500" : "text-muted-foreground",
        className,
      )}
      disabled={disabled}
      onClick={toggle}
      title={
        state === "listening"
          ? "Stop listening"
          : state === "processing"
            ? "Processing..."
            : "Voice input (Web Speech)"
      }
    >
      {state === "processing" ? (
        <Loader2Icon className="size-5 md:size-4 animate-spin" />
      ) : state === "listening" ? (
        <>
          <MicOffIcon className="size-5 md:size-4" />
          <span className="absolute top-1 right-1 size-2 rounded-full bg-red-500 animate-pulse" />
        </>
      ) : (
        <MicIcon className="size-5 md:size-4" />
      )}
    </Button>
  );
}
