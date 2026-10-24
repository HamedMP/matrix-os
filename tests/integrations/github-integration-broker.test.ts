import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { getAction } from "../../packages/gateway/src/integrations/registry.js";
import { decryptGitHubOAuthState } from "../../packages/gateway/src/integrations/github-credential-crypto.js";
import {
  GitHubIntegrationBroker,
  GitHubIntegrationError,
  type GitHubProviderClient,
} from "../../packages/gateway/src/integrations/github-integration.js";
import { createTestIntegrationDb } from "./native-integration-db-test-helper.js";

const key = Buffer.alloc(32, 9);

function provider(): GitHubProviderClient {
  return {
    exchangeCode: vi.fn(async () => ({ accessToken: "gho_access", scopes: ["repo", "notifications"] })),
    refreshAccessToken: vi.fn(async () => ({ accessToken: "gho_rotated", refreshToken: "ghr_rotated", scopes: ["repo", "notifications"] })),
    getViewer: vi.fn(async () => ({ id: "42", login: "octocat", email: null })),
    revokeToken: vi.fn(async () => undefined),
    requestApi: vi.fn(async () => ({ ok: true })),
  };
}

describe("GitHub integration broker", () => {
  let db: PlatformDb;
  let userId: string;

  beforeEach(async () => {
    ({ db } = await createTestIntegrationDb());
    userId = (await db.createUser({
      clerkId: "broker-owner",
      handle: "broker-owner",
      displayName: "Broker Owner",
      email: "owner@example.test",
      containerId: "broker-owner-container",
    })).id;
  });

  function broker(client = provider(), now = new Date("2026-10-24T02:00:00.000Z")) {
    return { client, broker: new GitHubIntegrationBroker({
      db,
      client,
      clientId: "client-123",
      callbackUrl: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
      encryptionKey: key,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 4),
    }) };
  }

  it("starts an owner-bound web or mobile flow without accepting an arbitrary redirect URL", () => {
    const { broker: integration } = broker();
    const url = new URL(integration.start(userId, { label: "Work", redirectTarget: "mobile" }));
    const state = decryptGitHubOAuthState<Record<string, unknown>>(url.searchParams.get("state")!, key);
    expect(state).toMatchObject({ userId, label: "Work", redirectTarget: "mobile" });
    expect(url.searchParams.get("scope")).toBe("repo notifications");
    expect(integration.resolveRedirectTarget(url.searchParams.get("state")!)).toBe("mobile");
    expect(() => integration.resolveRedirectTarget(`${url.searchParams.get("state")}tampered`))
      .toThrow(GitHubIntegrationError);
  });

  it("rejects partial or extra grants, revokes the token, and stores no callable connection", async () => {
    for (const scopes of [["repo"], ["repo", "notifications", "user"]]) {
      const client = provider();
      vi.mocked(client.exchangeCode).mockResolvedValueOnce({ accessToken: `gho_${scopes.length}`, scopes });
      const { broker: integration } = broker(client);
      const url = new URL(integration.start(userId, { redirectTarget: "web" }));
      await expect(integration.complete(url.searchParams.get("state")!, "code-1")).rejects.toBeInstanceOf(GitHubIntegrationError);
      expect(client.revokeToken).toHaveBeenCalledWith(`gho_${scopes.length}`);
      expect(await db.listGitHubConnections(userId)).toEqual([]);
    }
  });

  it("completes consent, encrypts the grant, and dispatches through the selected owner account", async () => {
    const { broker: integration, client } = broker();
    const url = new URL(integration.start(userId, { label: "Work", redirectTarget: "web" }));
    const completed = await integration.complete(url.searchParams.get("state")!, "code-1");
    expect(completed).toMatchObject({ redirectTarget: "web", connection: { service: "github", account_label: "Work" } });
    const stored = (await db.listGitHubConnections(userId))[0]!;
    expect(stored.encrypted_credentials).not.toContain("gho_access");

    await expect(integration.call({
      userId,
      connectionId: stored.id,
      action: getAction("github", "list_repos")!,
      params: {},
    })).resolves.toEqual({ data: { ok: true } });
    expect(client.requestApi).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "gho_access" }));
    expect((await db.getGitHubConnection(stored.id))?.last_used_at).not.toBeNull();
  });

  it("refreshes an expiring grant with an exact ciphertext CAS before dispatch", async () => {
    const now = new Date("2026-10-24T02:00:00.000Z");
    const client = provider();
    vi.mocked(client.exchangeCode).mockResolvedValueOnce({
      accessToken: "gho_access",
      refreshToken: "ghr_refresh",
      scopes: ["repo", "notifications"],
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      refreshTokenExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const { broker: integration } = broker(client, now);
    const url = new URL(integration.start(userId, { redirectTarget: "web" }));
    const completed = await integration.complete(url.searchParams.get("state")!, "code-1");
    await integration.call({ userId, connectionId: completed.connection.id, action: getAction("github", "list_repos")!, params: {} });
    expect(client.refreshAccessToken).toHaveBeenCalledWith("ghr_refresh");
    expect(client.requestApi).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "gho_rotated" }));
  });

  it("hides a disconnect immediately, retains a failed revocation for retry, and cannot delete a reconnect", async () => {
    const client = provider();
    const { broker: integration } = broker(client);
    const url = new URL(integration.start(userId, { redirectTarget: "web" }));
    const completed = await integration.complete(url.searchParams.get("state")!, "code-1");
    vi.mocked(client.revokeToken).mockRejectedValueOnce(new Error("network"));

    await expect(integration.disconnect(userId, completed.connection.id)).rejects.toBeInstanceOf(GitHubIntegrationError);
    expect(await db.listGitHubConnections(userId)).toEqual([]);
    expect(await db.getGitHubConnection(completed.connection.id)).toMatchObject({ status: "revocation_pending" });

    await expect(integration.disconnect(userId, completed.connection.id)).resolves.toBe(true);
    expect(await db.getGitHubConnection(completed.connection.id)).toBeNull();
  });

  it("renames an owned connection and treats a long-lived grant refresh as an active no-op", async () => {
    const { broker: integration, client } = broker();
    const url = new URL(integration.start(userId, { redirectTarget: "web" }));
    const completed = await integration.complete(url.searchParams.get("state")!, "code-1");

    await expect(integration.rename(userId, completed.connection.id, "Personal"))
      .resolves.toMatchObject({ account_label: "Personal" });
    await expect(integration.refreshConnection(userId, completed.connection.id))
      .resolves.toMatchObject({ status: "active", account_label: "Personal" });
    expect(client.refreshAccessToken).not.toHaveBeenCalled();
  });
});
