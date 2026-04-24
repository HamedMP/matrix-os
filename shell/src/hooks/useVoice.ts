"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { getGatewayWs } from "../lib/gateway";
import { buildAuthenticatedWebSocketUrl } from "../lib/websocket-auth";

interface UseVoiceOptions {
  wsUrl?: string;
  onTranscription?: (text: string) => void;
  onError?: (error: string) => void;
}

interface UseVoiceReturn {
  isRecording: boolean;
  isTranscribing: boolean;
  isPlaying: boolean;
  isSupported: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  playAudio: (audioData: ArrayBuffer) => void;
}

export function useVoice(opts?: UseVoiceOptions): UseVoiceReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    setIsSupported(
      typeof navigator.mediaDevices?.getUserMedia === "function" && typeof window.MediaRecorder === "function"
    );
  }, []);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const getWsUrl = useCallback(async () => {
    if (opts?.wsUrl) return opts.wsUrl;
    return buildAuthenticatedWebSocketUrl("/ws/voice")
      .catch((err: unknown) => {
        console.warn(
          "[useVoice] Falling back to unauthenticated voice websocket URL:",
          err instanceof Error ? err.message : err,
        );
        return getGatewayWs().replace(/\/ws$/, "/ws/voice");
      });
  }, [opts?.wsUrl]);

  const connectWs = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;

    const ws = new WebSocket(await getWsUrl());
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "voice_transcription" && opts?.onTranscription) {
            setIsTranscribing(false);
            opts.onTranscription(msg.text);
          }
          if (msg.type === "voice_audio" && msg.audio) {
            try {
              const binary = atob(msg.audio);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              playAudio(bytes.buffer);
            } catch (_err: unknown) { /* decode error */ }
          }
          if (msg.type === "voice_error") {
            setIsTranscribing(false);
            opts?.onError?.(msg.message);
          }
        } catch (_err: unknown) {
          console.warn(
            "[useVoice] malformed ws message:",
            _err instanceof Error ? _err.message : _err,
          );
        }
      } else if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => playAudio(buffer));
      }
    };

    ws.onerror = () => {
      opts?.onError?.("Voice WebSocket connection failed");
    };

    return ws;
  }, [getWsUrl, opts]);

  const startRecording = useCallback(async () => {
    if (!isSupported) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });

      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });

        setIsTranscribing(true);

        void connectWs().then((ws) => {
          const sendAudio = () => {
            ws.send(JSON.stringify({ type: "audio_start" }));
            blob.arrayBuffer().then((buffer) => {
              ws.send(buffer);
              ws.send(JSON.stringify({ type: "audio_end" }));
            });
          };

          if (ws.readyState === WebSocket.OPEN) {
            sendAudio();
          } else {
            ws.addEventListener("open", sendAudio, { once: true });
          }
        }).catch((err: unknown) => {
          console.warn("[voice] websocket connection failed:", err instanceof Error ? err.message : String(err));
          setIsTranscribing(false);
          opts?.onError?.("Voice WebSocket connection failed");
        });
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
    } catch (e) {
      opts?.onError?.(`Microphone access denied: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [isSupported, connectWs, opts]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  const playAudio = useCallback((audioData: ArrayBuffer) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    const ctx = audioContextRef.current;
    setIsPlaying(true);

    ctx.decodeAudioData(audioData.slice(0)).then((buffer) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => setIsPlaying(false);
      source.start();
    }).catch((err: unknown) => {
      console.warn("[voice] audio decode failed:", err instanceof Error ? err.message : String(err));
      setIsPlaying(false);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch((_err: unknown) => {
          console.warn(
            "[useVoice] AudioContext close failed:",
            _err instanceof Error ? _err.message : _err,
          );
        });
        audioContextRef.current = null;
      }
    };
  }, []);

  return {
    isRecording,
    isTranscribing,
    isPlaying,
    isSupported,
    startRecording,
    stopRecording,
    playAudio,
  };
}
