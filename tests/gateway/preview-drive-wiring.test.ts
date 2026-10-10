import { createHash } from "node:crypto";
import { canonicalPreviewDriveTurnBody } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createPreviewDriveWiring } from "../../packages/gateway/src/chat/preview-drive-wiring.js";

const body = { clientRequestId: "req_1", baseRevision: 0, parts: [{ type: "text" as const, text: "List three files" }],
  selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" },
  interactionMode: "default" as const, permissionMode: "supervised" as const };

describe("Preview Drive turn wiring", () => {
  it("redeems only the exact browser proof before allowing a run capability", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    const redeemTurn = vi.fn(async () => "a".repeat(64));
    const revoke = vi.fn(async () => undefined);
    const wiring = createPreviewDriveWiring({ previewRuntime: true, registry,
      client: { redeemTurn, revoke } as never });
    expect(wiring.beforeDispatch).toBeTypeOf("function");
    await wiring.beforeDispatch!({ actorId: "owner", chatId: "chat_1", turnId: "cturn_1",
      runId: "run_1", clientRequestId: "req_1", body, proof: "browser-proof" });
    expect(redeemTurn).toHaveBeenCalledWith({ actorId: "owner", chatId: "chat_1", turnId: "cturn_1",
      runId: "run_1", clientRequestId: "req_1", bodyDigest: createHash("sha256")
        .update(canonicalPreviewDriveTurnBody(body)).digest("hex"), proof: "browser-proof" });
    const capability = registry.issue({ owner: { type: "personal", ownerId: "owner" }, runId: "run_1", scope: "chat_call" })!;
    expect(capability.surface).toBe("preview_drive_call");
    capability.revoke();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith({ runGrant: "a".repeat(64), chatId: "chat_1", runId: "run_1" }));
    registry.close();
  });

  it("leaves Preview integration disabled when a browser proof is unavailable", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    const redeemTurn = vi.fn(async () => "a".repeat(64));
    const wiring = createPreviewDriveWiring({ previewRuntime: true, registry,
      client: { redeemTurn } as never });
    await expect(wiring.beforeDispatch!({ actorId: "owner", chatId: "chat_1", turnId: "cturn_1",
      runId: "run_1", clientRequestId: "req_1", body, proof: "" })).rejects.toThrow();
    expect(redeemTurn).not.toHaveBeenCalled();
    expect(registry.issue({ owner: { type: "personal", ownerId: "owner" }, runId: "run_1", scope: "chat_call" })).toBeNull();
    registry.close();
  });

  it("disposes only the exact pending actor/chat/run and revokes once", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    const revoke = vi.fn(async () => undefined);
    const wiring = createPreviewDriveWiring({ previewRuntime: true, registry,
      client: { redeemTurn: async () => "b".repeat(64), revoke } });
    const cleanup = await wiring.beforeDispatch!({ actorId: "owner", chatId: "chat_1", turnId: "cturn_1",
      runId: "run_1", clientRequestId: "req_1", body, proof: "browser-proof" });
    const dispose = registry.disposePendingPreviewDriveRun;
    expect(dispose).toBeTypeOf("function");
    expect(dispose({ runGrant: "b".repeat(64), actorId: "other", chatId: "chat_1", runId: "run_1" })).toBe(false);
    expect(dispose({ runGrant: "b".repeat(64), actorId: "owner", chatId: "chat_other", runId: "run_1" })).toBe(false);
    expect(dispose({ runGrant: "b".repeat(64), actorId: "owner", chatId: "chat_1", runId: "run_other" })).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    expect(cleanup).toBeTypeOf("function");
    cleanup!(); cleanup!();
    expect(registry.issue({ owner: { type: "personal", ownerId: "owner" }, runId: "run_1", scope: "chat_call" })).toBeNull();
    registry.close();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("transfers cleanup ownership to the issued capability", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    const revoke = vi.fn(async () => undefined);
    const wiring = createPreviewDriveWiring({ previewRuntime: true, registry,
      client: { redeemTurn: async () => "c".repeat(64), revoke } });
    const cleanup = await wiring.beforeDispatch!({ actorId: "owner", chatId: "chat_1", turnId: "cturn_1",
      runId: "run_1", clientRequestId: "req_1", body, proof: "browser-proof" });
    const capability = registry.issue({ owner: { type: "personal", ownerId: "owner" }, runId: "run_1", scope: "chat_call" })!;
    expect(cleanup).toBeTypeOf("function");
    cleanup!();
    expect(registry.resolve(capability.token, "GET", "/api/integrations")).toBe("owner");
    expect(revoke).not.toHaveBeenCalled();
    capability.revoke(); capability.revoke(); registry.close();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("removes pending authority before invoking a reentrant or throwing revocation callback", () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    const scope = { actorId: "owner", chatId: "chat_1", runId: "run_1", runGrant: "d".repeat(64) };
    const onRevoke = vi.fn(() => {
      expect(registry.disposePendingPreviewDriveRun(scope)).toBe(false);
      throw new Error("controlled revocation failure");
    });
    registry.authorizePreviewDriveRun({ ...scope, runGrant: "d".repeat(64), onRevoke });
    expect(() => registry.disposePendingPreviewDriveRun(scope)).toThrow("controlled revocation failure");
    expect(registry.disposePendingPreviewDriveRun(scope)).toBe(false);
    registry.close();
    expect(onRevoke).toHaveBeenCalledOnce();
  });


  it("does not let an expired redemption cleanup dispose a replacement with the same scope", async () => {
    let now = 0;
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true, now: () => now });
    const revoke = vi.fn(async () => undefined);
    const redeemTurn = vi.fn().mockResolvedValueOnce("a".repeat(64)).mockResolvedValueOnce("b".repeat(64));
    const wiring = createPreviewDriveWiring({ previewRuntime: true, registry, client: { redeemTurn, revoke } });
    const input = { actorId: "owner", chatId: "chat_1", turnId: "cturn_1", runId: "run_1",
      clientRequestId: "req_1", body, proof: "browser-proof" };
    const oldCleanup = await wiring.beforeDispatch!(input);
    now = 2 * 60_000;
    const newCleanup = await wiring.beforeDispatch!(input);
    expect(revoke).toHaveBeenCalledOnce();
    expect(oldCleanup).toBeTypeOf("function");
    oldCleanup!();
    const capability = registry.issue({ owner: { type: "personal", ownerId: "owner" }, runId: "run_1", scope: "chat_call" })!;
    expect(capability.previewDrive?.runGrant).toBe("b".repeat(64));
    newCleanup!();
    expect(revoke).toHaveBeenCalledOnce();
    capability.revoke(); registry.close();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

});
