import { describe, expect, it, vi } from "vitest";
import { createMatrixSymphonyOrchestrator } from "../../packages/gateway/src/symphony/orchestrator.js";

describe("Symphony Codex readiness", () => {
  it("reports Codex cloud auth state without exposing tokens", async () => {
    const orchestrator = createMatrixSymphonyOrchestrator({
      homePath: "/tmp/matrix",
      repository: {} as any,
      credentialStore: {} as any,
      linearSource: {} as any,
      worktreeManager: {} as any,
      agentSessionManager: {} as any,
      codexReadiness: vi.fn(async () => ({ status: "valid", lastCheckedAt: "2026-05-14T18:00:00.000Z" })),
    });

    await expect(orchestrator.codexReadiness()).resolves.toEqual({
      status: "valid",
      lastCheckedAt: "2026-05-14T18:00:00.000Z",
    });
  });
});
