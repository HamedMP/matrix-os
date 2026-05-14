import { describe, expect, it } from "vitest";
import { createMemoryBoardMembershipService } from "../../packages/gateway/src/boards/membership.js";

describe("shared board membership", () => {
  it("lets a board owner add and revoke teammates with bounded roles", async () => {
    const service = createMemoryBoardMembershipService();

    await expect(service.addMember("owner_1", "repo", {
      userId: "user_2",
      role: "editor",
    })).resolves.toMatchObject({ projectSlug: "repo", userId: "user_2", role: "editor" });
    await expect(service.canReadBoard("owner_1", "repo", "user_2")).resolves.toBe(true);

    await service.removeMember("owner_1", "repo", "user_2");
    await expect(service.canReadBoard("owner_1", "repo", "user_2")).resolves.toBe(false);
  });
});
