import { EventEmitter, once } from "node:events";
import { PassThrough, Transform } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import { openBackgroundLaunchChannel } from "../../packages/gateway/src/background-launch-channel.js";
import { attachManagedLaunchWrapper } from "../../packages/gateway/src/coding-agents/managed-launch-wrapper.mjs";

it.each(["end", "close"] as const)("receiver %s synchronously fences the actual channel while its service client remains alive", async ending => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(), kill: vi.fn() });
  const channelPromise = openBackgroundLaunchChannel({ args: [], digest: "a".repeat(64), env: {}, spawn: () => child as unknown as ChildProcessWithoutNullStreams });
  child.stdout.write(JSON.stringify({ type: "wrapper.ready", wrapper: "00000000-0000-4000-8000-000000000001", shim: "00000000-0000-4000-8000-000000000002", digest: "a".repeat(64) }) + "\n");
  const channel = await channelPromise, revoked = vi.fn(); channel.subscribe(() => {}, revoked);
  try {
    const fenced = once(child.stdout, ending);
    if (ending === "end") child.stdout.end(); else child.stdout.destroy();
    await fenced;
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(channel.send({ type: "host.disconnect" })).toBe(false);
    channel.close(); expect(revoked).toHaveBeenCalledTimes(1);
    expect(child.stdin.writableEnded).toBe(true); expect(child.kill).not.toHaveBeenCalled();
  } finally { channel.close(); }
});

it.each(["overflow", "blocked final frame"] as const)("paired helpers fence Gateway on %s while native stdin and service ownership survive", async fault => {
  const input = new PassThrough();
  const output = new Transform({ transform(chunk: Buffer, _encoding, done) {
    if (fault === "blocked final frame" && JSON.parse(chunk.toString()).type === "wrapper.end") return; // Named stalled final write.
    this.push(chunk); done();
  } });
  let length = 0; const getLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(output)), "writableLength")?.get;
  Object.defineProperty(output, "writableLength", { configurable: true, get: () => length || getLength?.call(output) || 0 });
  const client = Object.assign(new EventEmitter(), { stdin: input, stdout: output, stderr: new PassThrough(), unref: vi.fn(), kill: vi.fn() });
  const native = Object.assign(new EventEmitter(), { connected: true, stdin: new PassThrough(), kill: vi.fn(), disconnect: vi.fn(), send: vi.fn((_frame: unknown, done: (error?: Error | null) => void) => done()) });
  // The stdio aliases also let exact prior helper bytes exercise the same connected boundary.
  const inputAlias = vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  const outputAlias = vi.spyOn(process, "stdout", "get").mockReturnValue(output as unknown as typeof process.stdout);
  let channel: Awaited<ReturnType<typeof openBackgroundLaunchChannel>> | undefined;
  let wrapper: ReturnType<typeof attachManagedLaunchWrapper> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const opening = openBackgroundLaunchChannel({ args: [], digest: "a".repeat(64), env: {}, spawn: () => client as unknown as ChildProcessWithoutNullStreams });
    wrapper = attachManagedLaunchWrapper(native, "a".repeat(64), { input, output });
    native.emit("message", { type: "shim.ready", shim: "00000000-0000-4000-8000-000000000002" });
    channel = await opening;
    const revoked = vi.fn();
    const fenced = new Promise<void>((done, reject) => {
      channel!.subscribe(() => {}, () => { revoked(); done(); });
      deadline = setTimeout(() => reject(new Error("Gateway source stayed live after wrapper transport loss")), 1000);
    });
    if (fault === "overflow") { length = 393217; native.emit("message", { type: "shim.end", admissionId: "00000000-0000-4000-8000-000000000003" }); }
    else wrapper.close();
    await fenced;
    expect(revoked).toHaveBeenCalledTimes(1); expect(output.destroyed).toBe(true);
    expect(channel.send({ type: "host.disconnect" })).toBe(false);
    wrapper.close(); native.emit("message", { type: "shim.ready", shim: "00000000-0000-4000-8000-000000000004" });
    expect(native.send.mock.calls.filter(([frame]) => (frame as { type: string }).type === "host.disconnect")).toHaveLength(1);
    expect(native.stdin.writableEnded).toBe(false); expect(native.stdin.write("ordinary native input")).toBe(true);
    expect(native.kill).not.toHaveBeenCalled(); expect(native.disconnect).not.toHaveBeenCalled(); expect(client.kill).not.toHaveBeenCalled();
  } finally { clearTimeout(deadline); channel?.close(); wrapper?.close(); output.destroy(); input.destroy(); native.stdin.destroy(); inputAlias.mockRestore(); outputAlias.mockRestore(); }
});
