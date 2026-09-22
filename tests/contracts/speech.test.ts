import { describe, expect, it } from "vitest";
import {
  SpeechCancellationResponseSchema,
  SpeechCapabilitiesResponseSchema,
  SpeechLanguageHintsSchema,
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

  it("normalizes and bounds transcription language hints", () => {
    expect(SpeechLanguageHintsSchema.parse([" en ", "fr-CA"])).toEqual(["en", "fr-CA"]);
    expect(() => SpeechLanguageHintsSchema.parse(Array.from({ length: 9 }, () => "en"))).toThrow();
    expect(() => SpeechLanguageHintsSchema.parse(["x".repeat(36)])).toThrow();
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
      retrySafety: "terminal_no_retry_needed",
      outcomeCode: "transcript",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:01.000Z",
    });
    expect(parsed).not.toHaveProperty("text");
    expect(() => SpeechStatusResponseSchema.parse({ ...parsed, text: "private transcript" })).toThrow();
  });

  it("enforces status lifecycle invariants", () => {
    const base = {
      contractVersion: 1 as const,
      requestId: "sp_1789056000000_abcdefghijklmnop",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:01.000Z",
    };
    const valid = [
      {
        ...base,
        executionState: "received",
        cancellationRequested: false,
        executionStarted: false,
        retrySafety: "same_request_safe_before_dispatch",
        outcomeCode: null,
      },
      {
        ...base,
        executionState: "reserved",
        cancellationRequested: false,
        executionStarted: false,
        retrySafety: "same_request_safe_before_dispatch",
        outcomeCode: null,
      },
      {
        ...base,
        executionState: "dispatching",
        cancellationRequested: true,
        executionStarted: true,
        retrySafety: "new_request_may_consume_allowance",
        outcomeCode: null,
      },
      {
        ...base,
        executionState: "uncertain",
        cancellationRequested: false,
        executionStarted: true,
        retrySafety: "new_request_may_consume_allowance",
        outcomeCode: "timeout",
      },
      {
        ...base,
        executionState: "failed",
        cancellationRequested: false,
        executionStarted: true,
        retrySafety: "new_request_may_consume_allowance",
        outcomeCode: "provider_failure",
      },
      {
        ...base,
        executionState: "succeeded",
        cancellationRequested: false,
        executionStarted: true,
        retrySafety: "terminal_no_retry_needed",
        outcomeCode: "transcript",
      },
      {
        ...base,
        executionState: "cancelled",
        cancellationRequested: true,
        executionStarted: false,
        retrySafety: "terminal_no_retry_needed",
        outcomeCode: "cancelled",
      },
    ];
    for (const status of valid) expect(SpeechStatusResponseSchema.parse(status)).toEqual(status);

    const invalid = [
      { ...valid[0], executionStarted: true },
      { ...valid[1], outcomeCode: "transcript" },
      { ...valid[2], retrySafety: "terminal_no_retry_needed" },
      { ...valid[3], executionStarted: false },
      { ...valid[4], outcomeCode: null },
      { ...valid[5], retrySafety: "new_request_may_consume_allowance" },
      { ...valid[6], cancellationRequested: false },
      { ...valid[6], executionStarted: true },
    ];
    for (const status of invalid) expect(() => SpeechStatusResponseSchema.parse(status)).toThrow();
  });

  it("keeps cancellation responses consistent with the dispatch boundary", () => {
    const base = {
      contractVersion: 1 as const,
      requestId: "sp_1789056000000_abcdefghijklmnop",
      cancellationRequested: true as const,
    };
    expect(SpeechCancellationResponseSchema.parse({
      ...base,
      executionState: "cancelled",
      executionStarted: false,
    })).toBeTruthy();
    expect(SpeechCancellationResponseSchema.parse({
      ...base,
      executionState: "dispatching",
      executionStarted: true,
    })).toBeTruthy();
    expect(() => SpeechCancellationResponseSchema.parse({
      ...base,
      executionState: "cancelled",
      executionStarted: true,
    })).toThrow();
    expect(() => SpeechCancellationResponseSchema.parse({
      ...base,
      executionState: "reserved",
      executionStarted: false,
    })).toThrow();
  });

  it("keeps every advertised transcript limit round-trippable", () => {
    const maxTranscriptChars = 32_000;
    const capability = {
      contractVersion: 1 as const,
      fileTranscription: {
        status: "ready" as const,
        dictation: {
          enabled: true as const,
          maxBytes: 10 * 1024 * 1024,
          maxDurationMs: 120_000,
          maxTranscriptChars,
          supportedMediaTypes: ["audio/wav"] as const,
          languageHints: false,
        },
        ownerAudio: {
          enabled: true as const,
          maxBytes: 64 * 1024 * 1024,
          maxDurationMs: 60 * 60_000,
          maxTranscriptChars,
          supportedMediaTypes: ["audio/wav"] as const,
          languageHints: false,
        },
      },
    };
    expect(SpeechCapabilitiesResponseSchema.parse(capability)).toEqual(capability);
    for (const source of ["dictation", "ownerAudio"] as const) {
      expect(() => SpeechCapabilitiesResponseSchema.parse({
        ...capability,
        fileTranscription: {
          ...capability.fileTranscription,
          [source]: { ...capability.fileTranscription[source], maxTranscriptChars: maxTranscriptChars + 1 },
        },
      })).toThrow();
    }
    expect(SpeechTranscriptionResponseSchema.parse({
      contractVersion: 1,
      requestId: "sp_1789056000000_abcdefghijklmnop",
      status: "succeeded",
      outcome: "transcript",
      text: "x".repeat(maxTranscriptChars),
      audioDurationMs: 900,
    })).toHaveProperty("text", "x".repeat(maxTranscriptChars));
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
