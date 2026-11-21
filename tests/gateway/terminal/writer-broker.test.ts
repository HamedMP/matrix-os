import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalWriterBroker, type TerminalWriterNative } from "../../../packages/gateway/src/terminal/writer-broker.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "t7b-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const creator = { pid: 42, uid: 501, gid: 20 }, queue: unknown[] = [], client = {}, listener = {};
  let accepted = false;
  const native: TerminalWriterNative = { listen: () => listener, accept: () => { if (accepted) return null; accepted = true; return { handle: client, creator }; },
    receive: () => queue.shift() as ReturnType<TerminalWriterNative["receive"]> ?? null, send: (_handle, bytes) => bytes.length, close: vi.fn() };
  const execute = vi.fn(async (_operation: unknown, _writer: unknown, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
  const controller = new AbortController();
  const broker = await createTerminalWriterBroker({ directory, native, signal: controller.signal,
    root: { ...creator, pid: 40, ppid: 20, start: "100" },
    readProcess: async pid => ({ ...creator, pid, ppid: pid === 42 ? 40 : 20, start: pid === 40 ? "100" : "101" }), execute });
  cleanup.push(() => broker.close());
  return { queue, creator, execute, controller, native };
}
async function until(test: () => boolean) { const end = Date.now() + 1000; while (!test()) { if (Date.now() > end) throw new Error("broker deadline"); await new Promise(resolve => setTimeout(resolve, 5)); } }
describe("Terminal broker connection lifetime (named native transport fixture)", () => {
  it.each([false, { data: Buffer.from('{}\n'), writer: { pid: 42, uid: 501, gid: 20 } }])("EOF or trailing frame aborts owner wait while parent stays live", async trailing => {
    const f = await fixture(); f.queue.push({ data: Buffer.from('{"operation":"list"}\n'), writer: f.creator });
    await until(() => f.execute.mock.calls.length === 1);
    const signal = f.execute.mock.calls[0]![2]; expect(signal.aborted).toBe(false);
    f.queue.push(trailing); await until(() => signal.aborted);
    expect(f.controller.signal.aborted).toBe(false); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("rejects identity-bearing body instead of passing it to source registration", async () => {
    const f = await fixture(); f.queue.push({ data: Buffer.from('{"operation":"list","ownerId":"fake","pid":40}\n'), writer: f.creator });
    await until(() => vi.mocked(f.native.close).mock.calls.length > 0); expect(f.execute).not.toHaveBeenCalled();
  });
});
