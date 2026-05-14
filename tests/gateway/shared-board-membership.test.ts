import { describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import {
  BoardMemberLimitExceededError,
  KyselyBoardMembershipService,
  createMemoryBoardMembershipService,
} from "../../packages/gateway/src/boards/membership.js";
import { BOARD_MEMBER_LIMIT } from "../../packages/gateway/src/boards/contracts.js";

describe("shared board membership", () => {
  it("lets a board owner add and revoke teammates with bounded roles", async () => {
    const service = createMemoryBoardMembershipService();

    const added = await service.addMember("owner_1", "repo", {
      userId: "user_2",
      role: "editor",
    });
    expect(added).toMatchObject({ projectSlug: "repo", userId: "user_2", role: "editor" });
    await expect(service.addMember("owner_1", "repo", {
      userId: "user_2",
      role: "viewer",
    })).resolves.toMatchObject({ userId: "user_2", role: "viewer", addedAt: added.addedAt });
    await expect(service.canReadBoard("owner_1", "repo", "user_2")).resolves.toBe(true);

    await service.removeMember("owner_1", "repo", "user_2");
    await expect(service.canReadBoard("owner_1", "repo", "user_2")).resolves.toBe(false);
  });

  it("rejects new Postgres board members once the board is full", async () => {
    const instance = await KyselyPGlite.create();
    const db = new Kysely<any>({ dialect: instance.dialect });
    const service = new KyselyBoardMembershipService(db);
    try {
      await service.bootstrap();
      for (let i = 0; i < BOARD_MEMBER_LIMIT; i += 1) {
        await service.addMember("owner_1", "repo", { userId: `user_${i}`, role: "viewer" });
      }

      await expect(service.addMember("owner_1", "repo", {
        userId: "user_over_limit",
        role: "viewer",
      })).rejects.toBeInstanceOf(BoardMemberLimitExceededError);
      await expect(service.addMember("owner_1", "repo", {
        userId: "user_0",
        role: "editor",
      })).resolves.toMatchObject({ userId: "user_0", role: "editor" });
    } finally {
      await db.destroy();
    }
  });

  it("preserves Postgres member addedAt when updating a role", async () => {
    const instance = await KyselyPGlite.create();
    const db = new Kysely<any>({ dialect: instance.dialect });
    const service = new KyselyBoardMembershipService(db);
    try {
      await service.bootstrap();
      const added = await service.addMember("owner_1", "repo", {
        userId: "user_2",
        role: "viewer",
      });
      const updated = await service.addMember("owner_1", "repo", {
        userId: "user_2",
        role: "editor",
      });

      expect(updated).toMatchObject({ userId: "user_2", role: "editor", addedAt: added.addedAt });
      await expect(service.listMembers("owner_1", "repo")).resolves.toMatchObject([
        { userId: "user_2", role: "editor", addedAt: added.addedAt },
      ]);
    } finally {
      await db.destroy();
    }
  });

  it("rejects new memory board members once the board is full without evicting existing members", async () => {
    const service = createMemoryBoardMembershipService();
    for (let i = 0; i < BOARD_MEMBER_LIMIT; i += 1) {
      await service.addMember("owner_1", "repo", { userId: `user_${i}`, role: "viewer" });
    }

    await expect(service.addMember("owner_1", "repo", {
      userId: "user_over_limit",
      role: "viewer",
    })).rejects.toBeInstanceOf(BoardMemberLimitExceededError);
    await expect(service.canReadBoard("owner_1", "repo", "user_0")).resolves.toBe(true);
  });
});
