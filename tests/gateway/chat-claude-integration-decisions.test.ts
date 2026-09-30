import { createHash } from "node:crypto";
import { previewDriveActionCanonical } from "@matrix-os/contracts";
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
  it("binds a Preview Drive decision digest to the one-use Platform action grant", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    registry.authorizePreviewDriveRun({ actorId: "owner_claude", chatId: "chat_1", runId: "run_1", runGrant: "a".repeat(64) });
    const capability = registry.issue({ owner: { type: "personal", ownerId: "owner_claude" },
      runId: "run_1", scope: "chat_call" })!;
    const grantAction = vi.fn(async () => "b".repeat(64));
    const events: CanonicalProviderRunEvent[] = [];
    const respond = vi.fn(async (_value: unknown) => {});
    const control = createClaudeIntegrationApprovalControl({ runId: "run_1", homePath: "/safe/home",
      capability, previewDriveClient: { grantAction } as never,
      emit: event => events.push(event), onError: vi.fn() });
    const exact = { service: "google_drive", action: "list_files", label: "work", params: { maxResults: 3 } };
    expect(control.onToolPermission({ nativeRequestId: "native_drive", toolName, input: exact }, respond)).toBe(true);
    const request = events[0] as Extract<CanonicalProviderRunEvent, { type: "approval.requested" }>;
    const canonical = previewDriveActionCanonical(exact)!;
    expect(request.actionDigest).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(grantAction).not.toHaveBeenCalled();
    const context = registry.resolveRunContext(capability.token, "POST", "/api/integrations/call")!;
    expect(context.previewDrive!.consumeActionGrant(exact, "c".repeat(64))).toBeNull();
    await expect(control.submit(request.approvalId, "approve_for_session", { chatId: "chat_1",
      clientRequestId: "req_1", platformApprovalProof: "browser-proof" })).rejects.toThrow();
    expect(grantAction).not.toHaveBeenCalled();
    await control.submit(request.approvalId, "approve", { chatId: "chat_1", clientRequestId: "req_1",
      platformApprovalProof: "browser-proof" });
    expect(grantAction).toHaveBeenCalledWith({ runGrant: "a".repeat(64), chatId: "chat_1", runId: "run_1",
      approvalId: request.approvalId, clientRequestId: "req_1", actionDigest: request.actionDigest,
      action: exact, proof: "browser-proof" });
    const receipt = (respond.mock.calls[0]![0] as { updatedInput: { matrix_approval_receipt: string } })
      .updatedInput.matrix_approval_receipt;
    expect(context.previewDrive!.consumeActionGrant({ ...exact, params: { maxResults: 2 } }, receipt)).toBeNull();
    expect(context.previewDrive!.consumeActionGrant(exact, receipt)).toBe("b".repeat(64));
    expect(context.previewDrive!.consumeActionGrant(exact, receipt)).toBeNull();
    await expect(control.submit(request.approvalId, "approve", { chatId: "chat_1",
      clientRequestId: "req_1", platformApprovalProof: "browser-proof" })).rejects.toThrow();
    expect(grantAction).toHaveBeenCalledOnce();
    control.close(); registry.close();
  });

  it("does not request a Platform grant for a stale native Preview approval", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    registry.authorizePreviewDriveRun({ actorId: "owner_claude", chatId: "chat_1", runId: "run_1", runGrant: "a".repeat(64) });
    const capability = registry.issue({ owner: { type: "personal", ownerId: "owner_claude" },
      runId: "run_1", scope: "chat_call" })!;
    const grantAction = vi.fn(async () => "b".repeat(64));
    const events: CanonicalProviderRunEvent[] = [];
    const control = createClaudeIntegrationApprovalControl({ runId: "run_1", homePath: "/safe/home",
      capability, previewDriveClient: { grantAction } as never,
      emit: event => events.push(event), onError: vi.fn() });
    control.onToolPermission({ nativeRequestId: "native_drive", toolName,
      input: { service: "google_drive", action: "list_files", label: "work", params: { maxResults: 3 } } },
    vi.fn(async () => {}));
    const request = events[0] as Extract<CanonicalProviderRunEvent, { type: "approval.requested" }>;
    control.onToolPermissionCancel("native_drive");
    await expect(control.submit(request.approvalId, "approve", { chatId: "chat_1", clientRequestId: "req_1",
      platformApprovalProof: "browser-proof" })).rejects.toThrow();
    expect(grantAction).not.toHaveBeenCalled();
    control.close(); registry.close();
  });
  it("retracts a completed native allow when cancellation arrives before execution", async () => {
    const f = fixture();
    await f.control.submit(f.requested.approvalId, "approve", proof);
    const receipt = (f.respond.mock.calls[0]![0] as { updatedInput: { matrix_approval_receipt: string } }).updatedInput.matrix_approval_receipt;
    f.control.onToolPermissionCancel("native_1");
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action, receipt)).toBe(false);
    expect(f.registry.resolveRunContext(f.capability.token, "GET", "/api/mcp-servers")).not.toBeNull();
    expect(f.events.filter(event => event.type === "approval.resolved")).toHaveLength(1);
    f.control.close(); f.registry.close();
  });
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
    expect(f.registry.resolveRunContext(f.capability.token, "GET", "/api/mcp-servers")).toBeNull();
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
    const receipt = (f.respond.mock.calls[0]![0] as { updatedInput: { matrix_approval_receipt: string } }).updatedInput.matrix_approval_receipt;
    if (cancellation === "native") f.control.onToolPermissionCancel("native_1");
    else f.control.close();
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action, receipt)).toBe(false);
    expect(f.registry.resolveRunContext(f.capability.token, "GET", "/api/mcp-servers") === null).toBe(cancellation === "close");
    finish();
    await outcome;
    expect(f.events.filter(event => event.type === "approval.resolved")).toEqual([
      expect.objectContaining({ decision: "cancel" }),
    ]);
    f.control.close(); f.registry.close();
  });
  it("cancels only its exact grant and preserves an unrelated identical approval and Custom MCP capability", async () => {
    const f = fixture();
    const otherRespond = vi.fn(async (_value: unknown) => {});
    f.control.onToolPermission({ nativeRequestId: "native_2", toolName, input: action }, otherRespond);
    const otherApproval = f.events.at(-1) as Extract<CanonicalProviderRunEvent, { type: "approval.requested" }>;
    await f.control.submit(otherApproval.approvalId, "approve", { ...proof, clientRequestId: "req_2" });
    const otherReceipt = (otherRespond.mock.calls[0]![0] as { updatedInput: { matrix_approval_receipt: string } }).updatedInput.matrix_approval_receipt;
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    f.respond.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; started(); }));
    const submission = f.control.submit(f.requested.approvalId, "approve", proof);
    const outcome = expect(submission).rejects.toThrow();
    await writing;
    const input = (f.respond.mock.calls[0]![0] as { updatedInput: Record<string, unknown> }).updatedInput;
    const receipt = input.matrix_approval_receipt as string;
    expect(input).toEqual({ ...action, matrix_approval_receipt: expect.stringMatching(/^[a-f0-9]{64}$/) });
    f.control.onToolPermissionCancel("native_1");
    expect(f.registry.resolveRunContext(f.capability.token, "GET", "/api/mcp-servers")).not.toBeNull();
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action, receipt)).toBe(false);
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action, otherReceipt)).toBe(true);
    expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action, otherReceipt)).toBe(false);
    finish(); await outcome;
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.events.filter(event => event.type === "approval.resolved")).toEqual([
      expect.objectContaining({ decision: "approve" }),
      expect.objectContaining({ decision: "cancel" }),
    ]);
    f.control.close(); f.registry.close();
  });
  it("rejects model-provided execution receipts before requesting human approval", () => {
    const f = fixture();
    const respond = vi.fn(async (_value: unknown) => {});
    f.control.onToolPermission({ nativeRequestId: "forged", toolName,
      input: { ...action, matrix_approval_receipt: "a".repeat(64) } }, respond);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
    expect(f.events.filter(event => event.type === "approval.requested")).toHaveLength(1);
    expect(f.verify).not.toHaveBeenCalled();
    f.control.close(); f.registry.close();
  });
  it("sweeps consumed receipts so sequential approvals do not exhaust the retention cap", async () => {
    const f = fixture();
    await f.control.submit(f.requested.approvalId, "decline", proof);
    for (let i = 0; i < 20; i++) {
      f.control.onToolPermission({ nativeRequestId: `native_seq_${i}`, toolName, input: action }, f.respond);
      const requested = f.events.at(-1) as Extract<CanonicalProviderRunEvent, { type: "approval.requested" }>;
      expect(requested.type).toBe("approval.requested");
      await f.control.submit(requested.approvalId, "approve", { ...proof, clientRequestId: `req_seq_${i}` });
      const receipt = (f.respond.mock.calls.at(-1)![0] as { updatedInput: { matrix_approval_receipt: string } }).updatedInput.matrix_approval_receipt;
      expect(f.context.consumeIntegrationRequest!("POST", "/api/integrations/call", action, receipt)).toBe(true);
    }
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
