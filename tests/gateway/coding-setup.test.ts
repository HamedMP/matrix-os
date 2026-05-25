import { describe, expect, it, vi } from "vitest";
import { createCodingSetupProvider } from "../../packages/gateway/src/onboarding/coding-setup.js";

describe("coding setup aggregation", () => {
  it("uses the selected project to derive GitHub readiness without listing projects twice", async () => {
    const listMatrixProjects = vi.fn(async () => [{
      slug: "matrix-os",
      name: "Matrix OS",
      repositoryUrl: "https://github.com/hamedmp/matrix-os",
    }]);
    const hasGitHubConnection = vi.fn(async (_ownerId, selectedProject) =>
      selectedProject?.repositoryUrl?.startsWith("https://github.com/") ?? false
    );
    const provider = createCodingSetupProvider({
      hasGitHubConnection,
      listMatrixProjects,
      getSelectedProjectSlug: async () => "matrix-os",
      hasIssueSource: async () => true,
      getSymphonyStatus: async () => ({
        ready: true,
        runStatuses: ["running"],
        activeAgents: ["codex"],
      }),
      hasTerminalContext: async () => true,
    });

    const status = await provider.getCodingSetup("owner_123");

    expect(status.githubConnected).toBe(true);
    expect(listMatrixProjects).toHaveBeenCalledTimes(1);
    expect(hasGitHubConnection).toHaveBeenCalledWith("owner_123", expect.objectContaining({
      slug: "matrix-os",
      repositoryUrl: "https://github.com/hamedmp/matrix-os",
    }));
  });
});
