import { describe, expect, it, vi } from "vitest";
import { SpeechSynthesisStreamFrameSchema } from "@matrix-os/contracts";
import { createPlatformSpeechService, type PlatformSpeechService } from "../../packages/platform/src/speech/service.js";
import { createOpenAiSpeechSynthesisAdapter } from "../../packages/platform/src/speech/adapters/openai.js";
import { SpeechFundingError } from "../../packages/platform/src/speech/funding.js";
import type { SpeechOperationRecord, SpeechOperationsRepository } from "../../packages/platform/src/speech/operations.js";
import { Hono } from "hono";
import { createSpeechRuntimeRoutes } from "../../packages/platform/src/speech/routes.js";
import { buildPlatformSpeechRuntimeVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createPlatformSpeechClient } from "../../packages/gateway/src/speech/platform-client.js";

vi.mock("../../packages/platform/src/db.js", () => ({
  getRunningUserMachineByHandle: vi.fn(async (_db, handle, slot) => handle === "fixture" && slot === "primary"
    ? { machineId: "fixture_machine", clerkUserId: "fixture_owner", runtimeSlot: "primary", runtimeTokenEpoch: 1 } : undefined),
}));

const identity = { ownerId: "fixture_owner", machineId: "fixture_machine", runtimeSlot: "primary" };
const requestId = "sp_1790726400000_abcdefghijklmnop";
const input = { identity, requestId, text: "Fixture speech", signal: new AbortController().signal };
function fixture(stream?: (input: { text: string; signal: AbortSignal }) => AsyncIterable<Uint8Array>) {
  let row: SpeechOperationRecord | undefined;
  const trx = {} as never;
  const funding = {
    reserve: vi.fn(async () => ({ reservationId: "fixture_hold", reservedMicrousd: 600 })),
    start: vi.fn(async () => undefined), settle: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
  };
  const operations = {
    admitSynthesis: vi.fn(async (_input, reserve) => {
      if (!row) { const hold = await reserve(trx); row = { ...hold, identity, requestId, executionState: "reserved", cancellationRequested: false, executionStarted: false, reservedMicrousd: 600 } as unknown as SpeechOperationRecord; }
      return row;
    }),
    claimDispatch: vi.fn(async (_identity, _requestId, start) => {
      if (row!.executionState !== "reserved") return { claimed: false, operation: row! };
      await start(trx, "fixture_hold"); row!.executionState = "dispatching"; row!.executionStarted = true;
      return { claimed: true, operation: row! };
    }),
    get: vi.fn(async () => row),
    complete: vi.fn(async (_identity, _requestId, completion, settle) => {
      await settle(trx, "fixture_hold", completion.actualCostMicrousd); Object.assign(row!, completion); return row!;
    }),
    cancel: vi.fn(async () => { row!.cancellationRequested = true; return row!; }),
    sweepExpired: vi.fn(async () => 0),
  } as unknown as SpeechOperationsRepository;
  const synthesisAdapter = {
    id: "fixture",
    synthesize: vi.fn(async () => new Uint8Array(48)),
    ...(stream ? { stream: vi.fn(stream) } : {}),
  };
  const service = createPlatformSpeechService({ operations, funding, adapter: { id: "fixture", transcribe: async () => ({ text: "fixture" }) }, synthesisAdapter, fingerprintSecret: "f".repeat(32), policy: {
    enabled: true, revision: "fixture-1", modelId: "fixture", microusdPerMinute: 60,
    dictation: { enabled: true, maxBytes: 1024, maxDurationMs: 1000, maxTranscriptChars: 100, supportedMediaTypes: ["audio/wav"], languageHints: false }, ownerAudio: { enabled: false },
    synthesis: { enabled: true, modelId: "fixture", microusdPerMinute: 60, maxInputChars: 4096, maxDurationMs: 600000 },
  } });
  return { service, funding, synthesisAdapter, operations };
}
async function collect(service: PlatformSpeechService) { const frames = []; for await (const frame of service.synthesizeStream(input)) frames.push(frame); return frames; }

describe("managed streaming synthesis", () => {
  it("strictly bounds PCM frames and safe terminal vocabulary", () => {
    for (const frame of [ { type: "audio", sequence: 0, data: "AAA=" }, { type: "end", sequence: 1, format: "pcm_s16le_24000_mono", durationMs: 1 }, { type: "error", sequence: 1, code: "synthesis_failed" } ]) expect(SpeechSynthesisStreamFrameSchema.safeParse(frame).success).toBe(true);
    for (const frame of [ { type: "audio", sequence: 0, data: "AA==" }, { type: "audio", sequence: 0, data: Buffer.alloc(65538).toString("base64") }, { type: "audio", sequence: Number.MAX_SAFE_INTEGER + 1, data: "AAA=" }, { type: "audio", sequence: 0, data: "AAB=" }, { type: "error", sequence: 0, code: "private_error" }, { type: "end", sequence: 0, format: "pcm_s16le_24000_mono", durationMs: 600001 }, { type: "audio", sequence: 0, data: "AAA=", key: "secret" } ]) expect(SpeechSynthesisStreamFrameSchema.safeParse(frame).success).toBe(false);
  });
  it("yields provider audio before provider completion, settles once and never replays", async () => {
    const gate = Promise.withResolvers<void>();
    const { service, funding, synthesisAdapter } = fixture(async function* () { yield new Uint8Array(48); await gate.promise; yield new Uint8Array(48); });
    try {
      const iterator = service.synthesizeStream(input)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: "audio", sequence: 0 });
      expect(funding.settle).not.toHaveBeenCalled();
      gate.resolve(); expect((await iterator.next()).value).toMatchObject({ type: "audio", sequence: 1 });
      expect((await iterator.next()).value).toEqual({ type: "end", sequence: 2, format: "pcm_s16le_24000_mono", durationMs: 2 });
      await iterator.next();
      expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "fixture_hold", { mode: "exact", actualCostMicrousd: 1 });
      expect(await collect(service)).toEqual([{ type: "error", sequence: 0, code: "request_conflict" }]);
      expect(synthesisAdapter.stream).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); await service.shutdown(); }
  });
  it("conservatively settles partial failure and never sends end after error", async () => {
    const { service, funding } = fixture(async function* () { yield new Uint8Array(48); throw new Error("private provider failure"); });
    try { expect(await collect(service)).toEqual([{ type: "audio", sequence: 0, data: Buffer.alloc(48).toString("base64") }, { type: "error", sequence: 1, code: "synthesis_failed" }]); expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "fixture_hold", { mode: "conservative" }); } finally { await service.shutdown(); }
  });
  it("conservatively settles consumer return and aborts provider", async () => {
    let providerSignal: AbortSignal | undefined;
    const { service, funding } = fixture(async function* (request) { providerSignal = request.signal; yield new Uint8Array(48); yield new Uint8Array(48); });
    try { const iterator = service.synthesizeStream(input)[Symbol.asyncIterator](); await iterator.next(); await iterator.return!(); expect(providerSignal?.aborted).toBe(true); expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "fixture_hold", { mode: "conservative" }); } finally { await service.shutdown(); }
  });
  it("preserves the completed sibling and shares its non-replayable operation", async () => {
    const { service, funding, synthesisAdapter } = fixture(async function* () { yield new Uint8Array(48); });
    try {
      expect(await service.synthesize(input)).toMatchObject({ status: "succeeded", durationMs: 1, audio: Buffer.alloc(48).toString("base64") });
      expect(await collect(service)).toEqual([{ type: "error", sequence: 0, code: "request_conflict" }]);
      expect(synthesisAdapter.stream).not.toHaveBeenCalled(); expect(funding.reserve).toHaveBeenCalledTimes(1);
    } finally { await service.shutdown(); }
  });
  it("does not let a concurrent duplicate settle the in-flight winner", async () => {
    const { service, funding } = fixture(async function* () { yield new Uint8Array(48); yield new Uint8Array(48); });
    try {
      const winner = service.synthesizeStream(input)[Symbol.asyncIterator](); await winner.next();
      expect(await collect(service)).toEqual([{ type: "error", sequence: 0, code: "request_conflict" }]);
      expect(funding.settle).not.toHaveBeenCalled(); await winner.return!(); expect(funding.settle).toHaveBeenCalledTimes(1);
    } finally { await service.shutdown(); }
  });
  it.each([0, 1, 8 * 1024 * 1024 + 2])("conservatively rejects invalid provider PCM size %i", async (bytes) => {
    const { service, funding } = fixture(async function* () { yield new Uint8Array(bytes); });
    try { expect(await collect(service)).toEqual([{ type: "error", sequence: 0, code: "synthesis_failed" }]); expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "fixture_hold", { mode: "conservative" }); }
    finally { await service.shutdown(); }
  });
  it("settles claimed uncertainty even if the reconciliation read fails", async () => {
    const { service, funding, operations } = fixture(async function* () { throw new Error("fixture failure"); });
    vi.mocked(operations.get).mockResolvedValueOnce({ cancellationRequested: false } as SpeechOperationRecord).mockRejectedValueOnce(new Error("fixture DB timeout"));
    try { expect(await collect(service)).toEqual([{ type: "error", sequence: 0, code: "synthesis_failed" }]); expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "fixture_hold", { mode: "conservative" }); }
    finally { await service.shutdown(); }
  });
  it("propagates caller abort during provider reading and conservatively settles", async () => {
    const caller = new AbortController();
    const { service, funding } = fixture(async function* (request) {
      yield new Uint8Array(48);
      await new Promise<void>((_resolve, reject) => { request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }); if (request.signal.aborted) reject(request.signal.reason); });
    });
    try {
      const iterator = service.synthesizeStream({ ...input, signal: caller.signal })[Symbol.asyncIterator](); await iterator.next();
      const pending = iterator.next(); caller.abort(); expect((await pending).value).toMatchObject({ type: "error", sequence: 1, code: "cancelled" }); await iterator.next();
      expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "fixture_hold", { mode: "conservative" }); expect(funding.release).not.toHaveBeenCalled();
    } finally { await service.shutdown(); }
  });
  it("mounts authenticated bounded sibling and streams through gateway before EOF", async () => {
    const gate = Promise.withResolvers<void>();
    const { service, funding } = fixture(async function* () { yield new Uint8Array(48); await gate.promise; yield new Uint8Array(48); });
    const platformSecret = "fixture-secret".repeat(4);
    const app = new Hono().route("/internal/containers/:handle/speech", createSpeechRuntimeRoutes({ db: {} as never, platformSecret, service }));
    const token = buildPlatformSpeechRuntimeVerificationToken({ handle: "fixture", machineId: identity.machineId, runtimeSlot: "primary" }, platformSecret, 1);
    const baseUrl = "https://platform.internal/internal/containers/fixture/speech";
    const client = createPlatformSpeechClient({ baseUrl, identity, runtimeAuthToken: token, requestOwnerId: identity.ownerId, requestTimeoutMs: 65000 }, { fetchFn: async (url, init) => app.request(new Request(url, init)) });
    try {
      expect((await app.request(`${baseUrl}/syntheses/stream?runtimeSlot=primary`, { method: "POST", body: JSON.stringify({ requestId, text: "fixture" }) })).status).toBe(401);
      expect((await app.request(`${baseUrl}/syntheses/stream?runtimeSlot=primary`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "x".repeat(20 * 1024 + 1) })).status).toBe(413);
      const iterator = client.synthesizeStream(input)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: "audio", sequence: 0 }); expect(funding.settle).not.toHaveBeenCalled();
      gate.resolve(); expect((await iterator.next()).value).toMatchObject({ type: "audio", sequence: 1 }); expect((await iterator.next()).value).toMatchObject({ type: "end", durationMs: 2 }); await iterator.next();
      expect(funding.reserve).toHaveBeenCalledTimes(1); expect(funding.start).toHaveBeenCalledTimes(1); expect(funding.settle).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); await service.shutdown(); }
  });
  it("HTTP consumer cancellation aborts provider and conservatively finalizes", async () => {
    const { service, funding } = fixture(async function* (request) {
      yield new Uint8Array(48);
      await new Promise<void>((_resolve, reject) => { request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }); if (request.signal.aborted) reject(request.signal.reason); });
    });
    const secret = "f".repeat(32); const token = buildPlatformSpeechRuntimeVerificationToken({ handle: "fixture", machineId: identity.machineId, runtimeSlot: "primary" }, secret, 1);
    const app = new Hono().route("/internal/containers/:handle/speech", createSpeechRuntimeRoutes({ db: {} as never, platformSecret: secret, service }));
    try {
      const response = await app.request("/internal/containers/fixture/speech/syntheses/stream?runtimeSlot=primary", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ requestId, text: input.text }) });
      expect(response.headers.get("cache-control")).toContain("no-store");
      const reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false); await reader.cancel();
      expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "fixture_hold", { mode: "conservative" });
    } finally { await service.shutdown(); }
  });
  it("drains a paused consumer on shutdown without waiting for another pull", async () => {
    const { service, funding } = fixture(async function* () { yield new Uint8Array(48); yield new Uint8Array(48); });
    const iterator = service.synthesizeStream(input)[Symbol.asyncIterator](); await iterator.next();
    await service.shutdown();
    expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "fixture_hold", { mode: "conservative" });
    expect((await iterator.next()).value).toMatchObject({ type: "error", code: "cancelled" }); await iterator.next();
  }, 1000);
  it("never calls the provider without funding admission", async () => {
    const { service, funding, synthesisAdapter } = fixture(async function* () { yield new Uint8Array(48); });
    funding.reserve.mockRejectedValueOnce(new SpeechFundingError("allowance_exhausted"));
    try {
      expect(await collect(service)).toEqual([{ type: "error", sequence: 0, code: "allowance_exhausted" }]);
      expect(synthesisAdapter.stream).not.toHaveBeenCalled(); expect(funding.start).not.toHaveBeenCalled(); expect(funding.settle).not.toHaveBeenCalled();
    } finally { await service.shutdown(); }
  });
  it("rejects claimed invalid media without exposing provider errors", async () => {
    const adapter = createOpenAiSpeechSynthesisAdapter({ apiKey: "fixture-not-a-key-0000", model: "fixture", voice: "fixture", fetchImpl: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) });
    const iterator = adapter.stream!({ text: "fixture", signal: new AbortController().signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(new Uint8Array([1, 2]));
    await expect(iterator.next()).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("aborts a stalled provider body and cancels its reader", async () => {
    const cancel = vi.fn(); const caller = new AbortController();
    const adapter = createOpenAiSpeechSynthesisAdapter({ apiKey: "fixture-not-a-key-0000", model: "fixture", voice: "fixture", fetchImpl: vi.fn(async () => new Response(new ReadableStream({ cancel }))) });
    const iterator = adapter.stream!({ text: "fixture", signal: caller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next(); await Promise.resolve(); caller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" }); expect(cancel).toHaveBeenCalled();
  });
  it("reports streaming readiness only when the adapter exposes a real stream", async () => {
    const { service } = fixture(async function* () { yield new Uint8Array(48); });
    try {
      expect(service.capabilities().synthesis).toEqual({
        status: "ready", maxInputChars: 4096, format: "pcm_s16le_24000_mono", streaming: true,
      });
    } finally { await service.shutdown(); }
  });
  it("reports a completed-only adapter as non-streaming and refuses the stream endpoint", async () => {
    const { service, synthesisAdapter, funding } = fixture();
    try {
      expect(synthesisAdapter.stream).toBeUndefined();
      expect(service.capabilities().synthesis).toEqual({
        status: "ready", maxInputChars: 4096, format: "pcm_s16le_24000_mono", streaming: false,
      });
      // The completed sibling still works; only the stream endpoint is refused.
      expect(await service.synthesize(input)).toMatchObject({ status: "succeeded", durationMs: 1 });
      const frames: unknown[] = [];
      for await (const frame of service.synthesizeStream({ ...input, requestId: "sp_1790726400001_abcdefghijklmnop" })) frames.push(frame);
      expect(frames).toEqual([{ type: "error", sequence: 0, code: "unavailable" }]);
      expect(funding.settle).toHaveBeenCalledTimes(1);
    } finally { await service.shutdown(); }
  });
  it("reads aligned provider bytes incrementally (including odd network boundaries)", async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const adapter = createOpenAiSpeechSynthesisAdapter({ apiKey: "fixture-not-a-key-0000", model: "fixture", voice: "fixture", fetchImpl: vi.fn(async () => new Response(new ReadableStream({ start(controller) { body = controller; controller.enqueue(new Uint8Array([1, 2, 3])); } }))) });
    const iterator = adapter.stream!({ text: "fixture", signal: new AbortController().signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(new Uint8Array([1, 2]));
    body.enqueue(new Uint8Array([4])); body.close();
    expect((await iterator.next()).value).toEqual(new Uint8Array([3, 4])); expect((await iterator.next()).done).toBe(true);
  });
});
