"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";

export type OnboardingStage =
  | "connecting"
  | "greeting"
  | "interview"
  | "extract_profile"
  | "suggest_apps"
  | "api_key"
  | "done";

export type VoiceState = "idle" | "listening" | "speaking" | "thinking";

interface Transcript {
  speaker: "ai" | "user";
  text: string;
}

interface SuggestedApp {
  name: string;
  description: string;
}

export type ContentDisplay =
  | { kind: "app_suggestions"; apps: { name: string; description: string }[] }
  | { kind: "desktop_mockup"; highlights: string[] }
  | { kind: "profile_info"; fields: { name?: string; role?: string; interests?: string[] } }
  | null;

export interface OnboardingHook {
  stage: OnboardingStage;
  voiceState: VoiceState;
  transcripts: Transcript[];
  suggestedApps: SuggestedApp[];
  error: string | null;
  isVoiceMode: boolean;
  alreadyComplete: boolean;
  apiKeyResult: { valid: boolean; error?: string } | null;
  currentSubtitle: string;
  contextualContent: ContentDisplay;
  start: (useVoice: boolean) => void;
  sendText: (text: string) => void;
  sendApiKey: (key: string) => void;
  confirmApps: (apps: string[]) => void;
  chooseClaudeCode: () => void;
  finishInterview: () => void;
}

export function useOnboarding(): OnboardingHook {
  const [stage, setStage] = useState<OnboardingStage>("connecting");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [suggestedApps, setSuggestedApps] = useState<SuggestedApp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [alreadyComplete, setAlreadyComplete] = useState(false);
  const [apiKeyResult, setApiKeyResult] = useState<{ valid: boolean; error?: string } | null>(null);
  const [currentSubtitle, setCurrentSubtitle] = useState("");
  const [contextualContent, setContextualContent] = useState<ContentDisplay>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isPlayingRef = useRef(false);
  const nextStartTimeRef = useRef(0);
  const playGainRef = useRef<GainNode | null>(null);

  // Word-by-word subtitle reveal queue
  const wordQueueRef = useRef<string[]>([]);
  const revealIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ~3.3 words/sec matches Aoede's speaking cadence at normal pace
  const WORD_REVEAL_MS = 300;

  // Play PCM16 audio (24kHz, mono, s16le) from base64
  // Immediately decodes and schedules each chunk on the Web Audio timeline —
  // no queue, no awaiting. The browser's audio thread handles gapless playback.
  const playAudio = useCallback((base64: string) => {
    // Lazy-init playback context at system default rate (typically 48kHz)
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext();
      const g = playCtxRef.current.createGain();
      g.gain.value = 1.0;
      // DynamicsCompressor keeps loud TTS chunks from clipping past [-1, 1]
      // while still feeling present at unity gain.
      const compressor = playCtxRef.current.createDynamicsCompressor();
      compressor.threshold.value = -6;
      compressor.knee.value = 10;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.1;
      g.connect(compressor);
      compressor.connect(playCtxRef.current.destination);
      playGainRef.current = g;
      nextStartTimeRef.current = 0;
    }
    const ctx = playCtxRef.current;
    const gainNode = playGainRef.current!;

    // Decode PCM16 → Float32
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
    }

    // Create buffer at source rate (24kHz) — Web Audio upsamples to output rate
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);

    // Schedule exactly back-to-back — chunks are continuous PCM, no gap needed
    const startAt = Math.max(ctx.currentTime, nextStartTimeRef.current);
    source.start(startAt);
    nextStartTimeRef.current = startAt + buffer.duration;

    // Track speaking state
    if (!isPlayingRef.current) {
      isPlayingRef.current = true;
      setVoiceState("speaking");
    }

    // When this chunk ends, check if it was the last scheduled one
    source.onended = () => {
      if (ctx.currentTime >= nextStartTimeRef.current - 0.05) {
        isPlayingRef.current = false;
        setVoiceState("listening");
      }
    };
  }, []);

  // Word-by-word reveal: pull one word at a time from the queue
  const startWordReveal = useCallback(() => {
    if (revealIntervalRef.current) return; // already running
    revealIntervalRef.current = setInterval(() => {
      const word = wordQueueRef.current.shift();
      if (word) {
        setCurrentSubtitle((prev) => {
          const next = (prev ? prev + " " : "") + word;
          // Trim to last 2 sentences if overflow
          const sentences = next.split(/(?<=[.!?])\s+/);
          return sentences.length > 3 ? sentences.slice(-2).join(" ") : next;
        });
      } else {
        // Queue drained — pause interval until more words arrive
        clearInterval(revealIntervalRef.current!);
        revealIntervalRef.current = null;
      }
    }, WORD_REVEAL_MS);
  }, []);

  const enqueueWords = useCallback((text: string) => {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    wordQueueRef.current.push(...words);
    startWordReveal();
  }, [startWordReveal]);

  const clearWordReveal = useCallback(() => {
    wordQueueRef.current = [];
    if (revealIntervalRef.current) {
      clearInterval(revealIntervalRef.current);
      revealIntervalRef.current = null;
    }
    setCurrentSubtitle("");
  }, []);

  // Send JSON message to gateway
  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Start mic capture via AudioWorklet
  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = ctx;

      await ctx.audioWorklet.addModule("/audio-worklet-processor.js");
      const worklet = new AudioWorkletNode(ctx, "pcm16-processor");
      workletNodeRef.current = worklet;

      worklet.port.onmessage = (e) => {
        if (e.data.type === "audio" && e.data.bytes) {
          // Convert ArrayBuffer to base64 in main thread (btoa unavailable in worklet)
          const bytes = new Uint8Array(e.data.bytes);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          send({ type: "audio", data: btoa(binary) });
        }
      };

      const source = ctx.createMediaStreamSource(stream);
      source.connect(worklet);
      setVoiceState("listening");
    } catch {
      // Mic denied — fall back to text mode
      setIsVoiceMode(false);
      send({ type: "start", audioFormat: "text" });
    }
  }, [send]);

  // Handle incoming WebSocket messages
  const handleMessage = useCallback((evt: MessageEvent) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "stage":
        setStage(msg.stage as OnboardingStage);
        if (msg.apps) setSuggestedApps(msg.apps as SuggestedApp[]);
        if (msg.audioSource === "gemini_live") setVoiceState("listening");
        break;
      case "audio":
        playAudio(msg.data as string);
        break;
      case "transcript": {
        const speaker = msg.speaker as "ai" | "user";
        const text = msg.text as string;
        setTranscripts((prev) => [...prev, { speaker, text }]);

        if (speaker === "ai") {
          // Queue words for gradual reveal synced to voice pace
          enqueueWords(text);
        } else {
          // User is speaking — clear AI subtitle
          clearWordReveal();
        }
        break;
      }
      case "interrupted":
        // User started speaking — kill all scheduled audio instantly
        isPlayingRef.current = false;
        nextStartTimeRef.current = 0;
        if (playCtxRef.current) {
          playCtxRef.current.close();
          playCtxRef.current = null;
          playGainRef.current = null;
        }
        setVoiceState("listening");
        clearWordReveal();
        break;
      case "turn_complete":
        // AI finished speaking — keep subtitle visible until next interaction
        break;
      case "contextual_content": {
        const content = msg.content as NonNullable<ContentDisplay>;
        if (content.kind === "profile_info") {
          // Merge profile fields incrementally
          setContextualContent((prev) => {
            if (prev?.kind === "profile_info") {
              return {
                kind: "profile_info",
                fields: {
                  name: content.fields.name ?? prev.fields.name,
                  role: content.fields.role ?? prev.fields.role,
                  interests: [...new Set([...(prev.fields.interests ?? []), ...(content.fields.interests ?? [])])],
                },
              };
            }
            return content;
          });
        } else {
          setContextualContent(content);
        }
        break;
      }
      case "mode_change":
        setIsVoiceMode(msg.mode === "voice");
        if (msg.mode === "text") setVoiceState("idle");
        break;
      case "api_key_result":
        setApiKeyResult({ valid: msg.valid as boolean, error: msg.error as string | undefined });
        break;
      case "onboarding_already_complete":
        setAlreadyComplete(true);
        break;
      case "error":
        setError(msg.message as string);
        break;
    }
  }, [playAudio]);

  // Connect WebSocket — bypass Next.js proxy (can't handle WS upgrades)
  const connect = useCallback(() => {
    const gatewayUrl = getGatewayUrl();
    // In dev, getGatewayUrl returns the shell origin (localhost:3000).
    // WebSocket must go directly to the gateway. Use getGatewayWs() pattern
    // or fall back to port 4000 for local dev.
    const isLocalDev = typeof window !== "undefined" && window.location.hostname === "localhost";
    const wsBase = isLocalDev
      ? `ws://localhost:4000`
      : gatewayUrl.replace(/^http/, "ws");
    const wsUrl = `${wsBase}/ws/onboarding`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setStage("connecting");
    ws.onmessage = handleMessage;
    ws.onerror = () => setError("Connection failed");
    ws.onclose = () => {
      wsRef.current = null;
    };
  }, [handleMessage]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      micCtxRef.current?.close();
      playCtxRef.current?.close();
      if (revealIntervalRef.current) clearInterval(revealIntervalRef.current);
    };
  }, []);

  // Public API
  const start = useCallback((useVoice: boolean) => {
    connect();
    setIsVoiceMode(useVoice);

    // Wait for WS open, then send start message
    const checkOpen = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        clearInterval(checkOpen);
        send({ type: "start", audioFormat: useVoice ? "pcm16" : "text" });
        if (useVoice) startMic();
      }
    }, 50);
    // Clear after 5s if never opens
    setTimeout(() => clearInterval(checkOpen), 5000);
  }, [connect, send, startMic]);

  const sendText = useCallback((text: string) => {
    send({ type: "text_input", text });
  }, [send]);

  const sendApiKey = useCallback((key: string) => {
    setApiKeyResult(null);
    send({ type: "set_api_key", apiKey: key });
  }, [send]);

  const confirmApps = useCallback((apps: string[]) => {
    send({ type: "confirm_apps", apps });
  }, [send]);

  const chooseClaudeCode = useCallback(() => {
    send({ type: "choose_activation", path: "claude_code" });
  }, [send]);

  const finishInterview = useCallback(() => {
    send({ type: "confirm_apps", apps: [] });
  }, [send]);

  return {
    stage,
    voiceState,
    transcripts,
    suggestedApps,
    error,
    isVoiceMode,
    alreadyComplete,
    apiKeyResult,
    currentSubtitle,
    contextualContent,
    start,
    sendText,
    sendApiKey,
    confirmApps,
    chooseClaudeCode,
    finishInterview,
  };
}
