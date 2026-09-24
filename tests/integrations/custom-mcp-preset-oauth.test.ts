import { describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import {
  decryptCustomMcpCredential,
  encryptCustomMcpCredential,
} from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";

describe("managed preset OAuth callback", () => {
  it.each(["granola", undefined])("completes owner-scoped OAuth once for preset %s", async (presetId) => {
    const pg = await KyselyPGlite.create();
    const db = createPlatformDb({ dialect: pg.dialect });
    try {
      await db.migrate();
      const owner = await db.createUser({ clerkId: "review-owner", handle: "review-owner", displayName: "Review", email: "review@example.test", containerId: "review-container" });
      const server = await db.createCustomMcpServer({ userId: owner.id, presetId, name: "Research", url: "https://mcp.acme.tools/mcp", authMode: "oauth", pendingExpiresAt: new Date(Date.now() + 86400000) });
      const request = vi.fn()
        .mockResolvedValueOnce({ status: 200, body: { resource: "https://mcp.acme.tools/mcp", authorization_servers: ["https://auth.acme.tools"] } })
        .mockResolvedValueOnce({ status: 200, body: { authorization_endpoint: "https://auth.acme.tools/authorize", token_endpoint: "https://auth.acme.tools/token", code_challenge_methods_supported: ["S256"] } })
        .mockResolvedValueOnce({ status: 200, body: { access_token: "test-only", token_type: "bearer" } });
      const manager = new CustomMcpOAuthManager({ db, encryptionKey: Buffer.alloc(32, 1), clientId: "review", redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback", request,
        validateUrl: vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const })) });
      const url = new URL(await manager.start(owner.id, server.id));
      const state = url.searchParams.get("state")!;
      const tamperedState = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
      await expect(manager.complete(tamperedState, "test-code")).rejects.toMatchObject({ code: "invalid" });
      expect(request).toHaveBeenCalledTimes(2);
      const publicRows = await db.listCustomMcpServers(owner.id);
      expect(publicRows).toHaveLength(presetId ? 0 : 1);
      const completions = await Promise.allSettled([
        manager.complete(state, "test-code"),
        manager.complete(state, "test-code"),
      ]);
      expect(completions.filter((result) => result.status === "fulfilled")).toEqual([
        { status: "fulfilled", value: { serverId: server.id } },
      ]);
      expect(completions.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(manager.complete(state, "test-code")).rejects.toMatchObject({ code: "invalid" });
      expect(request).toHaveBeenCalledTimes(3);
    } finally { await db.destroy(); }
  });

  it("preserves a newer authorization when an older callback finishes token exchange", async () => {
    const pg = await KyselyPGlite.create();
    const db = createPlatformDb({ dialect: pg.dialect });
    const encryptionKey = Buffer.alloc(32, 2);
    let releaseToken!: (value: { status: number; body: Record<string, unknown> }) => void;
    const tokenResponse = new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
      releaseToken = resolve;
    });
    let tokenRequested!: () => void;
    const tokenRequestStarted = new Promise<void>((resolve) => {
      tokenRequested = resolve;
    });
    try {
      await db.migrate();
      const owner = await db.createUser({ clerkId: "race-owner", handle: "race-owner", displayName: "Race", email: "race@example.test", containerId: "race-container" });
      const server = await db.createCustomMcpServer({ userId: owner.id, name: "Research", url: "https://mcp.acme.tools/mcp", authMode: "oauth", pendingExpiresAt: new Date(Date.now() + 86400000) });
      const request = vi.fn(async (input: { method: string; url: string }) => {
        if (input.url === "https://auth.acme.tools/token") {
          tokenRequested();
          return tokenResponse;
        }
        if (input.url === "https://mcp.acme.tools/.well-known/oauth-protected-resource/mcp") {
          return { status: 200, body: { resource: server.url, authorization_servers: ["https://auth.acme.tools"] } };
        }
        return { status: 200, body: { authorization_endpoint: "https://auth.acme.tools/authorize", token_endpoint: "https://auth.acme.tools/token", code_challenge_methods_supported: ["S256"] } };
      });
      const manager = new CustomMcpOAuthManager({ db, encryptionKey, clientId: "review", redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback", request,
        validateUrl: vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const })) });
      const firstState = new URL(await manager.start(owner.id, server.id)).searchParams.get("state")!;
      const firstCompletion = manager.complete(firstState, "first-code");
      await tokenRequestStarted;

      const secondState = new URL(await manager.start(owner.id, server.id)).searchParams.get("state")!;
      releaseToken({ status: 200, body: { access_token: "old-token", token_type: "Bearer" } });

      await expect(firstCompletion).rejects.toMatchObject({ code: "conflict" });
      const current = await db.getCustomMcpServerForBroker(server.id, owner.id);
      expect(current?.encrypted_credentials).toBeTruthy();
      const credential = decryptCustomMcpCredential<any>(current!.encrypted_credentials!, encryptionKey, {
        userId: owner.id,
        serverId: server.id,
      });
      expect(credential.oauth.state).toBe(secondState);
      expect(credential.oauth.accessToken).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });

  it("refreshes an access token without invalidating the server projection revision", async () => {
    const pg = await KyselyPGlite.create();
    const db = createPlatformDb({ dialect: pg.dialect });
    const encryptionKey = Buffer.alloc(32, 3);
    try {
      await db.migrate();
      const owner = await db.createUser({ clerkId: "refresh-owner", handle: "refresh-owner", displayName: "Refresh", email: "refresh@example.test", containerId: "refresh-container" });
      const server = await db.createCustomMcpServer({ userId: owner.id, name: "Research", url: "https://mcp.acme.tools/mcp", authMode: "oauth", pendingExpiresAt: new Date(Date.now() + 86400000) });
      const encryptedCredentials = encryptCustomMcpCredential({
        oauth: {
          accessToken: "expired-token",
          refreshToken: "refresh-token",
          expiresAt: "2026-01-01T00:00:00.000Z",
          tokenEndpoint: "https://auth.acme.tools/token",
          resource: server.url,
          clientId: "review",
        },
      }, encryptionKey, { userId: owner.id, serverId: server.id });
      await db.updateCustomMcpServer(server.id, owner.id, server.revision, {
        encryptedCredentials,
        status: "ready",
      });
      const row = await db.getCustomMcpServerForBroker(server.id, owner.id);
      const manager = new CustomMcpOAuthManager({
        db,
        encryptionKey,
        clientId: "review",
        redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback",
        now: () => new Date("2026-09-23T00:00:00.000Z"),
        request: vi.fn(async () => ({ status: 200, body: { access_token: "fresh-token", token_type: "Bearer" } })),
        validateUrl: vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const })),
      });

      await expect(manager.resolveAuthorization(owner.id, row!)).resolves.toBe("Bearer fresh-token");
      const refreshed = await db.getCustomMcpServerForBroker(server.id, owner.id);
      expect(refreshed?.revision).toBe(row?.revision);
    } finally {
      await db.destroy();
    }
  });

});
