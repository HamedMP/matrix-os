import { describe, expect, it } from "vitest";
import { TerminalHostFrameSchema, TerminalShimFrameSchema } from "../../../packages/gateway/src/coding-agents/terminal-launch-protocol.mjs";
import { ManagedHostFrameSchema, ManagedShimFrameSchema, parseManagedFrame } from "../../../packages/gateway/src/coding-agents/managed-launch-protocol.mjs";
const admissionId = "90f042ea-eafd-49f9-82e8-595f22f66d0b", actionId = "c3283c23-8aa3-422a-b26f-1883ae1959cf";
const host = { pid: 20, ppid: 10, uid: 1000, gid: 1000, start: "42" }, root = { ...host, pid: 30, ppid: 20, start: "43" };
const bound = { type: "terminal.bound", admissionId, host, root, supervisor: { ...host, pid: 10, ppid: 1 }, invocationId: "a".repeat(32), generation: "gen_" + "b".repeat(64) };
describe("distinct Terminal protocol over the shared held launch", () => {
  it("allows actual Terminal identity without Chat/turn fields", () => {
    expect(parseManagedFrame(TerminalHostFrameSchema, { type: "host.terminal.admit", admissionId })).toBeDefined();
    expect(parseManagedFrame(TerminalShimFrameSchema, bound)).toEqual(bound);
    expect(parseManagedFrame(TerminalShimFrameSchema, { type: "terminal.call", admissionId, actionId, writer: root, operation: { operation: "list" } })).toBeDefined();
    expect(parseManagedFrame(TerminalHostFrameSchema, { type: "host.terminal.result", admissionId, actionId, result: { v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } } })).toBeDefined();
  });
  it("keeps default Codex and Terminal application frames mutually exclusive", () => {
    expect(parseManagedFrame(ManagedShimFrameSchema, bound)).toBeUndefined();
    expect(parseManagedFrame(ManagedHostFrameSchema, { type: "host.terminal.admit", admissionId })).toBeUndefined();
    expect(parseManagedFrame(TerminalHostFrameSchema, { type: "host.turn", admissionId, first: true })).toBeUndefined();
    expect(parseManagedFrame(TerminalShimFrameSchema, { type: "shim.end", admissionId })).toBeUndefined();
  });
  it("rejects caller authority, invalid incarnation, extra fields and oversized frames", () => {
    for (const frame of [{ ...bound, ownerId: "owner" }, { ...bound, threadId: "invented" }, { ...bound, root: { ...root, start: "-1" } }, { ...bound, root: { ...root, pid: 0 } }, { ...bound, invocationId: "x" }, { ...bound, generation: "current" }]) {
      expect(parseManagedFrame(TerminalShimFrameSchema, frame)).toBeUndefined();
    }
    expect(parseManagedFrame(TerminalHostFrameSchema, { type: "host.terminal.admit", admissionId, policy: "full" })).toBeUndefined();
    expect(parseManagedFrame(TerminalHostFrameSchema, { type: "host.terminal.result", admissionId, actionId, result: "x".repeat(200000) })).toBeUndefined();
  });
});
