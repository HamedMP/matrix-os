import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { VoiceAudioFrameDataSchema } from "@matrix-os/contracts/voice-session";
import type { VoiceMediaAdapter, VoiceMediaSession } from "../voice-session/adapter.js";
import type { LiveCompanionPort } from "./coordinator.js";

export const MAX_VOICE_CLIENT_FRAME_BYTES = 256 * 1024;
const VoiceIdSchema = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,160}$`));
const ClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("capture.start") }).strict(),
  z.object({ type: z.literal("capture.stop") }).strict(),
  z.object({ type: z.literal("audio"), data: VoiceAudioFrameDataSchema }).strict(),
  z.object({ type: z.literal("played"), responseId: VoiceIdSchema("vresp"), segmentId: VoiceIdSchema("vseg") }).strict(),
  z.object({ type: z.literal("interrupt"), responseId: VoiceIdSchema("vresp"), playedThroughMs: z.number().int().nonnegative().max(1_800_000) }).strict(),
  z.object({ type: z.literal("heartbeat") }).strict(),
  z.object({ type: z.literal("end") }).strict(),
]);

export type VoiceLiveEndReason = "user" | "idle" | "max_duration" | "socket_closed" | "replaced" | "shutdown" | "error";
export interface VoiceLiveSession {
  readonly sessionId: string;
  handle(raw: string): Promise<void>;
  close(reason: VoiceLiveEndReason): Promise<void>;
}

/** One native voice call bound to one owner Chat. The client never names a
 * turn, owner or Chat; the server issues capture turns and owns all limits. */
export async function createVoiceLiveSession(options: {
  adapter: VoiceMediaAdapter;
  port: LiveCompanionPort;
  chatId: string;
  principalId: string;
  send(frame: Record<string, unknown>): void;
  onClosed(): void;
  limits: { maxSessionMs: number; idleMs: number };
}): Promise<VoiceLiveSession> {
  const sessionId = `vs_${randomBytes(12).toString("hex")}`;
  let media: VoiceMediaSession | null = null;
  let closed = false;
  let captureTurnId: string | null = null;
  let captures = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const send = (frame: Record<string, unknown>) => {
    if (closed) return;
    try { options.send(frame); }
    catch (error: unknown) { console.warn("[voice-live] send failed", error instanceof Error ? error.name : "UnknownError"); }
  };
  const close = async (reason: VoiceLiveEndReason) => {
    if (closed) return;
    if (reason !== "error" && reason !== "socket_closed") send({ type: "session.ended", reason });
    closed = true;
    clearTimeout(maxTimer);
    if (idleTimer) clearTimeout(idleTimer);
    try { await media?.close(); }
    catch (error: unknown) { console.warn("[voice-live] adapter close failed", error instanceof Error ? error.name : "UnknownError"); }
    options.onClosed();
  };
  const fail = (code: string, retryable: boolean) => {
    send({ type: "error", code, retryable });
    void close("error");
  };
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close("idle"), options.limits.idleMs);
  };
  const maxTimer = setTimeout(() => void close("max_duration"), options.limits.maxSessionMs);
  touch();
  try {
    media = await options.adapter.start({
      live: options.port, sessionId, chatId: options.chatId, principalId: options.principalId,
      turnMode: "hands_free", memoryMode: "ordinary",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      emit(event) {
        if (event.type === "companion.frame") send(event.frame as Record<string, unknown>);
        else if (event.type === "error") {
          if (event.fatal) fail(event.code, event.retryable);
          else send({ type: "error", code: event.code, retryable: event.retryable });
        }
      },
    });
  } catch (error: unknown) {
    console.warn("[voice-live] adapter start failed", error instanceof Error ? error.name : "UnknownError");
    fail("provider_unavailable", true);
    throw new Error("Voice session unavailable", { cause: error });
  }
  if (closed) { await media.close(); throw new Error("Voice session closed during start"); }
  send({ type: "session.ready", chatId: options.chatId });

  return {
    sessionId,
    close,
    async handle(raw: string) {
      if (closed) return;
      touch();
      let frame: z.infer<typeof ClientFrameSchema>;
      try {
        if (Buffer.byteLength(raw) > MAX_VOICE_CLIENT_FRAME_BYTES) throw new RangeError("Voice frame too large");
        frame = ClientFrameSchema.parse(JSON.parse(raw));
      } catch (error: unknown) {
        console.warn("[voice-live] invalid client frame", error instanceof Error ? error.name : "UnknownError");
        fail("invalid_request", false);
        return;
      }
      const session = media!;
      switch (frame.type) {
        case "capture.start":
          if (!captureTurnId) {
            captureTurnId = `vturn_${sessionId.slice(3)}_c${++captures}`;
            session.setCapture({ turnId: captureTurnId, mode: "hands_free" });
          }
          return;
        case "capture.stop":
          if (captureTurnId) { captureTurnId = null; session.setCapture(null); }
          return;
        case "audio":
          if (captureTurnId) session.pushAudio({ turnId: captureTurnId, timestampMs: Date.now(), data: frame.data });
          return;
        case "played":
          session.native?.played(frame.responseId, frame.segmentId);
          return;
        case "interrupt":
          session.interrupt(frame.responseId, frame.playedThroughMs);
          return;
        case "heartbeat":
          return;
        case "end":
          await close("user");
      }
    },
  };
}
