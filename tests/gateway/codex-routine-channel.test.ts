import type { ManagedShimFrame } from "../../packages/gateway/src/coding-agents/managed-launch-protocol.mjs";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createCodexRoutineChannel, type DynamicToolResult, type RoutineTurn } from "../../packages/gateway/src/coding-agents/codex-routine-channel.mjs";
import { CodexControlSchema } from "../../packages/gateway/src/coding-agents/codex-control-protocol.mjs";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
function fixture() {
  const sent: ManagedShimFrame[] = [], native: DynamicToolResult[] = [], queued: RoutineTurn[] = [];
  const parent = Object.assign(new EventEmitter(), { connected: true, send(frame: ManagedShimFrame, done: (error?: Error) => void) { sent.push(frame); done?.(); } });
  const turn = { prompt: "Fixture", modelOptions: [] };
  const channel = createCodexRoutineChannel({ enabled: true, parent, initialTurn: () => turn, enqueue: (value: RoutineTurn) => { queued.push(value); return true; }, current: () => true, sendNative: (value: DynamicToolResult) => native.push(value) });
  const shim = (sent[0] as Extract<ManagedShimFrame, { type: "shim.ready" }>).shim;
  parent.emit("message", { type: "host.ready", wrapper: uuid(1), shim, digest: "a".repeat(64) });
  parent.emit("message", { type: "host.turn", first: true, admissionId: uuid(2) });
  channel.bind(turn, uuid(3), "native_thread", "native_turn_A", true);
  const call = (id = 47, overrides = {}) => ({ id, method: "item/tool/call", params: { threadId: "native_thread", turnId: "native_turn_A", callId: "actual_native_call", tool: "matrix_routines", arguments: { args: ["list"] }, ...overrides } });
  return { parent, channel, sent, native, queued, call };
}
it("dispatches asynchronously, deduplicates a native call independently of JSON-RPC IDs, and bounds result delivery", () => {
  const f = fixture();
  try {
    expect(f.channel.handle(f.call())).toBe(true); expect(f.native).toHaveLength(0);
    f.channel.handle(f.call(48));
    const calls = f.sent.filter(frame => frame.type === "shim.call"); expect(calls).toHaveLength(1);
    expect(calls[0].callId).toBe("actual_native_call"); expect(calls[0].actionId).not.toBe("47");
    f.parent.emit("message", { type: "host.result", admissionId: uuid(2), actionId: calls[0].actionId, result: '{"v":1,"ok":true,"data":{"kind":"list","routines":[]}}' });
    expect(f.native.map(frame => frame.id)).toEqual([47, 48]); expect(f.native.every(frame => frame.result.success)).toBe(true);
    f.parent.emit("message", { type: "host.result", admissionId: uuid(2), actionId: calls[0].actionId, result: '{"v":1,"ok":true}' });
    expect(f.native).toHaveLength(2);
  } finally { f.channel.close(); }
});
it.each([{ threadId: "child_thread" }, { turnId: "wrong_turn" }, { turnId: undefined }, { namespace: "other" }, { tool: "shell" }, { arguments: { args: ["list"], ownerId: "foreign" } }, { arguments: { args: ["list"], stdin: "x".repeat(32769) } }])("denies malformed/cross-native scope without a host call: %j", override => {
  const f = fixture(); try { f.channel.handle(f.call(47, override)); expect(f.sent.filter(frame => frame.type === "shim.call")).toHaveLength(0); expect(f.native[0].result.success).toBe(false); } finally { f.channel.close(); }
});
it("late A output cannot borrow B authority; source cancel and pipe loss fence synchronously", () => {
  const f = fixture();
  try {
    f.channel.handle(f.call()); const action = f.sent.find(frame => frame.type === "shim.call")!;
    f.channel.end();
    f.parent.emit("message", { type: "host.turn", admissionId: uuid(4), first: false, clientRequestId: "req_B", turn: { prompt: "B", modelOptions: [] } });
    f.channel.bind(f.queued[0], uuid(3), "native_thread", "native_turn_B", true);
    f.parent.emit("message", { type: "host.result", admissionId: uuid(2), actionId: action.actionId, result: '{"v":1,"ok":true}' });
    expect(f.native).toHaveLength(1); expect(f.native[0].id).toBe(47); expect(f.native[0].result.success).toBe(false);
    f.parent.emit("message", { type: "host.cancel", admissionId: uuid(4) });
    f.channel.handle(f.call(50, { turnId: "native_turn_B" })); expect(f.native.at(-1)!.result.success).toBe(false);
    f.parent.emit("disconnect"); expect(f.channel.canRegister()).toBe(false);
  } finally { f.channel.close(); }
});
it("caps concurrent actions and preserves original business UUID on timeout without retry", async () => {
  vi.useFakeTimers(); const f = fixture();
  try {
    for (let n = 0; n < 9; n++) f.channel.handle(f.call(50 + n, { callId: "call_" + n, arguments: { args: ["pause", "rt_" + "a".repeat(24), "--revision", "1", "--request-id", uuid(9)] } }));
    expect(f.sent.filter(frame => frame.type === "shim.call")).toHaveLength(8);
    expect(f.native).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(f.native).toHaveLength(9);
    expect(f.sent.filter(frame => frame.type === "shim.cancel")).toHaveLength(8);
    expect(JSON.parse(f.native[1].result.contentItems[0].text)).toMatchObject({ data: { kind: "unknown", requestId: uuid(9), reconcile: true } });
    expect(f.sent.filter(frame => frame.type === "shim.call")).toHaveLength(8);
  } finally { f.channel.close(); vi.useRealTimers(); }
});
it("public controls cannot carry private source frames or source identity fields", () => {
  expect(CodexControlSchema.safeParse({ type: "host.turn", admissionId: uuid(2), first: true }).success).toBe(false);
  expect(CodexControlSchema.safeParse({ type: "turn", clientRequestId: "req_manual", prompt: "Fixture", modelOptions: [], admissionId: uuid(2) }).success).toBe(false);
});
