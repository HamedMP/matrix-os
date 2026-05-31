"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { getGatewayWs } from "../lib/gateway";
import { buildAuthenticatedWebSocketUrl } from "../lib/websocket-auth";
import { useIsClient } from "@/hooks/useIsClient";

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

  // Client-only feature detection without a mount-effect flicker: useIsClient()
  // returns false during SSR/hydration (matching the server render of isSupported=false)
  // and true on the client, where the browser globals exist. Deriving isSupported in
  // render keeps the SSR/hydration output stable and flips to the real value in a single,
  // flicker-free transition.
  const isClient = useIsClient();
  const isSupported =
    isClient &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder === "function";

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization, react-hooks-js/preserve-manual-memoization -- returned hook API / stable identity for effect dep; React Compiler bails out on this callback (async + early returns), so the manual useCallback is required and intentional
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

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
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
              // react-doctor-disable-next-line react-hooks-js/immutability -- fresh-local mutation: `bytes` is allocated three lines above to decode base64 PCM into a new buffer; it is never shared or part of React state, so the per-index writes are the standard atob->Uint8Array decode and there is nothing to update immutably.
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
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- playAudio is intentionally omitted: it is a stable useCallback([]) declared below connectWs, so listing it here would be a use-before-declaration error while adding no reactivity (its identity never changes); getWsUrl and opts are the only deps that can invalidate this callback
  }, [getWsUrl, opts]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
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

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization, react-hooks-js/preserve-manual-memoization -- returned hook API / stable identity for effect dep; React Compiler bails out on this callback (imperative AudioContext setup), so the manual useCallback is required and intentional
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

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only-live-ref: this teardown intentionally reads the live ref values (.current) at the moment of unmount to close whatever ws/recorder/AudioContext is active then; capturing them at effect-setup time would tear down stale or null handles and leak the live ones.
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
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only teardown: it must close whatever ws/recorder/audioContext is live in the refs at teardown time, so it reads .current at cleanup; an empty dep array is required so this runs exactly once on unmount and never re-tears-down mid-session
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
