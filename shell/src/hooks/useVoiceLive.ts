"use client";

import { useEffect, useReducer, useRef } from "react";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";
import { initialVoiceLiveState, parseVoiceLiveFrame, reduceVoiceLive, type VoiceLiveEvent, type VoiceLiveState } from "@/lib/voice-live-state";

const OUTPUT_SAMPLE_RATE = 24_000;

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function pcm16ToFloat(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const samples = new Float32Array(new ArrayBuffer((binary.length >> 1) * 4));
  for (let i = 0; i < samples.length; i++) {
    const value = view.getInt16(i * 2, true);
    samples[i] = value / (value < 0 ? 0x8000 : 0x7fff);
  }
  return samples;
}

function openVoiceSocket(url: string): WebSocket {
  return new WebSocket(url);
}

function stopContext(ctx: AudioContext | null, label: string) {
  ctx?.close().catch((error: unknown) => {
    console.warn(`[voice-live] ${label} close failed:`, error instanceof Error ? error.name : "UnknownError");
  });
}

/** Native live voice call on one Matrix Chat. Mic audio streams as 16 kHz
 * PCM; replies play at 24 kHz and each played segment is acknowledged so the
 * gateway only commits what the owner actually heard. */
export function useVoiceLive(enabled: boolean, chatId: string | undefined): VoiceLiveState & { end(): void } {
  const [state, dispatch] = useReducer(reduceVoiceLive, initialVoiceLiveState);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let stream: MediaStream | null = null;
    let micCtx: AudioContext | null = null;
    let playCtx: AudioContext | null = null;
    let nextStart = 0;
    let playing = new Set<AudioBufferSourceNode>();
    let currentResponse: string | null = null;
    dispatch({ type: "reset" });
    const emit = (event: VoiceLiveEvent) => { if (!disposed) dispatch(event); };
    const send = (frame: Record<string, unknown>) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };

    const flushPlayback = () => {
      for (const source of playing) {
        source.onended = null;
        try { source.stop(); }
        catch (error: unknown) { console.warn("[voice-live] stop playback failed:", error instanceof Error ? error.name : "UnknownError"); }
      }
      playing = new Set();
      nextStart = 0;
    };

    const play = (responseId: string, segmentId: string, data: string) => {
      if (!playCtx) playCtx = new AudioContext();
      const ctx = playCtx;
      const samples = pcm16ToFloat(data);
      if (samples.length === 0) return;
      const buffer = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime, nextStart);
      source.start(startAt);
      nextStart = startAt + buffer.duration;
      currentResponse = responseId;
      playing.add(source);
      source.onended = () => {
        playing.delete(source);
        send({ type: "played", responseId, segmentId });
        if (playing.size === 0) emit({ type: "playback.idle" });
      };
    };

    let worklet: AudioWorkletNode | null = null;
    const startMic = async () => {
      const granted = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (disposed) { granted.getTracks().forEach((track) => track.stop()); return; }
      stream = granted;
      const ctx = new AudioContext({ sampleRate: 16_000 });
      micCtx = ctx;
      // Ordered: the processor name exists only after the module loads.
      await ctx.audioWorklet.addModule("/audio-worklet-processor.js");
      if (disposed) return;
      worklet = new AudioWorkletNode(ctx, "pcm16-processor");
      worklet.port.onmessage = (event: MessageEvent<{ type: string; bytes?: ArrayBuffer }>) => {
        if (event.data.type === "audio" && event.data.bytes) send({ type: "audio", data: base64FromBytes(new Uint8Array(event.data.bytes)) });
      };
      ctx.createMediaStreamSource(granted).connect(worklet);
      send({ type: "capture.start" });
    };

    void buildAuthenticatedWebSocketUrl(chatId ? `/ws/voice/live?chatId=${encodeURIComponent(chatId)}` : "/ws/voice/live")
      .then((url) => {
        if (disposed) return;
        ws = openVoiceSocket(url);
        wsRef.current = ws;
        ws.onmessage = (message) => {
          const frame = typeof message.data === "string" ? parseVoiceLiveFrame(message.data) : null;
          if (!frame) return;
          if (frame.type === "response.audio") play(frame.responseId, frame.segmentId, frame.data);
          if (frame.type === "response.interrupted" && frame.responseId === currentResponse) flushPlayback();
          if (frame.type === "session.ready") {
            void startMic().catch((error: unknown) => {
              console.warn("[voice-live] microphone unavailable:", error instanceof Error ? error.name : "UnknownError");
              emit({ type: "error", code: "microphone_denied", retryable: false });
              ws?.close();
            });
          }
          emit(frame);
        };
        ws.onclose = () => { wsRef.current = null; emit({ type: "socket.closed" }); };
      })
      .catch((error: unknown) => {
        console.warn("[voice-live] connection unavailable:", error instanceof Error ? error.name : "UnknownError");
        emit({ type: "error", code: "connection_lost", retryable: true });
      });

    return () => {
      disposed = true;
      send({ type: "end" });
      if (ws) { ws.onmessage = null; ws.onclose = null; ws.close(); }
      wsRef.current = null;
      if (worklet) { worklet.port.onmessage = null; worklet.disconnect(); }
      stream?.getTracks().forEach((track) => track.stop());
      flushPlayback();
      stopContext(micCtx, "microphone");
      stopContext(playCtx, "playback");
    };
  }, [enabled, chatId]);

  return {
    ...(enabled ? state : initialVoiceLiveState),
    end() { wsRef.current?.send(JSON.stringify({ type: "end" })); },
  };
}
