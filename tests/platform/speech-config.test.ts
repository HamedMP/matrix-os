import { describe, expect, it } from "vitest";
import { loadPlatformSpeechConfig } from "../../packages/platform/src/speech/config.js";

const secret = "s".repeat(32);

describe("platform speech configuration", () => {
  it("is unavailable unless an operator explicitly enables it", () => {
    expect(loadPlatformSpeechConfig({})).toEqual({ enabled: false });
  });

  it("loads an explicitly priced platform-only OpenAI policy", () => {
    const config = loadPlatformSpeechConfig({
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_PROVIDER: "openai",
      PLATFORM_SPEECH_OPENAI_API_KEY: "platform-openai-key-123456",
      PLATFORM_SPEECH_MODEL: "gpt-4o-transcribe",
      PLATFORM_SPEECH_POLICY_REVISION: "speech-2026-09-10",
      PLATFORM_SPEECH_MICROUSD_PER_MINUTE: "25000",
      PLATFORM_SPEECH_FUNDING_SOURCES: "promotional,addon",
      PLATFORM_SPEECH_SECRET: secret,
      PLATFORM_SPEECH_GLOBAL_CONCURRENCY: "12",
      PLATFORM_SPEECH_OWNER_CONCURRENCY: "2",
      PLATFORM_SPEECH_OWNER_REQUESTS_PER_MINUTE: "8",
    });
    expect(config).toMatchObject({
      enabled: true,
      provider: "openai",
      apiKey: "platform-openai-key-123456",
      model: "gpt-4o-transcribe",
      policyRevision: "speech-2026-09-10",
      microusdPerMinute: 25_000,
      allowedFundingSources: ["promotional", "addon"],
      speechSecret: secret,
      admission: {
        maximumActiveOperations: 12,
        maximumActiveOperationsPerOwner: 2,
        maximumAdmissionsPerOwner: 8,
        admissionWindowMs: 60_000,
      },
      ownerAudioEnabled: true,
    });
  });

  it.each([
    ["missing platform key", { PLATFORM_SPEECH_OPENAI_API_KEY: undefined }],
    ["missing operator price", { PLATFORM_SPEECH_MICROUSD_PER_MINUTE: undefined }],
    ["implicit funding source", { PLATFORM_SPEECH_FUNDING_SOURCES: undefined }],
    ["zero real price", { PLATFORM_SPEECH_MICROUSD_PER_MINUTE: "0" }],
  ])("rejects enabled OpenAI mode with %s", (_label, changed) => {
    expect(() => loadPlatformSpeechConfig({
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_PROVIDER: "openai",
      PLATFORM_SPEECH_OPENAI_API_KEY: "platform-openai-key-123456",
      PLATFORM_SPEECH_MODEL: "gpt-4o-transcribe",
      PLATFORM_SPEECH_POLICY_REVISION: "speech-2026-09-10",
      PLATFORM_SPEECH_MICROUSD_PER_MINUTE: "25000",
      PLATFORM_SPEECH_FUNDING_SOURCES: "addon",
      PLATFORM_SPEECH_SECRET: secret,
      ...changed,
    })).toThrow("Platform speech configuration is invalid");
  });

  it("allows a labeled no-charge fixture only outside production", () => {
    expect(loadPlatformSpeechConfig({
      NODE_ENV: "development",
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_PROVIDER: "fixture",
      PLATFORM_SPEECH_FIXTURE_TRANSCRIPT: "Deterministic local transcript",
      PLATFORM_SPEECH_POLICY_REVISION: "local-fixture-1",
      PLATFORM_SPEECH_SECRET: secret,
    })).toMatchObject({
      enabled: true,
      provider: "fixture",
      fixtureTranscript: "Deterministic local transcript",
      microusdPerMinute: 0,
      fundingMode: "fixture_no_charge",
    });
    expect(() => loadPlatformSpeechConfig({
      NODE_ENV: "production",
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_PROVIDER: "fixture",
      PLATFORM_SPEECH_FIXTURE_TRANSCRIPT: "not allowed",
      PLATFORM_SPEECH_POLICY_REVISION: "local-fixture-1",
      PLATFORM_SPEECH_SECRET: secret,
    })).toThrow("Platform speech configuration is invalid");
  });
});
