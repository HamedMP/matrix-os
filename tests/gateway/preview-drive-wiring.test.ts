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
});
