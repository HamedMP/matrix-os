import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { loadPlatformSpeechConfig } from "../../packages/platform/src/speech/config.js";
import { createConfiguredPlatformSpeechService } from "../../packages/platform/src/speech/wiring.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

function oneSecondWav(): Uint8Array {
  const samples = 16_000;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

describe("platform speech startup wiring", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: "machine_123",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      status: "running",
      imageVersion: "v1",
      provisionedAt: "2026-09-09T00:00:00.000Z",
      activationState: "authorized",
    });
  });

  afterEach(async () => destroyTestPlatformDb(db));

  it("keeps disabled startup coarse and provider-neutral", () => {
    const service = createConfiguredPlatformSpeechService({ db, config: { enabled: false } });
    expect(service.capabilities().fileTranscription).toMatchObject({
      status: "unavailable",
      reason: "disabled",
    });
  });

  it("runs the labeled local fixture through durable admission without a paid wallet", async () => {
    const config = loadPlatformSpeechConfig({
      NODE_ENV: "development",
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_PROVIDER: "fixture",
      PLATFORM_SPEECH_FIXTURE_TRANSCRIPT: "Deterministic local transcript",
      PLATFORM_SPEECH_POLICY_REVISION: "local-fixture-1",
      PLATFORM_SPEECH_SECRET: "s".repeat(32),
    });
    const service = createConfiguredPlatformSpeechService({ db, config });
    expect(service.capabilities().fileTranscription).toMatchObject({
      status: "ready",
      ownerAudio: { enabled: true },
    });
    await expect(service.transcribe({
      identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      requestId: `sp_${Date.now()}_abcdefghijklmnop`,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      outcome: "transcript",
      text: "Deterministic local transcript",
    });
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([]);
    await service.shutdown();
  });

  it("runs preview-only OpenAI transcription without creating wallet entries", async () => {
    const config = loadPlatformSpeechConfig({
      NODE_ENV: "production",
      PLATFORM_PREVIEW: "true",
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_PROVIDER: "openai",
      PLATFORM_SPEECH_OPENAI_API_KEY: "platform-openai-key-123456",
      PLATFORM_SPEECH_MODEL: "gpt-4o-mini-transcribe",
      PLATFORM_SPEECH_POLICY_REVISION: "preview-speech-1",
      PLATFORM_SPEECH_SECRET: "s".repeat(32),
      PLATFORM_SPEECH_PREVIEW_NO_CHARGE: "true",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "Preview transcript" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const service = createConfiguredPlatformSpeechService({ db, config, fetchImpl });
    await expect(service.transcribe({
      identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      requestId: `sp_${Date.now()}_previewtranscript`,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "transcript", text: "Preview transcript" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute()).toEqual([]);
    await service.shutdown();
  });
});
