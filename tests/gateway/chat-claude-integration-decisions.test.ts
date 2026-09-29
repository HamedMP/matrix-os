import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeIntegrationApprovalControl } from "../../packages/gateway/src/chat/claude-integration-approval.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

const action = { service: "google_drive", action: "create_folder", label: "work", params: { name: "approved" } };
const toolName = "mcp__matrix-integrations__call_service";
afterEach(() => vi.useRealTimers());
function fixture(verified = true) {
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: "owner_claude" });
  const capability = registry.issue({ owner: { type: "personal", ownerId: "owner_claude" }, runId: "run_1", scope: "chat_call" })!;
  const events: CanonicalProviderRunEvent[] = [];
  const respond = vi.fn(async (_value: unknown) => {});
  const verify = vi.fn(async () => verified);
  const onError = vi.fn();
  const control = createClaudeIntegrationApprovalControl({ runId: "run_1", homePath: "/safe/home", capability,
    verify, emit: event => events.push(event), onError });
  control.onToolPermission({ nativeRequestId: "native_1", toolName, input: action }, respond);
  const requested = events[0] as Extract<CanonicalProviderRunEvent, { type: "approval.requested" }>;
  const context = registry.resolveRunContext(capability.token, "POST", "/api/integrations/call")!;
  return { registry, capability, control, requested, respond, verify, onError, events, context };
}
const proof = { chatId: "chat_1", clientRequestId: "req_1", platformApprovalProof: "signed-decision" };

describe("built-in integration human decisions", () => {
  it.each(["decline", "cancel"] as const)("%s never grants provider execution", async decision => {
    const f = fixture();
    await f.control.submit(f.requested.approvalId, decision, proof);
    expect(f.respond).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(false);
    expect(f.events.at(-1)).toMatchObject({ type: "approval.resolved", decision });
    f.control.close(); f.registry.close();
  });
  it.each([false, undefined])("denies an invalid or missing authenticated decision (%s)", async verified => {
    const f = fixture(verified === false ? false : true);
    await expect(f.control.submit(f.requested.approvalId, "approve", verified === undefined ? undefined : proof)).rejects.toThrow();
    expect(f.respond).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(false);
    f.control.close(); f.registry.close();
  });
  it.each(["approve", "decline", "cancel"] as const)("revokes authorization when the %s native response transport fails", async decision => {
    const f = fixture();
    f.respond.mockRejectedValueOnce(new Error("Disconnected native transport"));
    await expect(f.control.submit(f.requested.approvalId, decision, proof)).rejects.toThrow();
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(false);
    expect(f.events.at(-1)).toMatchObject({ type: "approval.resolved", decision: "cancel" });
    expect(f.onError).toHaveBeenCalledOnce();
    f.control.close(); f.registry.close();
  });
  it("cancels a pending decision when the native request is cancelled or the run closes", async () => {
    const f = fixture();
    let finish!: (value: boolean) => void;
    f.verify.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const submission = f.control.submit(f.requested.approvalId, "approve", proof);
    f.control.onToolPermissionCancel("native_1");
    finish(true);
    await expect(submission).rejects.toThrow();
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(false);
    expect(f.events.filter(event => event.type === "approval.resolved")).toHaveLength(1);
    f.control.close(); f.registry.close();
  });
  it.each(["native", "close"] as const)("revokes a grant when %s cancellation races with the native response write", async cancellation => {
    const f = fixture();
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    f.respond.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; started(); }));
    const submission = f.control.submit(f.requested.approvalId, "approve", proof);
    const outcome = expect(submission).rejects.toThrow();
    await writing;
    if (cancellation === "native") f.control.onToolPermissionCancel("native_1");
    else f.control.close();
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(false);
    finish();
    await outcome;
    expect(f.events.filter(event => event.type === "approval.resolved")).toEqual([
      expect.objectContaining({ decision: "cancel" }),
    ]);
    f.control.close(); f.registry.close();
  });
  it("cancels only its exact grant and preserves an unrelated identical approval and Custom MCP capability", async () => {
    const f = fixture();
    expect(f.capability.approveIntegrationTool!(toolName, action)).toBe(true);
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    f.respond.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; started(); }));
    const submission = f.control.submit(f.requested.approvalId, "approve", proof);
    const outcome = expect(submission).rejects.toThrow();
    await writing;
    f.control.onToolPermissionCancel("native_1");
    expect(f.registry.resolveRunContext(f.capability.token, "GET", "/api/mcp-servers")).not.toBeNull();
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(true);
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(false);
    finish(); await outcome;
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.events.filter(event => event.type === "approval.resolved")).toEqual([
      expect.objectContaining({ decision: "cancel" }),
    ]);
    f.control.close(); f.registry.close();
  });
  it("expires pending approvals, drains them on close and rejects blanket session approval", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await expect(f.control.submit(f.requested.approvalId, "approve_for_session", proof)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(f.control.submit(f.requested.approvalId, "approve", proof)).rejects.toThrow();
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action)).toBe(false);
    f.control.onToolPermission({ nativeRequestId: "native_2", toolName, input: action }, f.respond);
    f.control.close();
    expect(f.events.filter(event => event.type === "approval.resolved")).toHaveLength(2);
    f.registry.close();
  });
});
