import { describe, expect, it, vi } from "vitest";
import {
  mintCustomMcpApprovalProof,
  verifyCustomMcpApprovalProof,
} from "../../packages/platform/src/custom-mcp-approval-proof.js";
import { authenticatedApprovalProxyProof } from "../../packages/platform/src/session-routing-middleware.js";

const secret = "fixture-platform-secret-never-machine-token";
const base = {
  method: "POST", path: "/api/chats/chat_1/runs/run_1/approvals/approval_1",
  identity: { handle: "owner", userId: "clerk-owner", source: "auth" as const },
  body: JSON.stringify({ clientRequestId: "req_1", decision: "approve" }),
  secret, now: 1_800_000_000_000,
};
const verify = {
  handle: "owner", actorId: "clerk-owner", chatId: "chat_1", runId: "run_1",
  approvalId: "approval_1", decision: "approve" as const, clientRequestId: "req_1",
  secret, now: base.now,
};

describe("Platform-authenticated Custom MCP approval proof", () => {
  it("mints only after a verified Clerk or platform sync-JWT identity on the exact bounded canonical submit", () => {
    for (const source of ["auth"] as const) {
      const proof = mintCustomMcpApprovalProof({ ...base, identity: { ...base.identity, source } });
      expect(proof).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
      expect(verifyCustomMcpApprovalProof(proof!, verify)).toBe(true);
    }
    for (const source of ["mobile-session", "static-route"] as const) {
      expect(mintCustomMcpApprovalProof({ ...base, identity: { ...base.identity, source } })).toBeNull();
    }
    expect(mintCustomMcpApprovalProof({ ...base, identity: { ...base.identity, userId: "" } })).toBeNull();
    expect(mintCustomMcpApprovalProof({ ...base, identity: { ...base.identity, source: undefined } })).toBeNull();
    expect(mintCustomMcpApprovalProof({ ...base, method: "GET" })).toBeNull();
    expect(mintCustomMcpApprovalProof({ ...base, path: "/api/chats/chat_1/runs/run_1/inputs/approval_1" })).toBeNull();
    expect(mintCustomMcpApprovalProof({ ...base, body: "x".repeat(4_001) })).toBeNull();
    expect(mintCustomMcpApprovalProof({ ...base, body: JSON.stringify({ clientRequestId: "req_1", decision: "approve", actorId: "forged" }) })).toBeNull();
  });

  it("rejects a forged machine-token MAC, replay tuple changes, expiry and malformed proof", () => {
    const proof = mintCustomMcpApprovalProof(base)!;
    expect(verifyCustomMcpApprovalProof(proof, verify)).toBe(true);
    for (const mismatch of [
      { actorId: "foreign" }, { handle: "other" }, { chatId: "chat_2" },
      { runId: "run_2" }, { approvalId: "approval_2" },
      { decision: "decline" as const }, { clientRequestId: "req_2" },
      { secret: "machine-bearer" }, { now: base.now + 61_000 },
    ]) expect(verifyCustomMcpApprovalProof(proof, { ...verify, ...mismatch })).toBe(false);
    expect(verifyCustomMcpApprovalProof("garbage", verify)).toBe(false);
    const [payload, mac] = proof.split(".");
    expect(verifyCustomMcpApprovalProof(`${payload}.${mac![0] === "0" ? "1" : "0"}${mac!.slice(1)}`, verify)).toBe(false);
  });

  it("rejects a streaming overlimit body without waiting for a tee cancellation", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(4_001)));
      // The source intentionally stays open; awaiting the tee cancel deadlocks.
    }, cancel: cancelled });
    const request = new Request("https://app.example.test/api/chats/chat_1/runs/run_1/approvals/approval_1", {
      method: "POST", body: stream, duplex: "half",
    } as RequestInit);
    const result = await Promise.race([
      authenticatedApprovalProxyProof({ ...base, request, platformSecret: secret, timeoutMs: 200 }),
      new Promise(resolve => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(result).toEqual({ status: 413 });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  it("times out a slow approval body and fails closed without waiting for the other stream branch", async () => {
    const cancelled = vi.fn();
    const request = new Request("https://app.example.test/api/chats/chat_1/runs/run_1/approvals/approval_1", {
      method: "POST", body: new ReadableStream<Uint8Array>({ cancel: cancelled }), duplex: "half",
    } as RequestInit);
    const result = await Promise.race([
      authenticatedApprovalProxyProof({ ...base, request, platformSecret: secret, timeoutMs: 30 }),
      new Promise(resolve => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(result).toEqual({ status: 408 });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });
});
