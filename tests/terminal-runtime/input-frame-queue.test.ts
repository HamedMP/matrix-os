import { describe, expect, it, vi } from "vitest";
import { TerminalFrameQueue } from "../../packages/terminal-runtime/src/input-frame-queue.js";

const terminalRef = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
const input = (data: string) => ({ type: "input" as const, terminalRef, data });
const palette = Array.from({ length: 256 }, (_, index) => `\x1b]4;${index};rgb:ffff/ffff/ffff\x1b\\`);
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

function fixture() {
  const overflow = vi.fn();
  const error = vi.fn();
  return { queue: new TerminalFrameQueue({ onOverflow: overflow, onError: error }), overflow, error };
}

describe("bounded terminal input admission", () => {
  it("keeps a startup palette burst while authorization is pending, then delivers keyboard input in order", async () => {
    const { queue, overflow } = fixture();
    const gate = Promise.withResolvers<void>();
    const received: string[] = [];
    queue.resume(async frame => { await gate.promise; if (frame.type === "input") received.push(frame.data); });
    queue.enqueue(input("\x1b]11;rgb:0000/0000/0000\x1b\\"));
    for (const reply of palette) queue.enqueue(input(reply));
    queue.enqueue(input("printf ready\r"));
    expect(overflow).not.toHaveBeenCalled();
    gate.resolve();
    await settle();
    expect(received.join("")).toBe("\x1b]11;rgb:0000/0000/0000\x1b\\" + palette.join("") + "printf ready\r");
  });

  it("retains a startup burst before the stream is ready", async () => {
    const { queue, overflow } = fixture();
    for (const reply of palette) queue.enqueue(input(reply));
    const received: string[] = [];
    queue.resume(async frame => { if (frame.type === "input") received.push(frame.data); });
    await settle();
    expect(overflow).not.toHaveBeenCalled();
    expect(received.join("")).toBe(palette.join(""));
  });

  it("never merges across resize, ping, detach, binary, or terminal reference boundaries", async () => {
    const { queue } = fixture();
    const frames = [input("a"), { type: "resize" as const, terminalRef, mode: "soft" as const, size: { cols: 80, rows: 24 } }, input("b"),
      { type: "ping" as const, terminalRef }, { type: "binary" as const, terminalRef, dataBase64: "AP8=" }, input("c"),
      input("d"), { ...input("other"), terminalRef: { ...terminalRef, tabId: `tt_${"c".repeat(32)}` } },
      { type: "detach" as const, terminalRef }];
    for (const frame of frames) queue.enqueue(frame);
    const received: unknown[] = [];
    queue.resume(async frame => { received.push(frame); });
    await settle();
    expect(received).toEqual([...frames.slice(0, 5), input("cd"), ...frames.slice(7)]);
  });

  it("coalesces binary bytes without concatenating base64 padding", async () => {
    const { queue } = fixture();
    queue.enqueue({ type: "binary", terminalRef, dataBase64: "AP8=" });
    queue.enqueue({ type: "binary", terminalRef, dataBase64: "gA==" });
    const received: unknown[] = [];
    queue.resume(async frame => { received.push(frame); });
    await settle();
    expect(received).toEqual([{ type: "binary", terminalRef, dataBase64: "AP+A" }]);
  });

  it("keeps batches within the input contract and preserves multi-byte text", async () => {
    const { queue, overflow } = fixture();
    const data = "界".repeat(20_000);
    queue.enqueue(input(data)); queue.enqueue(input(data));
    const received: string[] = [];
    queue.resume(async frame => { if (frame.type === "input") received.push(frame.data); });
    await settle();
    expect(received).toEqual([data, data]);
    expect(overflow).not.toHaveBeenCalled();
  });

  it("still bounds control-frame floods and clears queued work on overload", async () => {
    const { queue, overflow } = fixture();
    for (let i = 0; i < 33; i++) queue.enqueue({ type: "ping", terminalRef });
    const send = vi.fn(async () => undefined);
    queue.resume(send);
    await settle();
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds retained bytes even when input is coalescible", () => {
    const { queue, overflow } = fixture();
    for (let i = 0; i < 32; i++) queue.enqueue(input("x".repeat(64 * 1024)));
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it("drops pending input on disconnect and refuses further enqueue", async () => {
    const { queue } = fixture();
    queue.enqueue(input("old")); queue.close(); queue.enqueue(input("late"));
    const send = vi.fn(async () => undefined); queue.resume(send);
    await settle(); expect(send).not.toHaveBeenCalled();
  });

  it("does not admit the next batch until the previous authorization completes", async () => {
    const { queue } = fixture(); const gate = Promise.withResolvers<void>(); let allowed = true;
    const received: string[] = [];
    queue.resume(async frame => { await gate.promise; if (allowed && frame.type === "input") received.push(frame.data); });
    queue.enqueue(input("queued-before-revocation"));
    allowed = false; gate.resolve(); await settle();
    expect(received).toEqual([]);
  });

  it("stops and reports an admission failure without sending subsequent input", async () => {
    const { queue, error } = fixture(); const failure = new Error("denied");
    queue.enqueue(input("a")); queue.enqueue({ type: "ping", terminalRef });
    const handler = vi.fn(async () => { throw failure; }); queue.resume(handler);
    await settle(); expect(error).toHaveBeenCalledWith(failure); expect(handler).toHaveBeenCalledTimes(1);
  });
  it("preserves independently encoded surrogate halves instead of combining them into a new character", async () => {
    const { queue } = fixture(); const received: string[] = [];
    queue.enqueue(input("\uD83D")); queue.enqueue(input("\uDE00"));
    queue.resume(async frame => { if (frame.type === "input") received.push(frame.data); });
    await settle();
    expect(received).toEqual(["\uD83D", "\uDE00"]);
  });

});
