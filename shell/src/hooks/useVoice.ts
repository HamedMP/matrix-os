"use client";

import { useState, useRef, useCallback, useEffect } from "react";

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
  const [isSupported] = useState(() => {
    if (typeof window === "undefined") return false;
    return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const getWsUrl = useCallback(() => {
    if (opts?.wsUrl) return opts.wsUrl;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws/voice`;
  }, [opts?.wsUrl]);

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "transcription" && opts?.onTranscription) {
            setIsTranscribing(false);
            opts.onTranscription(msg.text);
          }
          if (msg.type === "audio_done") {
            setIsPlaying(false);
          }
          if (msg.type === "error" && opts?.onError) {
            setIsTranscribing(false);
            opts.onError(msg.message);
          }
        } catch {}
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

        const ws = connectWs();
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
    }).catch(() => {
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
