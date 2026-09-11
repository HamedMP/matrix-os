import { describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";

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
        .mockResolvedValueOnce({ status: 200, body: { access_token: "test-only", token_type: "Bearer" } });
      const manager = new CustomMcpOAuthManager({ db, encryptionKey: Buffer.alloc(32, 1), clientId: "review", redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback", request,
        validateUrl: vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const })) });
      const url = new URL(await manager.start(owner.id, server.id));
      const state = url.searchParams.get("state")!;
      const stranger = await db.createUser({ clerkId: "other-owner", handle: "other-owner", displayName: "Other", email: "other@example.test", containerId: "other-container" });
      await expect(manager.complete(stranger.id, state, "test-code")).rejects.toMatchObject({ code: "invalid" });
      expect(request).toHaveBeenCalledTimes(2);
      const publicRows = await db.listCustomMcpServers(owner.id);
      expect(publicRows).toHaveLength(presetId ? 0 : 1);
      const completions = await Promise.allSettled([
        manager.complete(owner.id, state, "test-code"),
        manager.complete(owner.id, state, "test-code"),
      ]);
      expect(completions.filter((result) => result.status === "fulfilled")).toEqual([
        { status: "fulfilled", value: { serverId: server.id } },
      ]);
      expect(completions.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(manager.complete(owner.id, state, "test-code")).rejects.toMatchObject({ code: "invalid" });
      expect(request).toHaveBeenCalledTimes(3);
    } finally { await db.destroy(); }
  });

});
