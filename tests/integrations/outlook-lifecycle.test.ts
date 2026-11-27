import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { createPlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createOutlookLifecycle } from "../../packages/gateway/src/integrations/outlook/lifecycle.js";

const service = "microsoft_outlook";
const redirectUri = "https://app.matrix-os.com/api/integrations/outlook/oauth/callback";
const now = Date.parse("2026-11-27T18:00:00Z");
const credentials = { accessToken: "consented-access", refreshToken: "consented-refresh", expiresAt: now + 3_600_000 };
const account = { id: "verified-graph-id", email: "mail@example.com" };

describe("Outlook consent lifecycle", () => {
  let db: ReturnType<typeof createPlatformDb>;
  let ownerId: string;

  beforeEach(async () => {
    const instance = await createTestPGlite();
    db = createPlatformDb({ dialect: instance.dialect });
    await db.migrate();
    await db.outlook.migrate();
    ownerId = (await db.createUser({
      clerkId: "user_owner", handle: "owner", displayName: "Owner",
      email: "owner@example.com", containerId: "owner-machine",
    })).id;
  });

  afterEach(async () => {
    await db?.destroy();
  });

  function setup(graphAccountId = account.id) {
    const oauth = {
      authorize: vi.fn(() => "https://login.microsoftonline.com/consent"),
      exchange: vi.fn(async () => ({ account, credentials })),
      refresh: vi.fn(async () => ({ ...credentials, accessToken: "new-access" })),
    };
    const verifyLegacy = vi.fn(async () => graphAccountId);
    const manager = createOutlookLifecycle({
      db, store: db.outlook, oauth, encryptionKey: Buffer.alloc(32, 8), redirectUri,
      now: () => now, verifyLegacy,
    });
    return { oauth, manager, verifyLegacy };
  }

  it("binds consent to the Matrix owner and browser and never exchanges a replayed code", async () => {
    const { manager, oauth } = setup();
    const url = new URL(await manager.start({ userId: ownerId, service, label: "Work" }));
    const state = url.searchParams.get("state")!;
    expect(url.origin + url.pathname).toBe("https://app.matrix-os.com/api/integrations/outlook/oauth/authorize");
    await expect(manager.authorization(state, "857c91f0-7658-46cf-8942-a50fbb44fe9e")).rejects.toThrow();
    const launch = await manager.authorization(state, ownerId);
    await expect(manager.complete(state, "bad-browser-proof", "code")).rejects.toThrow();
    expect(oauth.exchange).not.toHaveBeenCalled();
    const linked = await manager.complete(state, launch.browserProof, "code");
    expect(linked?.connection.account_label).toBe("Work");
    const grant = await db.outlook.getGrant(ownerId, service, linked!.connection.id);
    expect(grant?.encrypted).not.toContain(credentials.accessToken);
    await expect(manager.complete(state, launch.browserProof, "code")).rejects.toThrow();
    expect(oauth.exchange).toHaveBeenCalledTimes(1);
  });

  it("preserves a legacy connection when Graph identifies a different selected account", async () => {
    const { manager, verifyLegacy } = setup("other-graph-user");
    const legacy = await db.connectService({
      userId: ownerId, service, pipedreamAccountId: "ap_legacy", accountLabel: "Original",
      accountEmail: account.email, scopes: [],
    });
    const start = new URL(await manager.start({ userId: ownerId, service, connectionId: legacy.id }));
    const state = start.searchParams.get("state")!;
    const launch = await manager.authorization(state, ownerId);
    await expect(manager.complete(state, launch.browserProof, "code")).rejects.toMatchObject({ code: "account_mismatch" });
    expect(verifyLegacy).toHaveBeenCalledWith(ownerId, expect.objectContaining({ id: legacy.id }), expect.any(AbortSignal));
    await expect(db.getConnectedService(legacy.id)).resolves.toMatchObject({ status: "active", pipedream_account_id: "ap_legacy" });
  });

  it("reuses the old ID and uses refreshed Matrix tokens after reconnect", async () => {
    const { manager, oauth } = setup();
    const legacy = await db.connectService({
      userId: ownerId, service, pipedreamAccountId: "ap_legacy", accountLabel: "Original", scopes: [],
    });
    const url = new URL(await manager.start({ userId: ownerId, service, connectionId: legacy.id }));
    const state = url.searchParams.get("state")!;
    const launch = await manager.authorization(state, ownerId);
    const linked = await manager.complete(state, launch.browserProof, "code");
    expect(linked?.connection.id).toBe(legacy.id);
    expect(linked?.connection.account_label).toBe("Original");
    await expect(manager.accessToken(ownerId, service, legacy.id)).resolves.toBe(credentials.accessToken);
    expect(oauth.refresh).not.toHaveBeenCalled();
    await expect(manager.accessToken(ownerId, service, legacy.id, { forceRefresh: true })).resolves.toBe("new-access");
    await expect(manager.accessToken(ownerId, service, legacy.id)).resolves.toBe("new-access");
  });
});
