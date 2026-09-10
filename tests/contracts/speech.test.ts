import { describe, expect, it } from "vitest";
import {
  SpeechCapabilitiesResponseSchema,
  SpeechRequestIdSchema,
  SpeechSafeErrorResponseSchema,
  SpeechStatusResponseSchema,
  SpeechTranscriptionResponseSchema,
} from "../../packages/contracts/src/speech.js";

describe("speech contracts", () => {
  it("accepts bounded timestamped request identifiers", () => {
    expect(SpeechRequestIdSchema.parse("sp_1789056000000_abcdefghijklmnop")).toBe(
      "sp_1789056000000_abcdefghijklmnop",
    );
    expect(() => SpeechRequestIdSchema.parse("request_1")).toThrow();
    expect(() => SpeechRequestIdSchema.parse(`sp_1789056000000_${"x".repeat(65)}`)).toThrow();
  });

  it("keeps capability output provider-neutral and separates source policies", () => {
    const parsed = SpeechCapabilitiesResponseSchema.parse({
      contractVersion: 1,
      fileTranscription: {
        status: "unavailable",
        reason: "disabled",
        dictation: {
          enabled: false,
          maxBytes: 10 * 1024 * 1024,
          maxDurationMs: 120_000,
          maxTranscriptChars: 32_000,
          supportedMediaTypes: ["audio/wav"],
          languageHints: false,
        },
        ownerAudio: { enabled: false },
      },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/openai|model|key|provider/i);
  });

  it("never includes transcript content in status responses", () => {
    const parsed = SpeechStatusResponseSchema.parse({
      contractVersion: 1,
      requestId: "sp_1789056000000_abcdefghijklmnop",
      executionState: "succeeded",
      cancellationRequested: false,
      executionStarted: true,
      retrySafety: "new_request_may_consume_allowance",
      outcomeCode: "transcript",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:01.000Z",
    });
    expect(parsed).not.toHaveProperty("text");
    expect(() => SpeechStatusResponseSchema.parse({ ...parsed, text: "private transcript" })).toThrow();
  });

  it("bounds final transcript text and exposes only enumerated client errors", () => {
    expect(SpeechTranscriptionResponseSchema.parse({
      contractVersion: 1,
      requestId: "sp_1789056000000_abcdefghijklmnop",
      status: "succeeded",
      outcome: "transcript",
      text: "hello",
      audioDurationMs: 900,
    })).toMatchObject({ text: "hello" });
    expect(() => SpeechTranscriptionResponseSchema.parse({
      contractVersion: 1,
      requestId: "sp_1789056000000_abcdefghijklmnop",
      status: "succeeded",
      outcome: "transcript",
      text: "x".repeat(32_001),
      audioDurationMs: 900,
    })).toThrow();
    expect(SpeechSafeErrorResponseSchema.parse({
      error: { code: "unavailable", message: "Speech is unavailable" },
    })).toBeTruthy();
    expect(() => SpeechSafeErrorResponseSchema.parse({
      error: { code: "unavailable", message: "OpenAI key missing at /opt/matrix" },
    })).toThrow();
  });
});
