import { describe, expect, it } from "vitest";
import {
  AudioFormatSchema,
  ClientMediaCapabilitiesSchema,
  SafeVoiceErrorSchema,
  VOICE_SESSION_LIMITS,
  VoiceCapabilitySchema,
  VoiceClientFrameSchema,
  VoicePlaybackAckSchema,
  VoiceResponseSchema,
  VoiceServerFrameSchema,
  VoiceSessionControlSchema,
  VoiceSessionLimitsSchema,
  VoiceTranscriptCorrectionSchema,
  VoiceTranscriptFinalSchema,
  VoiceTranscriptProvisionalSchema,
} from "../../packages/contracts/src/voice-session.js";

const common = {
  contractVersion: 1 as const,
  sessionId: "vs_demo",
  epoch: 1,
  sequence: 0,
};

const limits = { ...VOICE_SESSION_LIMITS };
const capabilityLimits = {
  maxSessionSeconds: VOICE_SESSION_LIMITS.maxSessionSeconds,
  maxIdleSeconds: VOICE_SESSION_LIMITS.maxIdleSeconds,
};

const audio = {
  codec: "pcm_s16le" as const,
  sampleRateHz: 24_000 as const,
  channels: 1 as const,
  frameDurationMs: 20,
};

const capabilities = {
  formats: [audio],
  binaryAudio: true,
  maxAudioFrameBytes: VOICE_SESSION_LIMITS.maxAudioFrameBytes,
  deviceChangeEvents: true,
};

function expectRejected(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("voice session contracts", () => {
  it("parses a strict provider-neutral capability", () => {
    const capability = {
      contractVersion: 1,
      status: "available",
      surface: "electron_desktop",
      transportModes: ["relayed_websocket"],
      turnModes: ["hands_free", "push_to_talk"],
      supportsInterruption: true,
      resume: "delivery_aware",
      sessionOnly: "enforced",
      actionMode: "canonical_actions",
      actionCancellation: "tool",
      supportsInputSelection: true,
      supportsOutputSelection: true,
      limits: capabilityLimits,
    };
    expect(VoiceCapabilitySchema.parse(capability)).toEqual(capability);
    const { limits: _omitted, ...withoutLimits } = capability;
    expect(VoiceCapabilitySchema.parse(withoutLimits)).toEqual(withoutLimits);
    expectRejected(VoiceCapabilitySchema, { ...capability, interruption: true });
    expectRejected(VoiceCapabilitySchema, { ...capability, turnModes: ["whisper"] });
    expectRejected(VoiceCapabilitySchema, { ...capability, provider: "openai" });
    expectRejected(VoiceCapabilitySchema, { ...capability, model: "realtime" });
    expectRejected(VoiceCapabilitySchema, { ...capability, apiKey: "sk-secret" });
    expectRejected(VoiceCapabilitySchema, { ...capability, endpoint: "https://internal.example" });
    expectRejected(VoiceCapabilitySchema, { ...capability, reason: "raw upstream failure" });
    expectRejected(VoiceCapabilitySchema, { ...capability, limits: { ...capabilityLimits, hidden: true } });
    expectRejected(VoiceCapabilitySchema, { ...capability, limits });
    expectRejected(VoiceCapabilitySchema, {
      ...capability,
      limits: { ...capabilityLimits, maxSessionSeconds: VOICE_SESSION_LIMITS.maxSessionSeconds + 1 },
    });
  });

  it("bounds every advertised resource limit", () => {
    expect(VoiceSessionLimitsSchema.parse(limits)).toEqual(limits);
    const invalid = [
      ["maxSequence", Number.MAX_SAFE_INTEGER + 1],
      ["maxTranscriptChars", VOICE_SESSION_LIMITS.maxTranscriptChars + 1],
      ["maxTranscriptBytes", VOICE_SESSION_LIMITS.maxTranscriptBytes + 1],
      ["maxAudioFrameBytes", VOICE_SESSION_LIMITS.maxAudioFrameBytes + 1],
      ["maxQueuedAudioMs", VOICE_SESSION_LIMITS.maxQueuedAudioMs + 1],
      ["maxSessionSeconds", VOICE_SESSION_LIMITS.maxSessionSeconds + 1],
      ["maxIdleSeconds", VOICE_SESSION_LIMITS.maxIdleSeconds + 1],
      ["maxReconnectAttempts", VOICE_SESSION_LIMITS.maxReconnectAttempts + 1],
      ["maxSegments", VOICE_SESSION_LIMITS.maxSegments + 1],
      ["maxOperationLabelChars", VOICE_SESSION_LIMITS.maxOperationLabelChars + 1],
    ] as const;
    for (const [key, value] of invalid) {
      expectRejected(VoiceSessionLimitsSchema, { ...limits, [key]: value });
    }
    expectRejected(VoiceSessionLimitsSchema, { ...limits, maxQueuedAudioMs: 0 });
    expectRejected(VoiceSessionLimitsSchema, { ...limits, maxSessionSeconds: 0 });
  });

  it("uses bounded audio format and media capability enums without provider fields", () => {
    expect(AudioFormatSchema.parse(audio)).toEqual(audio);
    expect(ClientMediaCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expectRejected(AudioFormatSchema, { ...audio, codec: "provider-native" });
    expectRejected(AudioFormatSchema, { ...audio, sampleRateHz: 96_000 });
    expectRejected(AudioFormatSchema, { ...audio, url: "wss://provider.example" });
    expectRejected(ClientMediaCapabilitiesSchema, { ...capabilities, credentials: "secret" });
    expectRejected(ClientMediaCapabilitiesSchema, { ...capabilities, formats: Array(9).fill(audio) });
  });

  it("bounds transcript characters and UTF-8 bytes and keeps finality explicit", () => {
    const provisional = {
      turnId: "vturn_demo",
      revision: 0,
      text: "still speaking",
    };
    const final = {
      turnId: "vturn_demo",
      finalityId: "vfinal_demo",
      canonicalTurnId: "cturn_demo",
      localOrder: 0,
      text: "done speaking",
    };
    expect(VoiceTranscriptProvisionalSchema.parse(provisional)).toEqual(provisional);
    expect(VoiceTranscriptFinalSchema.parse(final)).toEqual(final);
    expectRejected(VoiceTranscriptFinalSchema, { ...final, finalityId: undefined });
    expectRejected(VoiceTranscriptFinalSchema, { ...final, text: "x".repeat(VOICE_SESSION_LIMITS.maxTranscriptChars + 1) });
    expect(VoiceTranscriptFinalSchema.parse({ ...final, text: "😀".repeat(8_000) }).text).toHaveLength(16_000);
    expectRejected(VoiceTranscriptFinalSchema, { ...final, text: "😀".repeat(8_001) });
    expectRejected(VoiceTranscriptProvisionalSchema, { ...provisional, revision: -1 });
    expectRejected(VoiceTranscriptProvisionalSchema, { ...provisional, revision: Number.MAX_SAFE_INTEGER + 1 });
  });

  it("keeps corrections presentation-only and tied to the original finality", () => {
    const correction = {
      turnId: "vturn_demo",
      finalityId: "vfinal_demo",
      revision: 1,
      text: "corrected presentation",
    };
    expect(VoiceTranscriptCorrectionSchema.parse(correction)).toEqual(correction);
    for (const executable of [
      { canonicalTurnId: "cturn_other" },
      { runId: "run_other" },
      { clientRequestId: "req_other" },
      { action: { tool: "delete" } },
    ]) {
      expectRejected(VoiceTranscriptCorrectionSchema, { ...correction, ...executable });
    }
  });

  it("keeps stop speaking, generation cancellation, and action cancellation distinct", () => {
    const controls = [
      { type: "response.interrupt", responseId: "vresp_demo", playedThroughMs: 120 },
      { type: "generation.cancel", responseId: "vresp_demo" },
      { type: "action.cancel", actionId: "action_demo" },
    ];
    for (const control of controls) expect(VoiceSessionControlSchema.parse(control)).toEqual(control);
    expect(new Set(controls.map(({ type }) => type)).size).toBe(3);
    expectRejected(VoiceSessionControlSchema, {
      type: "response.interrupt",
      responseId: "vresp_demo",
      actionId: "action_demo",
      playedThroughMs: 120,
    });
    expectRejected(VoiceSessionControlSchema, { type: "action.cancel", actionId: "x".repeat(200) });
  });

  it("bounds playback acknowledgement and response segments", () => {
    const ack = {
      responseId: "vresp_demo",
      segmentId: "vseg_demo",
      deliveryRevision: 2,
      playedThroughMs: 500,
    };
    expect(VoicePlaybackAckSchema.parse(ack)).toEqual(ack);
    expectRejected(VoicePlaybackAckSchema, { ...ack, playedThroughMs: -1 });
    expectRejected(VoicePlaybackAckSchema, { ...ack, deliveryRevision: Number.MAX_SAFE_INTEGER + 1 });

    const segment = {
      segmentId: "vseg_demo",
      segmentIndex: 0,
      textStart: 0,
      textEnd: 5,
      durationMs: 500,
    };
    expect(VoiceResponseSchema.parse({
      responseId: "vresp_demo",
      runId: "run_demo",
      segments: [segment],
    }).segments).toEqual([segment]);
    expectRejected(VoiceResponseSchema, {
      responseId: "vresp_demo",
      runId: "run_demo",
      segments: Array(VOICE_SESSION_LIMITS.maxSegments + 1).fill(segment),
    });
    expectRejected(VoiceResponseSchema, {
      responseId: "vresp_demo",
      runId: "run_demo",
      segments: [{ ...segment, textEnd: -1 }],
    });
    expectRejected(VoiceResponseSchema, {
      responseId: "vresp_demo",
      runId: "run_demo",
      segments: [{ ...segment, providerItemId: "private" }],
    });
  });

  it("rejects malformed and decoded-oversized base64 audio", () => {
    const base = {
      ...common,
      type: "capture.audio",
      turnId: "vturn_demo",
      timestampMs: 10,
    };
    expect(VoiceClientFrameSchema.parse({ ...base, data: Buffer.from("audio").toString("base64") })).toBeTruthy();
    for (const malformed of ["", "not base64!", "AAAA=", "A===", "YWJjZA==junk"]) {
      expectRejected(VoiceClientFrameSchema, { ...base, data: malformed });
    }
    const oversized = Buffer.alloc(VOICE_SESSION_LIMITS.maxAudioFrameBytes + 1).toString("base64");
    expectRejected(VoiceClientFrameSchema, { ...base, data: oversized });
  });

  it("parses representative client frames and rejects recursive unknown keys", () => {
    const frames = [
      { ...common, type: "client.ready", audio, capabilities },
      { ...common, sequence: 1, type: "capture.start", turnId: "vturn_demo", mode: "push_to_talk" },
      { ...common, sequence: 2, type: "capture.stop", turnId: "vturn_demo" },
      { ...common, sequence: 3, type: "session.pause" },
      { ...common, sequence: 4, type: "session.resume" },
      { ...common, sequence: 5, type: "device.changed", inputDeviceId: "mic_default" },
      { ...common, sequence: 6, type: "heartbeat", timestampMs: 1_000 },
      { ...common, sequence: 7, type: "session.end", reason: "user" },
    ];
    for (const frame of frames) expect(VoiceClientFrameSchema.parse(frame)).toEqual(frame);
    expectRejected(VoiceClientFrameSchema, { ...frames[0], audio: { ...audio, provider: "vendor" } });
    expectRejected(VoiceClientFrameSchema, { ...frames[0], capabilities: { ...capabilities, secret: "value" } });
    expectRejected(VoiceClientFrameSchema, { ...frames[1], sequence: -1 });
    expectRejected(VoiceClientFrameSchema, { ...frames[1], sequence: Number.MAX_SAFE_INTEGER + 1 });
    expectRejected(VoiceClientFrameSchema, { ...frames[1], epoch: 0 });
  });

  it("parses representative server frames with bounded canonical operation status", () => {
    const frames = [
      { ...common, type: "session.state", state: "listening" },
      { ...common, sequence: 0, epoch: 2, type: "session.resumed", state: "listening", reason: "restored" },
      { ...common, sequence: 1, type: "transcript.provisional", turnId: "vturn_demo", revision: 0, text: "hello" },
      {
        ...common,
        sequence: 2,
        type: "transcript.final",
        turnId: "vturn_demo",
        finalityId: "vfinal_demo",
        canonicalTurnId: "cturn_demo",
        localOrder: 0,
        text: "hello",
      },
      { ...common, sequence: 3, type: "response.started", responseId: "vresp_demo", runId: "run_demo" },
      {
        ...common,
        sequence: 4,
        type: "response.audio",
        responseId: "vresp_demo",
        segmentId: "vseg_demo",
        startMs: 0,
        data: Buffer.from("audio").toString("base64"),
      },
      { ...common, sequence: 5, type: "operation.status", runId: "run_demo", label: "Searching", state: "running" },
      { ...common, sequence: 6, type: "heartbeat.ack", timestampMs: 1_000 },
    ];
    for (const frame of frames) expect(VoiceServerFrameSchema.parse(frame)).toEqual(frame);
    expectRejected(VoiceServerFrameSchema, {
      ...frames[6],
      label: "x".repeat(VOICE_SESSION_LIMITS.maxOperationLabelChars + 1),
    });
    expectRejected(VoiceServerFrameSchema, { ...frames[6], state: "provider_thinking" });
    expectRejected(VoiceServerFrameSchema, { ...frames[5], providerItemId: "private" });
    expectRejected(VoiceServerFrameSchema, { ...frames[1], state: "provider_native_resume" });
    expectRejected(VoiceServerFrameSchema, { ...frames[1], ticket: "one-time-secret" });
  });

  it("makes unsafe free-form client errors impossible", () => {
    const safe = {
      code: "connection_lost",
      retryable: true,
      recovery: "retry_connection",
    };
    expect(SafeVoiceErrorSchema.parse(safe)).toEqual(safe);
    expect(SafeVoiceErrorSchema.parse({
      code: "audio_backpressure",
      retryable: true,
      recovery: "continue_in_chat",
    })).toEqual({
      code: "audio_backpressure",
      retryable: true,
      recovery: "continue_in_chat",
    });
    expectRejected(SafeVoiceErrorSchema, { ...safe, code: "upstream_429" });
    for (const unsafe of [
      { message: "OpenAI key missing at /opt/matrix" },
      { rawError: { stack: "secret" } },
      { provider: "vendor" },
      { credentials: "token" },
    ]) {
      expectRejected(SafeVoiceErrorSchema, { ...safe, ...unsafe });
      expectRejected(VoiceServerFrameSchema, { ...common, type: "session.error", ...safe, ...unsafe });
    }
  });
});
