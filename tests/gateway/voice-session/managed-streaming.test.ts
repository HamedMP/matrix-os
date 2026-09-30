import { describe, expect, it, vi } from "vitest";
import { createManagedVoiceSynthesisPort, probeManagedVoiceSpeechReadiness } from "../../../packages/gateway/src/speech/voice-session-ports.js";
import { createOpenAiVoiceMediaAdapter, getProvisionalRecognitionCapability } from "../../../packages/gateway/src/voice-session/openai-adapter.js";
const readyCapabilities = {
  contractVersion: 1 as const,
  fileTranscription: { status: "ready" as const, dictation: { enabled: true as const, maxBytes: 1024, maxDurationMs: 1000, maxTranscriptChars: 100, supportedMediaTypes: ["audio/wav" as const], languageHints: false }, ownerAudio: { enabled: false as const } },
  synthesis: { status: "ready" as const, maxInputChars: 4096, format: "pcm_s16le_24000_mono" as const, streaming: true },
};
describe("managed voice streaming and truthful cadence", () => {
  it("passes managed audio incrementally without completed synthesis", async () => {
    const gate = Promise.withResolvers<void>();
    const client = { synthesizeStream: vi.fn(async function* () { yield { type: "audio" as const, sequence: 0, data: "AAA=" }; await gate.promise; yield { type: "end" as const, sequence: 1, format: "pcm_s16le_24000_mono" as const, durationMs: 1 }; }) };
    const port = createManagedVoiceSynthesisPort({ client }); const iterator = port({ text: "fixture", signal: new AbortController().signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(Buffer.alloc(2)); gate.resolve(); expect((await iterator.next()).done).toBe(true);
  });
  it("does not turn an error terminal into a successful segment end", async () => {
    const port = createManagedVoiceSynthesisPort({ client: { synthesizeStream: async function* () { yield { type: "error", sequence: 0, code: "synthesis_failed" }; } } });
    await expect(port({ text: "fixture", signal: new AbortController().signal })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ kind: "unavailable" });
  });
  it("capability readiness is platform-probed, not local key presence", async () => {
    const client = { capabilities: vi.fn(async () => ({ contractVersion: 1, fileTranscription: { status: "unavailable", reason: "funding_unavailable" }, synthesis: { status: "ready" } })) } as never;
    expect(await probeManagedVoiceSpeechReadiness({ client })).toEqual({ ready: false });
    expect(await probeManagedVoiceSpeechReadiness({ client: { capabilities: async () => { throw new Error("private"); } } as never })).toEqual({ ready: false });
  });
  it("only reports ready after valid live policy intersection", async () => {
    expect(await probeManagedVoiceSpeechReadiness({ client: { capabilities: async () => readyCapabilities } })).toEqual({ ready: true });
    expect(await probeManagedVoiceSpeechReadiness({ client: { capabilities: async () => ({ ...readyCapabilities, synthesis: { status: "unavailable", reason: "funding_unavailable" } }) } })).toEqual({ ready: false });
  });
  it("requires a streaming-capable synthesis for Aoede managed readiness", async () => {
    const synthesis = { status: "ready" as const, maxInputChars: 4096, format: "pcm_s16le_24000_mono" as const };
    // A ready synthesis without the flag means completed-only payload — never streaming.
    for (const capability of [synthesis, { ...synthesis, streaming: false }]) {
      const client = { capabilities: async () => ({ ...readyCapabilities, synthesis: capability }) };
      expect(await probeManagedVoiceSpeechReadiness({ client })).toEqual({ ready: false });
    }
    expect(await probeManagedVoiceSpeechReadiness({
      client: { capabilities: async () => ({ ...readyCapabilities, synthesis: { ...synthesis, streaming: true } }) },
    })).toEqual({ ready: true });
  });
  it("aborts a stale capability probe even if the dependency ignores signal", async () => {
    const abort = new AbortController();
    const pending = probeManagedVoiceSpeechReadiness({ client: { capabilities: async () => new Promise(() => undefined) }, signal: abort.signal }); abort.abort();
    expect(await pending).toEqual({ ready: false });
  }, 1000);
  it("opt-in polling stays unavailable and emits no fabricated partials", async () => {
    const transcribe = vi.fn(async () => ({ text: "final fixture" })); const emit = vi.fn();
    const adapter = createOpenAiVoiceMediaAdapter({ provisionalRecognition: "completed_wav_polling", speech: { transcribe, synthesize: async function* () { yield Buffer.alloc(48); } } });
    expect(adapter.provisionalRecognition.status).toBe("unavailable");
    const session = await adapter.start({ sessionId: "fixture", chatId: "fixture", principalId: "fixture", turnMode: "push_to_talk", memoryMode: "normal", emit } as never);
    session.setCapture({ turnId: "fixture", mode: "push_to_talk" });
    session.pushAudio({ turnId: "fixture", timestampMs: 0, data: Buffer.alloc(32000).toString("base64") });
    expect(transcribe).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled(); session.close();
  });
  it("reports unavailable provisional polling under unqualified admission budgets", () => {
    expect(getProvisionalRecognitionCapability()).toEqual({ mode: "completed_wav_polling", status: "unavailable", reason: "admission_budget_unqualified", minCadenceMs: 2000, maxAttemptsPerUtterance: 6, maxInFlight: 1 });
  });
});
