import { describe, expect, it, vi } from "vitest";
import { createGatewayReadinessProbes } from "../../packages/gateway/src/collaboration/gateway-readiness-probes.js";

const subject = {
  ownerId: "user_owner", scopeId: "10000000-0000-4000-8000-000000000001",
  organizationId: "org_team", resourceKind: "project" as const,
};

describe("production collaboration readiness probes", () => {
  it("uses the current sandbox verdict for executing scopes", async () => {
    const sandboxSupported = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const probes = createGatewayReadinessProbes({
      repository: { getScope: async () => null },
      chats: { kysely: {} as never },
      projectSource: () => undefined,
      sandboxSupported,
      ownerSource: undefined,
    });
    await expect(probes.supported(subject)).resolves.toBe(false);
    await expect(probes.supported(subject)).resolves.toBe(true);
    expect(sandboxSupported).toHaveBeenCalledTimes(2);
    await expect(probes.supported({ ...subject, resourceKind: "file" })).resolves.toBe(true);
    expect(sandboxSupported).toHaveBeenCalledTimes(2);
  });
});
