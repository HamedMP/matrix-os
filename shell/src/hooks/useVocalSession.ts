"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";
import type { VoiceState } from "@/hooks/useOnboarding";

export type VocalIntent =
  | { kind: "create_app"; description: string }
  | { kind: "open_app"; name: string };

export interface BuildProgressSnapshot {
  description: string;
  elapsedSec: number;
  estimatedTotalSec: number;
  currentAction: string;
  stage: string;
}

export interface VocalSessionOptions {
  onExecute?: (intent: VocalIntent) => void;
  onFactSaved?: (fact: string) => void;
  onShowBuildProgress?: (snapshot: BuildProgressSnapshot) => void;
}

export interface VocalSession {
  voiceState: VoiceState;
  subtitle: string;
  error: string | null;
  connected: boolean;
  notifyDelegationComplete: (info: {
    kind: "create_app";
    description: string;
    success: boolean;
    newAppName?: string;
    errorMessage?: string;
  }) => void;
  notifyExecuteResult: (result: {
    kind: "open_app";
    name: string;
    success: boolean;
    resolvedName?: string;
  }) => void;
  pushDelegationStatus: (snapshot: {
    description: string;
    stage: "pending" | "running" | "done";
    elapsedSec: number;
    currentAction: string;
  }) => void;
}

// Wire protocol mirror of gateway's VocalOutbound. Kept in sync manually —
// the two packages don't share types, and duplicating 10 lines beats
// extracting a shared types package for this alone.
type VocalWireMessage =
  | { type: "ready" }
  | { type: "audio"; data: string }
  | { type: "transcript"; speaker: "ai" | "user"; text: string }
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | { type: "execute"; kind: "create_app"; description: string }
  | { type: "execute"; kind: "open_app"; name: string }
  | { type: "fact_saved"; fact: string }
  | { type: "show_build_progress"; description: string; elapsedSec: number; estimatedTotalSec: number; currentAction: string; stage: string }
  | { type: "error"; message: string; retryable: boolean };

export function useVocalSession(enabled: boolean, options: VocalSessionOptions = {}): VocalSession {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [subtitle, setSubtitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Writing during render trips react-hooks/refs, so sync in an effect.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const wsRef = useRef<WebSocket | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef(0);
  const playGainRef = useRef<GainNode | null>(null);
  const isPlayingRef = useRef(false);

  // Tracks whether the current session is still mounted. `startMic` awaits
  // `getUserMedia` and `audioWorklet.addModule`, which can resolve AFTER the
  // user exits vocal mode — without this flag the stream + worklet would
  // get wired up post-unmount and the mic tracks would stay live with no
  // teardown (privacy-adjacent leak).
  const mountedRef = useRef(false);

  const wordQueueRef = useRef<string[]>([]);
  const revealIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const WORD_REVEAL_MS = 300;

  const startWordReveal = useCallback(() => {
    if (revealIntervalRef.current) return;
    revealIntervalRef.current = setInterval(() => {
      const word = wordQueueRef.current.shift();
      if (word) {
        setSubtitle((prev) => {
          const next = (prev ? prev + " " : "") + word;
          const sentences = next.split(/(?<=[.!?])\s+/);
          return sentences.length > 3 ? sentences.slice(-2).join(" ") : next;
        });
      } else {
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
    setSubtitle("");
  }, []);

  const playAudio = useCallback((base64: string) => {
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext();
      const g = playCtxRef.current.createGain();
      g.gain.value = 1.0;
      // Feed through a DynamicsCompressor so loud TTS chunks stay within
      // [-1, 1] instead of clipping. Threshold / ratio tuned for speech.
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

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
    }
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);
    const startAt = Math.max(ctx.currentTime, nextStartTimeRef.current);
    source.start(startAt);
    nextStartTimeRef.current = startAt + buffer.duration;

    if (!isPlayingRef.current) {
      isPlayingRef.current = true;
      setVoiceState("speaking");
    }
    source.onended = () => {
      if (ctx.currentTime >= nextStartTimeRef.current - 0.05) {
        isPlayingRef.current = false;
        setVoiceState("listening");
      }
    };
  }, []);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const startMic = useCallback(async () => {
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // Bail if the session was torn down while the permission prompt was
      // open — don't leak the freshly-granted MediaStream.
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      ctx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = ctx;

      await ctx.audioWorklet.addModule("/audio-worklet-processor.js");
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch((err: unknown) => {
          console.warn("[vocal] failed to close abandoned mic context:", err instanceof Error ? err.message : String(err));
        });
        streamRef.current = null;
        micCtxRef.current = null;
        return;
      }
      const worklet = new AudioWorkletNode(ctx, "pcm16-processor");
      workletNodeRef.current = worklet;

      worklet.port.onmessage = (e) => {
        if (e.data.type === "audio" && e.data.bytes) {
          const bytes = new Uint8Array(e.data.bytes);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          send({ type: "audio", data: btoa(binary) });
        }
      };

      const source = ctx.createMediaStreamSource(stream);
      source.connect(worklet);
      setVoiceState("listening");
    } catch (err) {
      // Stop any stream/context we partially acquired before the error.
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch((closeErr: unknown) => {
        console.warn("[vocal] failed to close mic context after init error:", closeErr instanceof Error ? closeErr.message : String(closeErr));
      });
      streamRef.current = null;
      micCtxRef.current = null;
      if (mountedRef.current) {
        console.warn("[vocal] mic init failed:", err instanceof Error ? err.message : String(err));
        setError("Microphone access denied");
      }
      throw err;
    }
  }, [send]);

  const stopMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    micCtxRef.current?.close().catch((err: unknown) => {
      console.warn("[vocal] failed to close mic context:", err instanceof Error ? err.message : String(err));
    });
    micCtxRef.current = null;
  }, []);

  const handleMessage = useCallback((evt: MessageEvent) => {
    let msg: VocalWireMessage;
    try {
      msg = JSON.parse(typeof evt.data === "string" ? evt.data : "") as VocalWireMessage;
    } catch (err) {
      console.warn("[vocal] inbound JSON parse failed:", err instanceof Error ? err.message : String(err));
      return;
    }
    switch (msg.type) {
      case "ready":
        setVoiceState("listening");
        break;
      case "audio":
        playAudio(msg.data);
        break;
      case "transcript":
        if (msg.speaker === "ai") enqueueWords(msg.text);
        else clearWordReveal();
        break;
      case "interrupted":
        isPlayingRef.current = false;
        nextStartTimeRef.current = 0;
        playCtxRef.current?.close().catch((err: unknown) => {
          console.warn("[vocal] failed to close playback context after interruption:", err instanceof Error ? err.message : String(err));
        });
        playCtxRef.current = null;
        playGainRef.current = null;
        setVoiceState("listening");
        clearWordReveal();
        break;
      case "turn_complete":
        if (!isPlayingRef.current) setVoiceState("listening");
        break;
      case "execute":
        if (msg.kind === "create_app") {
          optionsRef.current.onExecute?.({ kind: "create_app", description: msg.description });
        } else if (msg.kind === "open_app") {
          optionsRef.current.onExecute?.({ kind: "open_app", name: msg.name });
        }
        break;
      case "fact_saved":
        if (msg.fact) optionsRef.current.onFactSaved?.(msg.fact);
        break;
      case "show_build_progress":
        optionsRef.current.onShowBuildProgress?.({
          description: msg.description,
          elapsedSec: msg.elapsedSec,
          estimatedTotalSec: msg.estimatedTotalSec,
          currentAction: msg.currentAction,
          stage: msg.stage,
        });
        break;
      case "error":
        setError(msg.message);
        break;
    }
  }, [playAudio, enqueueWords, clearWordReveal]);

  useEffect(() => {
    if (!enabled) return;

    mountedRef.current = true;
    let ws: WebSocket | null = null;

    void buildAuthenticatedWebSocketUrl("/ws/vocal")
      .then((wsUrl) => {
        if (!mountedRef.current) return;
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!mountedRef.current) return;
          setConnected(true);
          void startMic()
            .then(() => {
              if (mountedRef.current && ws?.readyState === WebSocket.OPEN) {
                send({ type: "start", audioFormat: "pcm16" });
              }
            })
            .catch((err: unknown) => {
              console.warn("[vocal] failed to start microphone:", err instanceof Error ? err.message : String(err));
              ws?.close();
            });
        };
        ws.onmessage = handleMessage;
        ws.onerror = () => setError("Connection failed");
        ws.onclose = () => {
          setConnected(false);
          wsRef.current = null;
        };
      })
      .catch((err: unknown) => {
        console.warn("[vocal] failed to build authenticated WS url:", err instanceof Error ? err.message : String(err));
        setError("Connection failed");
      });

    return () => {
      mountedRef.current = false;
      ws?.close();
      stopMic();
      playCtxRef.current?.close().catch((err: unknown) => {
        console.warn("[vocal] failed to close playback context:", err instanceof Error ? err.message : String(err));
      });
      playCtxRef.current = null;
      playGainRef.current = null;
      if (revealIntervalRef.current) {
        clearInterval(revealIntervalRef.current);
        revealIntervalRef.current = null;
      }
      wordQueueRef.current = [];
      setSubtitle("");
      setVoiceState("idle");
      setConnected(false);
    };
  }, [enabled, handleMessage, send, startMic, stopMic]);

  const notifyDelegationComplete = useCallback(
    (info: { kind: "create_app"; description: string; success: boolean; newAppName?: string; errorMessage?: string }) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(
        JSON.stringify({
          type: "delegation_complete",
          kind: info.kind,
          description: info.description,
          success: info.success,
          newAppName: info.newAppName,
          errorMessage: info.errorMessage,
        }),
      );
    },
    [],
  );

  const notifyExecuteResult = useCallback(
    (result: { kind: "open_app"; name: string; success: boolean; resolvedName?: string }) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(
        JSON.stringify({
          type: "execute_result",
          kind: result.kind,
          name: result.name,
          success: result.success,
          resolvedName: result.resolvedName,
        }),
      );
    },
    [],
  );

  const pushDelegationStatus = useCallback(
    (snapshot: {
      description: string;
      stage: "pending" | "running" | "done";
      elapsedSec: number;
      currentAction: string;
    }) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(
        JSON.stringify({
          type: "delegation_status",
          description: snapshot.description,
          stage: snapshot.stage,
          elapsedSec: snapshot.elapsedSec,
          currentAction: snapshot.currentAction,
        }),
      );
    },
    [],
  );

  return {
    voiceState,
    subtitle,
    error,
    connected,
    notifyDelegationComplete,
    notifyExecuteResult,
    pushDelegationStatus,
  };
}
