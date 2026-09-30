/**
 * Owns the client's VoiceTransport instance: construction, per-session
 * replacement, event wiring into the controller/media layers, and the
 * `client.ready` hello. Tickets are single-use, so every reconnect hands a
 * fresh grant here rather than reusing sockets.
 */
import {
  VoiceOutputAudioFormatSchema,
  type AudioFormat,
  type ClientMediaCapabilities,
  type SafeVoiceError,
  type VoiceOutputAudioFormat,
} from "@matrix-os/contracts/voice-session";
import type { VoiceSessionController } from "./controller.js";
import type { VoiceMediaSession } from "./media-session.js";
import {
  CONNECTION_LOST_FATAL,
  type VoiceSessionClientOptions,
  type VoiceSessionClientPhase,
} from "./client-types.js";
import { voiceErrorForCode, type VoiceSessionTransportGrant } from "./session-api.js";
import { VoiceTransport } from "./transport.js";

type RelayedGrant = Extract<VoiceSessionTransportGrant, { kind: "relayed_websocket" }>;

/**
 * Tolerant reader for the optional output format declared on `response.audio`
 * frames (`format`) or the capability response (`outputAudio`). Malformed
 * values are ignored so playback falls back to the negotiated session format.
 */
export function voiceDeclaredAudioFormat(value: unknown): VoiceOutputAudioFormat | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = VoiceOutputAudioFormatSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export interface VoiceTransportAttachmentDeps {
  sessionId(): string | null;
  controller(): VoiceSessionController | null;
  media(): VoiceMediaSession | null;
  /** True while a socket close should trigger reconnect logic (not idle/ended/disposed). */
  lossIsReconnectable(): boolean;
  audio: AudioFormat;
  mediaCapabilities(): ClientMediaCapabilities;
  /** Default output format declared by the capability response, if any. */
  declaredOutputAudio(): VoiceOutputAudioFormat | undefined;
  options: Pick<
    VoiceSessionClientOptions,
    | "webSocketFactory"
    | "heartbeatIntervalMs"
    | "heartbeatTimeoutMs"
    | "maxOutboundQueue"
    | "now"
    | "setIntervalFn"
    | "clearIntervalFn"
  >;
  noteRetryAfter(ms: number): void;
  /** Local `transport.going_away` injection for the controller. */
  goingAway(): void;
  onResumed(): void;
  setPhase(phase: VoiceSessionClientPhase): void;
  failSession(error: SafeVoiceError): void;
  scheduleReconnect(): void;
  setNotice(error: SafeVoiceError): void;
  /** Server ended the session via `session.state` -> ended. */
  onRemoteEnd(): void;
  /**
   * Server marked the session `session.state` -> failed. The server intends
   * reconnect-revival: schedule a bounded reconnect, or fail terminally when
   * the ladder is exhausted.
   */
  onRemoteFailed(): void;
}

export interface VoiceTransportAttachment {
  current(): VoiceTransport | null;
  connect(grant: RelayedGrant): void;
  /** Close + dispose the current socket without reporting loss. */
  retire(): void;
}

export function createTransportAttachment(deps: VoiceTransportAttachmentDeps): VoiceTransportAttachment {
  let transport: VoiceTransport | null = null;
  let transportSessionId: string | null = null;

  const retire = () => {
    transport?.close();
    transport?.dispose();
    transport = null;
    transportSessionId = null;
  };

  return {
    current: () => transport,
    connect(grant) {
      const sessionId = deps.sessionId();
      if (sessionId === null) return;
      if (transport === null || transportSessionId !== sessionId) {
        transport?.dispose();
        transportSessionId = sessionId;
        transport = new VoiceTransport({
          sessionId,
          webSocketFactory: deps.options.webSocketFactory,
          heartbeatIntervalMs: deps.options.heartbeatIntervalMs,
          heartbeatTimeoutMs: deps.options.heartbeatTimeoutMs,
          maxOutboundQueue: deps.options.maxOutboundQueue,
          now: deps.options.now,
          setIntervalFn: deps.options.setIntervalFn,
          clearIntervalFn: deps.options.clearIntervalFn,
          events: {
            onOpen: () => {
              transport?.send({
                type: "client.ready",
                audio: deps.audio,
                capabilities: deps.mediaCapabilities(),
              });
            },
            onFrame: (frame) => {
              if (frame.type === "transport.going_away") deps.noteRetryAfter(frame.retryAfterMs);
              const controller = deps.controller();
              if (!controller || !controller.receive(frame)) return;
              if (frame.type === "session.resumed") {
                deps.onResumed();
                deps.setPhase("active");
              } else if (frame.type === "response.audio") {
                deps.media()?.enqueueSegment({
                  responseId: frame.responseId,
                  segmentId: frame.segmentId,
                  data: frame.data,
                  // A frame-declared output format (e.g. 24 kHz synthesis)
                  // wins over the capability-declared default, which wins
                  // over the negotiated input format.
                  format: frame.format ?? deps.declaredOutputAudio(),
                });
              } else if (frame.type === "response.interrupted") {
                deps.media()?.interruptResponse(frame.responseId);
              } else if (frame.type === "session.state" && frame.state === "ended") {
                deps.onRemoteEnd();
              } else if (frame.type === "session.state" && frame.state === "failed") {
                deps.onRemoteFailed();
              }
            },
            onConnectionLost: (info) => {
              if (!deps.lossIsReconnectable()) return;
              if (!info.reconnectable) {
                deps.failSession(CONNECTION_LOST_FATAL);
                return;
              }
              deps.goingAway();
              deps.setPhase("reconnecting");
              deps.scheduleReconnect();
            },
            onBackpressure: () => deps.setNotice(voiceErrorForCode("audio_backpressure")),
            onInvalidFrame: () => undefined,
          },
        });
      }
      transport.connect({ url: grant.url, ticket: grant.ticket, epoch: grant.epoch });
    },
    retire,
  };
}
