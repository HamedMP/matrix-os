import { describe, it, expect } from "vitest";

import {
  CallStateSchema,
  CallModeSchema,
  EndReasonSchema,
  ProviderNameSchema,
  NormalizedEventSchema,
  CallRecordSchema,
  E164Schema,
  VoiceConfigSchema,
  TranscriptEntrySchema,
  VALID_TRANSITIONS,
  isValidTransition,
  TerminalStates,
  type CallState,
} from "../../../packages/gateway/src/voice/types.js";

describe("Voice Types", () => {
  describe("CallState", () => {
    const allStates = [
      "initiated",
      "ringing",
      "answered",
      "active",
      "speaking",
      "listening",
      "completed",
      "hangup-user",
      "hangup-bot",
      "timeout",
      "error",
      "failed",
      "no-answer",
      "busy",
      "voicemail",
    ] as const;

    it.each(allStates)("accepts valid state '%s'", (state) => {
      expect(CallStateSchema.parse(state)).toBe(state);
    });

    it("rejects invalid state", () => {
      expect(() => CallStateSchema.parse("invalid-state")).toThrow();
    });

    it("has exactly 16 valid states", () => {
      expect(CallStateSchema.options.length).toBe(16);
    });
  });

  describe("CallMode", () => {
    it("accepts 'notify'", () => {
      expect(CallModeSchema.parse("notify")).toBe("notify");
    });

    it("accepts 'conversation'", () => {
      expect(CallModeSchema.parse("conversation")).toBe("conversation");
    });

    it("rejects invalid mode", () => {
      expect(() => CallModeSchema.parse("invalid")).toThrow();
    });
  });

  describe("EndReason", () => {
    const reasons = [
      "hangup-user",
      "hangup-bot",
      "timeout",
      "error",
      "failed",
      "no-answer",
      "busy",
      "voicemail",
      "completed",
      "canceled",
    ] as const;

    it.each(reasons)("accepts valid reason '%s'", (reason) => {
      expect(EndReasonSchema.parse(reason)).toBe(reason);
    });

    it("rejects invalid reason", () => {
      expect(() => EndReasonSchema.parse("unknown")).toThrow();
    });
  });

  describe("ProviderName", () => {
    it("accepts 'twilio'", () => {
      expect(ProviderNameSchema.parse("twilio")).toBe("twilio");
    });

    it("accepts 'telnyx'", () => {
      expect(ProviderNameSchema.parse("telnyx")).toBe("telnyx");
    });

    it("accepts 'mock'", () => {
      expect(ProviderNameSchema.parse("mock")).toBe("mock");
    });

    it("rejects invalid provider", () => {
      expect(() => ProviderNameSchema.parse("vonage")).toThrow();
    });
  });

  describe("NormalizedEvent", () => {
    const baseEvent = {
      id: "evt-1",
      callId: "call-1",
      timestamp: Date.now(),
    };

    it("validates call.initiated", () => {
      const event = { ...baseEvent, type: "call.initiated" as const };
      expect(NormalizedEventSchema.parse(event)).toMatchObject({
        type: "call.initiated",
      });
    });

    it("validates call.ringing", () => {
      const event = { ...baseEvent, type: "call.ringing" as const };
      expect(NormalizedEventSchema.parse(event)).toMatchObject({
        type: "call.ringing",
      });
    });

    it("validates call.answered", () => {
      const event = { ...baseEvent, type: "call.answered" as const };
      expect(NormalizedEventSchema.parse(event)).toMatchObject({
        type: "call.answered",
      });
    });

    it("validates call.active", () => {
      const event = { ...baseEvent, type: "call.active" as const };
      expect(NormalizedEventSchema.parse(event)).toMatchObject({
        type: "call.active",
      });
    });

    it("validates call.speaking with text", () => {
      const event = {
        ...baseEvent,
        type: "call.speaking" as const,
        text: "Hello",
      };
      const parsed = NormalizedEventSchema.parse(event);
      expect(parsed.type).toBe("call.speaking");
      expect((parsed as { text: string }).text).toBe("Hello");
    });

    it("validates call.speech with transcript", () => {
      const event = {
        ...baseEvent,
        type: "call.speech" as const,
        transcript: "Hi there",
        isFinal: true,
        confidence: 0.95,
      };
      const parsed = NormalizedEventSchema.parse(event);
      expect(parsed.type).toBe("call.speech");
      expect((parsed as { transcript: string }).transcript).toBe("Hi there");
    });

    it("validates call.silence with durationMs", () => {
      const event = {
        ...baseEvent,
        type: "call.silence" as const,
        durationMs: 5000,
      };
      const parsed = NormalizedEventSchema.parse(event);
      expect(parsed.type).toBe("call.silence");
      expect((parsed as { durationMs: number }).durationMs).toBe(5000);
    });

    it("validates call.dtmf with digits", () => {
      const event = {
        ...baseEvent,
        type: "call.dtmf" as const,
        digits: "1234",
      };
      const parsed = NormalizedEventSchema.parse(event);
      expect(parsed.type).toBe("call.dtmf");
      expect((parsed as { digits: string }).digits).toBe("1234");
    });

    it("validates call.ended with reason", () => {
      const event = {
        ...baseEvent,
        type: "call.ended" as const,
        reason: "hangup-user" as const,
      };
      const parsed = NormalizedEventSchema.parse(event);
      expect(parsed.type).toBe("call.ended");
      expect((parsed as { reason: string }).reason).toBe("hangup-user");
    });

    it("validates call.error with error string", () => {
      const event = {
        ...baseEvent,
        type: "call.error" as const,
        error: "Connection failed",
        retryable: true,
      };
      const parsed = NormalizedEventSchema.parse(event);
      expect(parsed.type).toBe("call.error");
      expect((parsed as { error: string }).error).toBe("Connection failed");
    });

    it("rejects unknown event type", () => {
      const event = { ...baseEvent, type: "call.unknown" };
      expect(() => NormalizedEventSchema.parse(event)).toThrow();
    });

    it("rejects call.speaking without text", () => {
      const event = { ...baseEvent, type: "call.speaking" };
      expect(() => NormalizedEventSchema.parse(event)).toThrow();
    });

    it("rejects call.speech without transcript", () => {
      const event = { ...baseEvent, type: "call.speech", isFinal: true };
      expect(() => NormalizedEventSchema.parse(event)).toThrow();
    });

    it("accepts optional fields on base event", () => {
      const event = {
        ...baseEvent,
        type: "call.initiated" as const,
        dedupeKey: "dedup-1",
        providerCallId: "prov-1",
        direction: "inbound" as const,
        from: "+1234567890",
        to: "+0987654321",
        turnToken: "turn-1",
      };
      const parsed = NormalizedEventSchema.parse(event);
      expect(parsed).toMatchObject({
        dedupeKey: "dedup-1",
        providerCallId: "prov-1",
        direction: "inbound",
      });
    });
  });

  describe("TranscriptEntry", () => {
    it("validates a complete entry", () => {
      const entry = { speaker: "bot", text: "Hello", ts: Date.now() };
      expect(TranscriptEntrySchema.parse(entry)).toMatchObject({
        speaker: "bot",
        text: "Hello",
      });
    });

    it("accepts 'user' speaker", () => {
      const entry = { speaker: "user", text: "Hi", ts: Date.now() };
      expect(TranscriptEntrySchema.parse(entry)).toMatchObject({
        speaker: "user",
      });
    });

    it("rejects invalid speaker", () => {
      const entry = { speaker: "system", text: "Hi", ts: Date.now() };
      expect(() => TranscriptEntrySchema.parse(entry)).toThrow();
    });
  });

  describe("CallRecord", () => {
    const validRecord = {
      callId: "call-123",
      provider: "twilio" as const,
      direction: "outbound" as const,
      state: "initiated" as const,
      from: "+1234567890",
      to: "+0987654321",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      mode: "conversation" as const,
    };

    it("validates a complete call record", () => {
      const parsed = CallRecordSchema.parse(validRecord);
      expect(parsed.callId).toBe("call-123");
      expect(parsed.provider).toBe("twilio");
      expect(parsed.direction).toBe("outbound");
      expect(parsed.state).toBe("initiated");
    });

    it("accepts optional providerCallId", () => {
      const record = { ...validRecord, providerCallId: "prov-abc" };
      const parsed = CallRecordSchema.parse(record);
      expect(parsed.providerCallId).toBe("prov-abc");
    });

    it("accepts optional answeredAt", () => {
      const record = { ...validRecord, answeredAt: Date.now() };
      const parsed = CallRecordSchema.parse(record);
      expect(parsed.answeredAt).toBeDefined();
    });

    it("accepts optional endedAt and endReason", () => {
      const record = {
        ...validRecord,
        endedAt: Date.now(),
        endReason: "completed" as const,
      };
      const parsed = CallRecordSchema.parse(record);
      expect(parsed.endedAt).toBeDefined();
      expect(parsed.endReason).toBe("completed");
    });

    it("accepts optional metadata", () => {
      const record = {
        ...validRecord,
        metadata: { source: "api", priority: 1 },
      };
      const parsed = CallRecordSchema.parse(record);
      expect(parsed.metadata).toEqual({ source: "api", priority: 1 });
    });

    it("defaults transcript to empty array", () => {
      const { transcript: _, ...withoutTranscript } = validRecord;
      const parsed = CallRecordSchema.parse(withoutTranscript);
      expect(parsed.transcript).toEqual([]);
    });

    it("defaults processedEventIds to empty array", () => {
      const { processedEventIds: _, ...withoutIds } = validRecord;
      const parsed = CallRecordSchema.parse(withoutIds);
      expect(parsed.processedEventIds).toEqual([]);
    });

    it("rejects missing required fields", () => {
      expect(() => CallRecordSchema.parse({})).toThrow();
      expect(() =>
        CallRecordSchema.parse({ callId: "x" }),
      ).toThrow();
    });

    it("rejects invalid provider", () => {
      expect(() =>
        CallRecordSchema.parse({ ...validRecord, provider: "vonage" }),
      ).toThrow();
    });

    it("rejects invalid state", () => {
      expect(() =>
        CallRecordSchema.parse({ ...validRecord, state: "invalid" }),
      ).toThrow();
    });

    it("rejects invalid direction", () => {
      expect(() =>
        CallRecordSchema.parse({ ...validRecord, direction: "lateral" }),
      ).toThrow();
    });
  });

  describe("E164Schema", () => {
    it("accepts valid US number", () => {
      expect(E164Schema.parse("+1234567890")).toBe("+1234567890");
    });

    it("accepts valid UK number", () => {
      expect(E164Schema.parse("+44123456789")).toBe("+44123456789");
    });

    it("accepts valid long number", () => {
      expect(E164Schema.parse("+123456789012345")).toBe("+123456789012345");
    });

    it("accepts minimum valid number (2 digits)", () => {
      expect(E164Schema.parse("+12")).toBe("+12");
    });

    it("rejects alphabetic string", () => {
      expect(() => E164Schema.parse("abc")).toThrow();
    });

    it("rejects number without plus", () => {
      expect(() => E164Schema.parse("1234567890")).toThrow();
    });

    it("rejects empty string", () => {
      expect(() => E164Schema.parse("")).toThrow();
    });

    it("rejects number starting with +0", () => {
      expect(() => E164Schema.parse("+0123456789")).toThrow();
    });

    it("rejects too-long number (> 15 digits)", () => {
      expect(() => E164Schema.parse("+1234567890123456")).toThrow();
    });
  });

  describe("VoiceConfig", () => {
    it("validates config with all defaults", () => {
      const config = VoiceConfigSchema.parse({});
      expect(config.enabled).toBe(true);
      expect(config.tts.provider).toBe("auto");
      expect(config.stt.provider).toBe("whisper");
      expect(config.telephony.mode).toBe("managed");
    });

    it("accepts fully specified config", () => {
      const config = VoiceConfigSchema.parse({
        enabled: false,
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            voiceId: "abc",
            model: "eleven_turbo_v2_5",
          },
        },
        stt: {
          provider: "whisper",
          openai: { model: "whisper-1" },
        },
        telephony: {
          mode: "byop",
          provider: "twilio",
          maxDurationSeconds: 300,
          maxConcurrentCalls: 3,
          silenceTimeoutMs: 15000,
        },
        autoSpeakResponses: true,
      });
      expect(config.enabled).toBe(false);
      expect(config.tts.provider).toBe("elevenlabs");
      expect(config.telephony.maxDurationSeconds).toBe(300);
      expect(config.autoSpeakResponses).toBe(true);
    });

    it("applies default telephony values", () => {
      const config = VoiceConfigSchema.parse({});
      expect(config.telephony.provider).toBe("twilio");
      expect(config.telephony.maxDurationSeconds).toBe(600);
      expect(config.telephony.maxConcurrentCalls).toBe(5);
      expect(config.telephony.silenceTimeoutMs).toBe(30000);
    });

    it("defaults autoSpeakResponses to false", () => {
      const config = VoiceConfigSchema.parse({});
      expect(config.autoSpeakResponses).toBe(false);
    });
  });

  describe("TerminalStates", () => {
    const terminalStates: CallState[] = [
      "completed",
      "hangup-user",
      "hangup-bot",
      "timeout",
      "error",
      "failed",
      "no-answer",
      "busy",
      "voicemail",
    ];

    const nonTerminalStates: CallState[] = [
      "initiated",
      "ringing",
      "answered",
      "active",
      "speaking",
      "listening",
    ];

    it.each(terminalStates)("'%s' is terminal", (state) => {
      expect(TerminalStates.has(state)).toBe(true);
    });

    it.each(nonTerminalStates)("'%s' is not terminal", (state) => {
      expect(TerminalStates.has(state)).toBe(false);
    });
  });

  describe("State Transitions", () => {
    it("initiated -> ringing is valid", () => {
      expect(isValidTransition("initiated", "ringing")).toBe(true);
    });

    it("ringing -> answered is valid", () => {
      expect(isValidTransition("ringing", "answered")).toBe(true);
    });

    it("answered -> active is valid", () => {
      expect(isValidTransition("answered", "active")).toBe(true);
    });

    it("active -> speaking is valid", () => {
      expect(isValidTransition("active", "speaking")).toBe(true);
    });

    it("active -> listening is valid", () => {
      expect(isValidTransition("active", "listening")).toBe(true);
    });

    it("speaking -> listening is valid (conversation cycle)", () => {
      expect(isValidTransition("speaking", "listening")).toBe(true);
    });

    it("listening -> speaking is valid (conversation cycle)", () => {
      expect(isValidTransition("listening", "speaking")).toBe(true);
    });

    it("ringing -> speaking is invalid (skips states)", () => {
      expect(isValidTransition("ringing", "speaking")).toBe(false);
    });

    it("initiated -> active is invalid (skips states)", () => {
      expect(isValidTransition("initiated", "active")).toBe(false);
    });

    it("any non-terminal state can transition to terminal", () => {
      const nonTerminal: CallState[] = [
        "initiated",
        "ringing",
        "answered",
        "active",
        "speaking",
        "listening",
      ];
      const terminal: CallState[] = [
        "completed",
        "hangup-user",
        "hangup-bot",
        "timeout",
        "error",
        "failed",
        "no-answer",
        "busy",
        "voicemail",
      ];

      for (const from of nonTerminal) {
        for (const to of terminal) {
          expect(isValidTransition(from, to)).toBe(true);
        }
      }
    });

    it("terminal state cannot transition to any state", () => {
      const terminal: CallState[] = [
        "completed",
        "hangup-user",
        "hangup-bot",
        "timeout",
        "error",
        "failed",
        "no-answer",
        "busy",
        "voicemail",
      ];

      for (const from of terminal) {
        expect(isValidTransition(from, "initiated")).toBe(false);
        expect(isValidTransition(from, "ringing")).toBe(false);
        expect(isValidTransition(from, "active")).toBe(false);
      }
    });

    it("same state transition is invalid", () => {
      expect(isValidTransition("initiated", "initiated")).toBe(false);
      expect(isValidTransition("active", "active")).toBe(false);
    });

    it("VALID_TRANSITIONS map covers all non-terminal states", () => {
      const nonTerminal: CallState[] = [
        "initiated",
        "ringing",
        "answered",
        "active",
        "speaking",
        "listening",
      ];
      for (const state of nonTerminal) {
        expect(VALID_TRANSITIONS[state]).toBeDefined();
        expect(VALID_TRANSITIONS[state].length).toBeGreaterThan(0);
      }
    });

    it("backward transitions are invalid", () => {
      expect(isValidTransition("answered", "ringing")).toBe(false);
      expect(isValidTransition("active", "initiated")).toBe(false);
      expect(isValidTransition("speaking", "answered")).toBe(false);
    });
  });
});
