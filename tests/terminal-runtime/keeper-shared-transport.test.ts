import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

const digest = "a".repeat(64), nonce = "b".repeat(64);
const keeper = "00000000-0000-4000-8000-000000000001", channelId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const closeOwned: Array<() => void> = [];
afterEach(() => { for (const close of closeOwned.splice(0)) close(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function loadShared() {
  const path = resolve("packages/terminal-runtime/src/held-launch-channel.ts");
  return import(/* @vite-ignore */ path) as Promise<typeof import("../../packages/terminal-runtime/src/held-launch-channel.js")>;
}
async function loadWorkspace() {
  const path = resolve("packages/terminal-runtime/src/workspace-launch-protocol.ts");
  return import(/* @vite-ignore */ path) as Promise<typeof import("../../packages/terminal-runtime/src/workspace-launch-protocol.js")>;
}
function fixture() {
  // Named stream-only systemd relay fixture, not manager/kernel/source proof.
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(), kill: vi.fn() });
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  closeOwned.push(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  return { child, spawn, send(value: unknown) { child.stdout.write(JSON.stringify(value) + "\n"); } };
}
const ready = () => ({ v: 1 as const, type: "workspace.keeper.ready" as const, keeper, channel: channelId, digest });
const fenced = () => ({ v: 1 as const, type: "workspace.fenced" as const, requestId, nonce, outcome: "unknown" as const });
async function workspaceChannel(options: { startReady?: boolean } = {}) {
  const module = await loadWorkspace(), f = fixture();
  const pending = module.openWorkspaceLaunchChannel({ args: ["--user", "--pipe"], env: {}, digest, spawn: f.spawn });
  pending.catch(() => {});
  if (options.startReady !== false) f.send(ready());
  return { f, pending };
}

describe("shared anonymous held-launch transport", () => {
  it("accepts an explicit strict non-managed handshake and returns its own validated reply", async () => {
    const module = await loadShared(), f = fixture();
    const hello = z.object({ type: z.literal("other.ready"), digest: z.string().length(64), epoch: z.string().uuid() }).strict();
    const host = z.object({ type: z.literal("other.host.ready"), epoch: z.string().uuid(), digest: z.string().length(64) }).strict();
    const child = z.union([hello, z.object({ type: z.literal("other.end") }).strict(), z.object({ type: z.literal("other.data"), text: z.string().max(32) }).strict()]);
    const pending = module.openHeldLaunchChannel({ args: ["--pipe"], env: {}, digest, spawn: f.spawn }, {
      hostSchema: host, childSchema: child,
      handshakeSchema: hello.transform(frame => ({ generation: frame.epoch, digest: frame.digest, reply: { ...frame, type: "other.host.ready" as const } })),
      readyTypes: ["other.ready"], endTypes: ["other.end"],
    });
    pending.catch(() => {}); f.send({ type: "other.ready", digest, epoch: keeper });
    const channel = await pending; closeOwned.push(() => channel.close());
    expect(channel.generation).toBe(keeper);
    expect(JSON.parse(f.child.stdin.read().toString())).toEqual({ type: "other.host.ready", digest, epoch: keeper });
    expect(f.spawn).toHaveBeenCalledWith("/usr/bin/systemd-run", ["--pipe"], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const receive = vi.fn(); channel.subscribe(receive, vi.fn());
    const utf8 = Buffer.from(JSON.stringify({ type: "other.data", text: "雪🌊" }) + "\n"), split = utf8.indexOf(Buffer.from("雪")) + 1;
    f.child.stdout.write(utf8.subarray(0, split)); f.child.stdout.write(utf8.subarray(split, split + 3)); f.child.stdout.write(utf8.subarray(split + 3));
    expect(receive).toHaveBeenCalledWith({ type: "other.data", text: "雪🌊" });
  });

  it("uses workspace's distinct first-frame schema rather than ManagedShimFrameSchema", async () => {
    const { f, pending } = await workspaceChannel(); const channel = await pending; closeOwned.push(() => channel.close());
    expect(channel.generation).toBe(`${keeper}:${channelId}`);
    expect(JSON.parse(f.child.stdin.read().toString())).toEqual({ ...ready(), type: "workspace.host.ready" });
    const receive = vi.fn(); channel.subscribe(receive, vi.fn()); f.send(fenced());
    expect(receive).toHaveBeenCalledWith(fenced());
  });

  it.each(["digest", "first application frame", "managed first frame"])("rejects %s without service stop/retry", async failure => {
    const { f, pending } = await workspaceChannel({ startReady: false });
    if (failure === "digest") f.send({ ...ready(), digest: "c".repeat(64) });
    else if (failure === "first application frame") f.send(fenced());
    else f.send({ type: "wrapper.ready", wrapper: keeper, shim: channelId, digest });
    expect(f.child.stdin.writableEnded).toBe(true); // Refusal, not eventual startup timeout.
    await expect(pending).rejects.toThrow("Private launch unavailable");
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.child.kill).not.toHaveBeenCalled(); expect(f.child.stdin.writableEnded).toBe(true);
  });

  it("decodes fragmented/coalesced workspace frames without changing the original byte limit", async () => {
    const { f, pending } = await workspaceChannel({ startReady: false }); const raw = Buffer.from(JSON.stringify(ready()) + "\n");
    f.child.stdout.write(raw.subarray(0, 17)); f.child.stdout.write(raw.subarray(17));
    const channel = await pending; closeOwned.push(() => channel.close()); const receive = vi.fn(); channel.subscribe(receive, vi.fn());
    f.child.stdout.write(JSON.stringify(fenced()) + "\n" + JSON.stringify({ ...fenced(), type: "workspace.fenced" }) + "\n");
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it.each(["end", "close", "exit", "error", "stderr cap", "frame cap", "bad json"])("fences %s before ready", async event => {
    const { f, pending } = await workspaceChannel({ startReady: false });
    if (event === "stderr cap") f.child.stderr.write(Buffer.alloc(16385));
    else if (event === "frame cap") f.child.stdout.write(Buffer.alloc(196609, 0x20));
    else if (event === "bad json") f.child.stdout.write("{oops}\n");
    else if (event === "exit" || event === "error") f.child.emit(event, event === "error" ? new Error("fixture") : 0);
    else f.child.stdout.emit(event);
    expect(f.child.stdin.writableEnded).toBe(true); // Immediate cap/error fence.
    await expect(pending).rejects.toThrow("Private launch unavailable"); expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("keeps the original ten-second startup limit", async () => {
    vi.useFakeTimers(); const { pending, f } = await workspaceChannel({ startReady: false });
    await vi.advanceTimersByTimeAsync(10000); await expect(pending).rejects.toThrow("Private launch unavailable"); expect(f.child.stdin.writableEnded).toBe(true);
  });

  it("bounds four subscribers, detaches, isolates failure and closes once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { f, pending } = await workspaceChannel(); const channel = await pending; const closes = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const detach = channel.subscribe(vi.fn(), closes[0]);
    for (let index = 1; index < 4; index++) channel.subscribe(index === 1 ? () => { throw new Error("fixture"); } : vi.fn(), closes[index]);
    expect(() => channel.subscribe(vi.fn(), vi.fn())).toThrow("Private launch unavailable"); detach();
    const extraClose = vi.fn(); channel.subscribe(vi.fn(), extraClose); f.send(fenced()); channel.close();
    expect(closes[0]).not.toHaveBeenCalled(); for (const close of closes.slice(1)) expect(close).toHaveBeenCalledOnce(); expect(extraClose).toHaveBeenCalledOnce();
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it.each(["repeated ready", "end", "invalid send", "backpressure"])("closes %s after ready without implicit stop", async reason => {
    const { f, pending } = await workspaceChannel(); const channel = await pending; const close = vi.fn(); channel.subscribe(vi.fn(), close);
    if (reason === "repeated ready") f.send(ready());
    else if (reason === "end") f.send({ v: 1, type: "workspace.end" });
    else if (reason === "invalid send") expect(channel.send({ v: 1, type: "workspace.disconnect", ownerId: "forged" } as never)).toBe(false);
    else { Object.defineProperty(f.child.stdin, "writableLength", { value: 196608 * 2 + 1 }); expect(channel.send({ v: 1, type: "workspace.disconnect" })).toBe(false); }
    expect(close).toHaveBeenCalledOnce(); expect(f.child.kill).not.toHaveBeenCalled(); expect(channel.send({ v: 1, type: "workspace.disconnect" })).toBe(false);
  });

  it("holds a real no-account Node stdio pipe while correlation close leaves its child alive until explicit test cleanup", async () => {
    const module = await loadWorkspace(); let child: ChildProcessWithoutNullStreams | undefined;
    let exited: Promise<void> | undefined; let channel: Awaited<ReturnType<typeof module.openWorkspaceLaunchChannel>> | undefined;
    const script = `process.stdout.write(${JSON.stringify(JSON.stringify(ready()) + "\n")});process.stdin.on('data',()=>{});process.stdin.on('end',()=>{});setInterval(()=>{},1000);`;
    try {
      channel = await module.openWorkspaceLaunchChannel({ args: ["--pipe"], digest, env: {}, spawn: (_command, _args, options) => {
        child = spawnChild(process.execPath, ["-e", script], options);
        exited = new Promise(resolveExit => child!.once("close", () => resolveExit()));
        return child;
      } });
      expect(channel.generation).toBe(`${keeper}:${channelId}`); channel.close();
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
      expect(child!.stdin.writableEnded).toBe(true); expect(child!.exitCode).toBeNull(); expect(child!.signalCode).toBeNull();
    } finally {
      channel?.close(); child?.kill("SIGKILL");
      if (exited) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned fixture cleanup deadline")), 3000); })]); }
        finally { clearTimeout(timer); }
      }
    }
  });
});
