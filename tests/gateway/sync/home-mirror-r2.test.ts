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
