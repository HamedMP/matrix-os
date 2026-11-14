import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedHostFrameSchema, ManagedShimFrameSchema } from "../../packages/gateway/src/coding-agents/managed-launch-protocol.mjs";
import { TerminalHostFrameSchema, TerminalShimFrameSchema } from "../../packages/gateway/src/coding-agents/terminal-launch-protocol.mjs";
const keeper = "00000000-0000-4000-8000-000000000001", channel = "00000000-0000-4000-8000-000000000002", requestId = "00000000-0000-4000-8000-000000000003";
const digest = "a".repeat(64), nonce = "b".repeat(64);
const fence = () => ({ v: 1, type: "workspace.fence", requestId, nonce, deadlineNs: "18446744073709551615" });
async function protocol() {
  const path = resolve("packages/terminal-runtime/src/workspace-launch-protocol.ts");
  return import(/* @vite-ignore */ path) as Promise<typeof import("../../packages/terminal-runtime/src/workspace-launch-protocol.js")>;
}
describe("strict workspace handshake/fence data, never identity/source proof", () => {
  it("allows only correlation handshakes, original-deadline fencing and unknown acknowledgement", async () => {
    const p = await protocol();
    for (const frame of [fence(), { v: 1, type: "workspace.host.ready", keeper, channel, digest }, { v: 1, type: "workspace.disconnect" }]) expect(p.WorkspaceHostFrameSchema.safeParse(frame).success).toBe(true);
    for (const frame of [{ v: 1, type: "workspace.keeper.ready", keeper, channel, digest }, { v: 1, type: "workspace.fenced", requestId, nonce, outcome: "unknown" }, { v: 1, type: "workspace.end" }]) expect(p.WorkspaceKeeperFrameSchema.safeParse(frame).success).toBe(true);
  });
  it("rejects identity, authority, arbitrary preparation and stop-success claims", async () => {
    const p = await protocol();
    for (const extra of [{ ownerId: "owner" }, { chatId: "chat" }, { botId: "bot" }, { runId: "run" }, { pid: 42 }, { proof: "serialized" }, { sourceEnabled: true }, { authorized: true }, { policy: "full" }, { token: "secret" }, { payload: {} }]) {
      expect(p.WorkspaceHostFrameSchema.safeParse({ ...fence(), ...extra }).success).toBe(false);
      expect(p.WorkspaceKeeperFrameSchema.safeParse({ v: 1, type: "workspace.fenced", requestId, nonce, outcome: "unknown", ...extra }).success).toBe(false);
    }
    expect(p.WorkspaceHostFrameSchema.safeParse({ v: 1, type: "workspace.prepare", requestId, template: {} }).success).toBe(false);
    expect(p.WorkspaceKeeperFrameSchema.safeParse({ v: 1, type: "workspace.fenced", requestId, nonce, outcome: "stopped" }).success).toBe(false);
  });
  it("bounds strict original u64 deadlines, correlation and protocol version", async () => {
    const p = await protocol();
    for (const deadlineNs of ["0", "-1", "01", "18446744073709551616", "1e3", 123]) expect(p.WorkspaceHostFrameSchema.safeParse({ ...fence(), deadlineNs }).success).toBe(false);
    for (const frame of [{ ...fence(), v: 2 }, { ...fence(), nonce: "x".repeat(65) }, { ...fence(), requestId: "invented" }, { ...fence(), type: "workspace.release" }]) expect(p.WorkspaceHostFrameSchema.safeParse(frame).success).toBe(false);
  });
  it("keeps existing managed/Terminal schemas rejecting workspace frames", () => {
    for (const schema of [ManagedHostFrameSchema, ManagedShimFrameSchema, TerminalHostFrameSchema, TerminalShimFrameSchema]) expect(schema.safeParse(fence()).success).toBe(false);
  });
});
