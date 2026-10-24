import { beforeEach, describe, expect, it } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createTestIntegrationDb } from "./native-integration-db-test-helper.js";

describe("owner-scoped GitHub OAuth connections", () => {
  let db: PlatformDb;
  let userId: string;

  beforeEach(async () => {
    ({ db } = await createTestIntegrationDb());
    userId = (await db.createUser({
      clerkId: "github-owner",
      handle: "github-owner",
      displayName: "GitHub Owner",
      email: "owner@example.test",
      containerId: "github-owner-container",
    })).id;
  });

  it("atomically activates one direct account and retires legacy Pipedream GitHub rows", async () => {
    const legacy = await db.connectService({
      userId,
      service: "github",
      pipedreamAccountId: "legacy-github",
      accountLabel: "Legacy",
      scopes: ["repo"],
    });
    const direct = await db.connectGitHubService({
      userId,
      githubUserId: "42",
      login: "octocat",
      accountLabel: "Work",
      accountEmail: null,
      scopes: ["repo", "notifications"],
      encryptedCredentials: "sealed-1",
    });

    expect(direct).toMatchObject({
      user_id: userId,
      github_user_id: "42",
      login: "octocat",
      account_label: "Work",
      status: "active",
      revision: 1,
      encrypted_credentials: "sealed-1",
    });
    expect((await db.getConnectedService(legacy.id))?.status).toBe("revoked");
    expect(await db.listGitHubConnections(userId)).toHaveLength(1);
  });

  it("reconnects idempotently as the owner's single API account and advances the revision", async () => {
    const first = await db.connectGitHubService({
      userId,
      githubUserId: "42",
      login: "octocat",
      accountLabel: "First",
      accountEmail: null,
      scopes: ["repo", "notifications"],
      encryptedCredentials: "sealed-1",
    });
    const second = await db.connectGitHubService({
      userId,
      githubUserId: "84",
      login: "hubot",
      accountLabel: "Replacement",
      accountEmail: "hubot@example.test",
      scopes: ["repo", "notifications"],
      encryptedCredentials: "sealed-2",
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ github_user_id: "84", login: "hubot", revision: 2, encrypted_credentials: "sealed-2" });
    expect(await db.listGitHubConnections(userId)).toHaveLength(1);
  });

  it("fences refresh against revocation and hides a claimed connection immediately", async () => {
    const row = await db.connectGitHubService({
      userId,
      githubUserId: "42",
      login: "octocat",
      accountLabel: "Work",
      accountEmail: null,
      scopes: ["repo", "notifications"],
      encryptedCredentials: "sealed-1",
    });
    const claims = await Promise.all([
      db.claimGitHubConnectionRevocation(row.id, userId, 1, "sealed-1"),
      db.claimGitHubConnectionRevocation(row.id, userId, 1, "sealed-1"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await db.listGitHubConnections(userId)).toEqual([]);
    expect(await db.updateGitHubCredentialsIfCurrent(row.id, userId, 1, "sealed-1", "late-refresh")).toBe(false);

    const claimed = claims.find(Boolean)!;
    expect(claimed).toMatchObject({ status: "revocation_pending", revision: 2, encrypted_credentials: "sealed-1" });
    expect(await db.deleteGitHubConnectionIfClaimed(row.id, userId, 1, "sealed-1")).toBe(false);
    expect(await db.deleteGitHubConnectionIfClaimed(row.id, userId, 2, "sealed-1")).toBe(true);
    expect(await db.getGitHubConnection(row.id)).toBeNull();
  });

  it("updates credentials only for the exact active owner, revision, and ciphertext", async () => {
    const row = await db.connectGitHubService({
      userId,
      githubUserId: "42",
      login: "octocat",
      accountLabel: "Work",
      accountEmail: null,
      scopes: ["repo", "notifications"],
      encryptedCredentials: "sealed-1",
    });
    expect(await db.updateGitHubCredentialsIfCurrent(row.id, userId, 1, "wrong", "sealed-2")).toBe(false);
    expect(await db.updateGitHubCredentialsIfCurrent(row.id, "00000000-0000-0000-0000-000000000000", 1, "sealed-1", "sealed-2")).toBe(false);
    expect(await db.updateGitHubCredentialsIfCurrent(row.id, userId, 1, "sealed-1", "sealed-2")).toBe(true);
    expect(await db.getGitHubConnection(row.id)).toMatchObject({ revision: 1, encrypted_credentials: "sealed-2", status: "active" });
  });

  it("cascades the encrypted owner grant when the owner is deleted", async () => {
    const row = await db.connectGitHubService({
      userId,
      githubUserId: "42",
      login: "octocat",
      accountLabel: "Work",
      accountEmail: null,
      scopes: ["repo", "notifications"],
      encryptedCredentials: "sealed-1",
    });
    await db.raw("DELETE FROM users WHERE id = $1", [userId]);
    expect(await db.getGitHubConnection(row.id)).toBeNull();
  });
});
