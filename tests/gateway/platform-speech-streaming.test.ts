import { describe, expect, it, vi } from "vitest";
import { createPlatformSpeechClient } from "../../packages/gateway/src/speech/platform-client.js";
const config = { baseUrl: "https://platform.internal/internal/containers/fixture/speech", runtimeAuthToken: "r".repeat(64), identity: { ownerId: "fixture", machineId: "fixture", runtimeSlot: "primary" }, requestOwnerId: "fixture", requestTimeoutMs: 65000 };
const input = { requestId: "sp_1790726400000_abcdefghijklmnop", text: "fixture", signal: new AbortController().signal };
const audio = { type: "audio", sequence: 0, data: "AAA=" };
const end = { type: "end", sequence: 1, format: "pcm_s16le_24000_mono", durationMs: 1 };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
function clientFor(body: ReadableStream<Uint8Array>, dependencies = {}) { return createPlatformSpeechClient(config, { fetchFn: vi.fn(async () => new Response(body, { headers: { "content-type": "application/x-ndjson" } })), ...dependencies }); }
async function collect(client: ReturnType<typeof clientFor>) { const frames = []; for await (const frame of client.synthesizeStream(input)) frames.push(frame); return frames; }
describe("platform speech stream reader", () => {
  it("yields a split NDJSON audio line before HTTP completion with runtime-only auth", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const bytes = encode(audio);
    const fetchFn = vi.fn(async (_url, init) => { expect(init.headers.authorization).toBe(`Bearer ${config.runtimeAuthToken}`); expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal); return new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(bytes.subarray(0, 5)); c.enqueue(bytes.subarray(5)); } }), { headers: { "content-type": "application/x-ndjson" } }); });
    const client = createPlatformSpeechClient(config, { fetchFn }); const iterator = client.synthesizeStream(input)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(audio);
    expect(String(fetchFn.mock.calls[0]![0])).toContain("/syntheses/stream?runtimeSlot=primary");
    controller.enqueue(encode(end)); controller.close(); expect((await iterator.next()).value).toEqual(end); expect((await iterator.next()).done).toBe(true);
  });
  it.each([
    [audio], [audio, { ...end, sequence: 2 }], [audio, { ...end, durationMs: 9 }],
    [{ type: "error", sequence: 0, code: "synthesis_failed" }, end],
    [{ ...audio, data: "AA==" }, end], [{ ...audio, private: "secret" }, end],
  ])("rejects incomplete, discontinuous or malformed streams %#", async (...frames) => {
    const client = clientFor(new ReadableStream({ start(c) { for (const frame of frames) c.enqueue(encode(frame)); c.close(); } }));
    await expect(collect(client)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects oversized lines and cancels reader", async () => {
    const cancel = vi.fn(); const client = clientFor(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(96 * 1024 + 1).fill(32)); }, cancel }));
    await expect(collect(client)).rejects.toMatchObject({ code: "invalid_response" }); expect(cancel).toHaveBeenCalled();
  });
  it("aborts a stalled body read even when the fake fetch ignores signal", async () => {
    const deadline = new AbortController(); const cancel = vi.fn();
    const client = clientFor(new ReadableStream({ cancel }), { makeTimeoutSignal: () => deadline.signal });
    const work = collect(client); await Promise.resolve(); deadline.abort();
    await expect(work).rejects.toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalled();
  });
  it("bounds total decoded PCM independently of line/wire bytes", async () => {
    const data = Buffer.alloc(65536).toString("base64");
    const client = clientFor(new ReadableStream({ start(c) { for (let sequence = 0; sequence < 129; sequence++) c.enqueue(encode({ type: "audio", sequence, data })); c.close(); } }));
    await expect(collect(client)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("accepts the exact chunk boundary and a coarse safe error terminal", async () => {
    const frames = [{ ...audio, data: Buffer.alloc(65536).toString("base64") }, { type: "error", sequence: 1, code: "synthesis_failed" }];
    const client = clientFor(new ReadableStream({ start(c) { frames.forEach(frame => c.enqueue(encode(frame))); c.close(); } }));
    expect(await collect(client)).toEqual(frames);
  });
  it("bounds a stalled non-2xx response body with the same deadline", async () => {
    const deadline = new AbortController(); const cancel = vi.fn();
    const client = createPlatformSpeechClient(config, { makeTimeoutSignal: () => deadline.signal, fetchFn: vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 })) });
    const work = collect(client); await Promise.resolve(); deadline.abort();
    await expect(work).rejects.toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalled();
  }, 1000);
  it("keeps the streaming readiness flag through the strict capabilities schema", async () => {
    const payload = {
      contractVersion: 1,
      fileTranscription: {
        status: "unavailable", reason: "disabled",
        dictation: { enabled: false, maxBytes: 1_024, maxDurationMs: 1_000, maxTranscriptChars: 100, supportedMediaTypes: ["audio/wav"], languageHints: false },
        ownerAudio: { enabled: false },
      },
      synthesis: { status: "ready", maxInputChars: 4096, format: "pcm_s16le_24000_mono", streaming: true },
    };
    const client = createPlatformSpeechClient(config, {
      fetchFn: vi.fn(async () => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })),
    });
    expect(await client.capabilities()).toEqual(payload);
  });
  it("cancels upstream on consumer return", async () => {
    const cancel = vi.fn(); const client = clientFor(new ReadableStream({ start(c) { c.enqueue(encode(audio)); }, cancel }));
    const iterator = client.synthesizeStream(input)[Symbol.asyncIterator](); await iterator.next(); await iterator.return!(); expect(cancel).toHaveBeenCalled();
  });
});
