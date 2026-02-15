import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createApprovalBridge,
  type ApprovalBridge,
} from "../../packages/gateway/src/approval.js";

describe("Approval bridge (gateway)", () => {
  let bridge: ApprovalBridge;
  let sentMessages: unknown[];

  beforeEach(() => {
    sentMessages = [];
    bridge = createApprovalBridge({
      send: (msg) => sentMessages.push(msg),
      timeout: 500,
    });
  });

  it("sends approval_request via WebSocket and resolves true on approve", async () => {
    const promise = bridge.requestApproval("Bash", { command: "rm -rf /tmp" });

    expect(sentMessages).toHaveLength(1);
    const req = sentMessages[0] as { type: string; id: string; toolName: string; args: unknown; timeout: number };
    expect(req.type).toBe("approval:request");
    expect(req.toolName).toBe("Bash");
    expect(req.args).toEqual({ command: "rm -rf /tmp" });
    expect(typeof req.id).toBe("string");
    expect(req.timeout).toBe(500);

    bridge.handleResponse({ id: req.id, approved: true });

    const result = await promise;
    expect(result).toBe(true);
  });

  it("resolves false on user denial", async () => {
    const promise = bridge.requestApproval("Write", { file_path: "/system/config.json" });

    const req = sentMessages[0] as { id: string };
    bridge.handleResponse({ id: req.id, approved: false });

    const result = await promise;
    expect(result).toBe(false);
  });

  it("auto-denies after timeout", async () => {
    const promise = bridge.requestApproval("Bash", { command: "kill -9 123" });

    const result = await promise;
    expect(result).toBe(false);
  }, 2000);

  it("ignores responses for unknown request IDs", async () => {
    const promise = bridge.requestApproval("Bash", { command: "rm file" });

    bridge.handleResponse({ id: "unknown-id", approved: true });

    const req = sentMessages[0] as { id: string };
    bridge.handleResponse({ id: req.id, approved: false });

    const result = await promise;
    expect(result).toBe(false);
  });

  it("only resolves once for duplicate responses", async () => {
    const promise = bridge.requestApproval("Bash", { command: "rm file" });

    const req = sentMessages[0] as { id: string };
    bridge.handleResponse({ id: req.id, approved: true });
    bridge.handleResponse({ id: req.id, approved: false });

    const result = await promise;
    expect(result).toBe(true);
  });

  it("handles concurrent requests independently", async () => {
    const p1 = bridge.requestApproval("Bash", { command: "rm file1" });
    const p2 = bridge.requestApproval("Write", { file_path: "/system/x" });

    expect(sentMessages).toHaveLength(2);

    const req1 = sentMessages[0] as { id: string };
    const req2 = sentMessages[1] as { id: string };

    bridge.handleResponse({ id: req2.id, approved: false });
    bridge.handleResponse({ id: req1.id, approved: true });

    expect(await p1).toBe(true);
    expect(await p2).toBe(false);
  });
});
