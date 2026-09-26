import { expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createMirrorR2 } from "../../../packages/gateway/src/sync/home-mirror-r2.js";
import { createFakeR2 } from "./fixtures/home-mirror-storage.js";

it("bounds native-style transform bodies while retaining their stream methods", async () => {
  const controller = new AbortController(); const r2 = createFakeR2();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const body = Readable.from((async function* () { await pending; yield Buffer.from("synthetic"); })()) as Readable & { transformToByteArray(): Promise<Uint8Array> };
  body.transformToByteArray = async function () {
    const parts: Buffer[] = []; for await (const chunk of this) parts.push(Buffer.from(chunk)); return Buffer.concat(parts);
  };
  r2.getObject = async () => ({ body: body as unknown as ReadableStream });
  const wrapped = createMirrorR2(r2, () => controller.signal);
  try {
    const result = await wrapped.getObject("synthetic");
    const transformed = result.body as unknown as typeof body;
    expect(typeof transformed[Symbol.asyncIterator]).toBe("function");
    const observed = transformed.transformToByteArray().catch(error => error);
    controller.abort(new Error("synthetic deadline"));
    const winner = await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve("stalled"), 50))]);
    expect(winner).toBe(controller.signal.reason);
    expect(body.destroyed).toBe(true);
    release(); await observed;
  } finally { release(); body.destroy(); }
});

it("preserves existing default API deadlines alongside lifecycle cancellation", async () => {
  const controller = new AbortController(); const r2 = createFakeR2(); r2.store.set("synthetic", Buffer.from("bytes"));
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    const wrapped = createMirrorR2(r2, () => controller.signal);
    await wrapped.getObject("synthetic"); await wrapped.putObject("synthetic", Buffer.from("bytes"));
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([10_000, 30_000]);
  } finally { timeout.mockRestore(); controller.abort(); }
});

it("enforces default deadlines even when a caller supplies its own non-aborted signal", async () => {
  const lifecycle = new AbortController(); const caller = new AbortController();
  const r2 = createFakeR2(); r2.store.set("synthetic", Buffer.from("bytes"));
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    const wrapped = createMirrorR2(r2, () => lifecycle.signal);
    await wrapped.getObject("synthetic", { signal: caller.signal });
    await wrapped.putObject("synthetic", Buffer.from("bytes"), { signal: caller.signal });
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([10_000, 30_000]);
  } finally { timeout.mockRestore(); lifecycle.abort(); caller.abort(); }
});

it("cancels a web reader when the getObject deadline expires after headers", async () => {
  const lifecycle = new AbortController(); const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let cancelled = false; let release!: () => void;
  const pending = new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => { release = () => resolve({ done: true, value: undefined }); });
  const r2 = createFakeR2();
  r2.getObject = async () => ({ body: { getReader: () => ({ read: () => pending, cancel: async () => { cancelled = true; }, releaseLock: () => {} }) } as unknown as ReadableStream });
  try {
    const result = await createMirrorR2(r2, () => lifecycle.signal).getObject("synthetic");
    const reader = result.body!.getReader(); const reading = reader.read().catch(error => error);
    deadline.abort(new Error("synthetic deadline"));
    expect(await Promise.race([reading, new Promise(resolve => setTimeout(() => resolve("stalled"), 100))])).toBe(deadline.signal.reason);
    expect(cancelled).toBe(true);
    reader.releaseLock(); release(); await reading;
  } finally { release(); timeout.mockRestore(); lifecycle.abort(); }
});
