import { describe, expect, it, vi } from "vitest";
import { createProjectAccessReadiness } from "../../packages/gateway/src/collaboration/project-access-readiness.js";

const scope = {
  id: "90000000-0000-4000-8000-000000000040",
  kind: "project" as const,
  lifecycle: "shared" as const,
  ownerId: "user_owner",
  resourceId: "proj_readiness",
};

describe("project access readiness projection", () => {
  it("omits private host paths and credentials from the member projection", async () => {
    const listChats = vi.fn(async () => [{
      id: "chat_one", revision: "1", compatibility: "ready" as const,
      executionRoot: { kind: "worktree" as const, projectId: scope.resourceId, worktreeId: "wt_one" },
      branch: "feature/chat", dirty: true,
      rootPath: "/home/owner/private", credential: "raw-token",
    }]);
    const service = createProjectAccessReadiness({
      repository: { getScope: async () => scope } as never,
      source: { listChats, getGitSetup: async () => ({ identity: { status: "ready" as const, label: "Owner <owner@example.test>" }, forgeCredential: { status: "ready" as const } }) },
    });
    const result = await service.get({ scopeId: scope.id });
    expect(result.chatRoots).toEqual([expect.objectContaining({ chatId: "chat_one", dirty: true })]);
    expect(JSON.stringify(result)).not.toMatch(/(\/home\/owner|raw-token|credential)/);
  });

  it("refuses readiness for a private or nonproject scope", async () => {
    const listChats = vi.fn();
    const service = createProjectAccessReadiness({
      repository: { getScope: async () => ({ ...scope, lifecycle: "private" }) } as never,
      source: { listChats },
    });
    await expect(service.get({ scopeId: scope.id })).rejects.toThrow();
    expect(listChats).not.toHaveBeenCalled();
  });
});
