import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { NativeGmailOAuthManager } from "../../packages/gateway/src/integrations/native-gmail/oauth.js";
import { GMAIL_SCOPE } from "../../packages/gateway/src/integrations/native-gmail/types.js";

describe("Matrix Google OAuth", () => {
  let db: PlatformDb;
  let userId: string;
  let manager: NativeGmailOAuthManager;
  let fetcher: ReturnType<typeof vi.fn>;
  let now: number;
  const key = Buffer.alloc(32, 9);
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const start = async () => new URL((await manager.start({ userId, externalUserId: "external", label: "Work" })).url).searchParams.get("state")!;
  const proof = async (state: string) => (await manager.authorization(state, { userId })).browserProof;
  const complete = async (state: string, code: string) => manager.complete(state, code, await proof(state));
  const tokens = (override = {}) => ({ access_token: "access", refresh_token: "refresh", expires_in: 3600,
    token_type: "Bearer", scope: GMAIL_SCOPE, ...override });
  const connect = async () => {
    fetcher.mockResolvedValueOnce(json(tokens())).mockResolvedValueOnce(json({ emailAddress: "mail@example.test" }));
    return complete(await start(), "code");
  };
  beforeEach(async () => {
    const pg = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pg.dialect });
    await db.migrate();
    userId = (await db.createUser({ clerkId: "oauth-owner", handle: "oauth-owner", displayName: "Owner",
      email: "owner@example.test", containerId: "oauth-container", pipedreamExternalId: "external" })).id;
    now = Date.parse("2026-10-07T10:00:00Z");
    fetcher = vi.fn();
    manager = new NativeGmailOAuthManager({ store: db.nativeGmailStore!, clientId: "client", clientSecret: "secret",
      redirectUri: "https://api.matrix-os.com/api/integrations/gmail/callback", encryptionKey: key, fetcher, now: () => now });
  });
  afterEach(async () => db.destroy());

  it("requests bounded single-use offline PKCE consent without exposing credentials", async () => {
    const url = new URL((await manager.start({ userId, externalUserId: "external", redirectUri: "matrixos://integrations" })).url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(GMAIL_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.matrix-os.com/api/integrations/gmail/callback");
    const browserProof = await proof(url.searchParams.get("state")!);
    await manager.cancel(url.searchParams.get("state")!, browserProof);
    await expect(manager.complete(url.searchParams.get("state")!, "code", browserProof)).rejects.toThrow("Gmail connection unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("only launches consent in the initiating authenticated owner browser", async () => {
    const state = await start();
    await expect(manager.authorization(state, { userId: "other-owner" })).rejects.toThrow();
    const authorization = await manager.authorization(state, { userId });
    const url = new URL(authorization.url);
    expect(url.searchParams.get("state")).toBe(state);
    await manager.cancel(state, authorization.browserProof);
    await expect(manager.authorization(state, { userId })).rejects.toThrow();
  });

  it("binds encrypted tokens exactly and reuses the same native account on repeated consent", async () => {
    const first = await connect();
    const second = await connect();
    expect(second.connectionId).toBe(first.connectionId);
    const canonical = await db.getConnectedService(first.connectionId);
    expect(canonical?.pipedream_account_id).toMatch(/^gmail_[0-9a-f-]{36}$/);
    expect(await manager.token({ externalUserId: "external", accountId: canonical!.pipedream_account_id })).toBe("access");
    await expect(manager.token({ externalUserId: "other", accountId: canonical!.pipedream_account_id })).rejects.toThrow();
    const privateRow = await db.nativeGmailStore!.byConnection({ userId, connectionId: first.connectionId });
    expect(privateRow?.encryptedCredentials).not.toContain("refresh");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    const body = new URLSearchParams(fetcher.mock.calls[0][1].body);
    expect(body.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
  });

  it("preserves exact reconnect labels and uniquely names new unlabeled Gmail accounts", async () => {
    const first = await connect();
    fetcher.mockResolvedValueOnce(json(tokens())).mockResolvedValueOnce(json({ emailAddress: "mail@example.test" }));
    const reconnect = new URL((await manager.start({ userId, externalUserId: "external" })).url).searchParams.get("state")!;
    expect((await complete(reconnect, "code")).accountLabel).toBe("Work");
    expect((await db.getConnectedService(first.connectionId))?.account_label).toBe("Work");
    for (const [email, label] of [["second@example.test", "Gmail"], ["third@example.test", "Gmail 2"]]) {
      fetcher.mockResolvedValueOnce(json(tokens())).mockResolvedValueOnce(json({ emailAddress: email }));
      const state = new URL((await manager.start({ userId, externalUserId: "external" })).url).searchParams.get("state")!;
      expect((await complete(state, "code")).accountLabel).toBe(label);
    }
  });

  it("rejects insufficient grants before profile, and consumes failed and expired state", async () => {
    const state = await start();
    fetcher.mockResolvedValueOnce(json(tokens({ scope: "https://www.googleapis.com/auth/gmail.readonly" })));
    await expect(complete(state, "code")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(complete(state, "code")).rejects.toThrow();
    const expired = await start();
    now += 601_000;
    await expect(complete(expired, "code")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refreshes token rotation and validates invalid_grant without reactivating canonical state", async () => {
    const connected = await connect();
    const canonical = await db.getConnectedService(connected.connectionId);
    now += 3_700_000;
    fetcher.mockResolvedValueOnce(json(tokens({ access_token: "rotated", refresh_token: "rotated-refresh" })));
    expect(await manager.token({ externalUserId: "external", accountId: canonical!.pipedream_account_id })).toBe("rotated");
    now += 3_700_000;
    fetcher.mockResolvedValueOnce(json({ error: "invalid_grant", error_description: "SECRET" }, 400));
    await expect(manager.refresh({ userId, connectionId: connected.connectionId })).rejects.toThrow("Gmail connection unavailable");
    expect((await db.getConnectedService(connected.connectionId))?.status).toBe("expired");
  });

  it("waits for the durable shared refresh so parallel reads receive the settled token", async () => {
    const connected = await connect();
    const canonical = await db.getConnectedService(connected.connectionId);
    const binding = { externalUserId: "external", accountId: canonical!.pipedream_account_id };
    now += 3_700_000;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    fetcher.mockImplementationOnce(async () => { entered(); await held; return json(tokens({ access_token: "shared-refreshed" })); });
    const first = manager.token(binding);
    await started;
    // A second process has no shared in-memory promise; only durable state coordinates it.
    const other = new NativeGmailOAuthManager({ store: db.nativeGmailStore!, clientId: "client", clientSecret: "secret",
      redirectUri: "https://api.matrix-os.com/api/integrations/gmail/callback", encryptionKey: key, fetcher, now: () => now });
    const second = other.token(binding);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondSettled).toBe(false);
    release();
    expect(await Promise.all([first, second])).toEqual(["shared-refreshed", "shared-refreshed"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reloads when another refresh settles between the connection and pending-lease reads", async () => {
    const connected = await connect();
    const canonical = await db.getConnectedService(connected.connectionId);
    vi.spyOn(db.nativeGmailStore!, "lookup").mockResolvedValueOnce(null);
    expect(await manager.token({ externalUserId: "external", accountId: canonical!.pipedream_account_id })).toBe("access");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed immediately while durable revocation is pending", async () => {
    const connected = await connect();
    const row = await db.nativeGmailStore!.byConnection({ userId, connectionId: connected.connectionId });
    const lease = await db.nativeGmailStore!.acquireLease(row!, new Date(now), "revoke");
    await expect(manager.token({ externalUserId: "external", accountId: row!.accountId })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await db.nativeGmailStore!.releaseLease(lease!);
  });

  it("bounds refresh waiting and respects caller cancellation without retrying a provider mutation", async () => {
    const connected = await connect();
    const row = await db.nativeGmailStore!.byConnection({ userId, connectionId: connected.connectionId });
    await db.nativeGmailStore!.acquireLease(row!, new Date(now));
    const controller = new AbortController();
    const waiting = manager.token({ externalUserId: "external", accountId: row!.accountId }, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(waiting).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses a ten-second deadline while waiting for a crashed refresh process", async () => {
    const connected = await connect();
    const row = await db.nativeGmailStore!.byConnection({ userId, connectionId: connected.connectionId });
    await db.nativeGmailStore!.acquireLease(row!, new Date(now));
    const actualTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(10_000);
      return actualTimeout(20);
    });
    try {
      await expect(manager.token({ externalUserId: "external", accountId: row!.accountId })).rejects.toThrow();
      expect(timeout).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { timeout.mockRestore(); }
  });

  it("rejects refresh after concurrent reconnect and never dispatches stale access", async () => {
    const connected = await connect();
    const canonical = await db.getConnectedService(connected.connectionId);
    now += 3_700_000;
    fetcher.mockImplementationOnce(async () => {
      await db.updateServiceStatus(connected.connectionId, "revoked");
      return json(tokens({ access_token: "stale" }));
    });
    await expect(manager.token({ externalUserId: "external", accountId: canonical!.pipedream_account_id })).rejects.toThrow();
    expect((await db.getConnectedService(connected.connectionId))?.status).toBe("revoked");
  });

  it("requires valid revoke success before deletion and never deletes a reconnected revision", async () => {
    const connected = await connect();
    fetcher.mockResolvedValueOnce(new Response("upstream details", { status: 500 }));
    await expect(manager.revoke({ userId, connectionId: connected.connectionId })).rejects.toThrow();
    expect(await db.getConnectedService(connected.connectionId)).not.toBeNull();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await manager.revoke({ userId, connectionId: connected.connectionId })).toBe(true);
    expect(await db.getConnectedService(connected.connectionId)).toBeNull();
    expect(await manager.revoke({ userId, connectionId: connected.connectionId })).toBe(false);
  });

  it("rejects oversized or malformed token bodies and does not fetch the profile", async () => {
    fetcher.mockResolvedValueOnce(new Response("x".repeat(65_537)));
    await expect(complete(await start(), "code")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(json(tokens({ expires_in: -1 })));
    await expect(complete(await start(), "code")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the configured OAuth client changes", async () => {
    const connected = await connect();
    const canonical = await db.getConnectedService(connected.connectionId);
    const changed = new NativeGmailOAuthManager({ store: db.nativeGmailStore!, clientId: "other-client", clientSecret: "secret",
      redirectUri: "https://api.matrix-os.com/api/integrations/gmail/callback", encryptionKey: key, fetcher, now: () => now });
    await expect(changed.token({ externalUserId: "external", accountId: canonical!.pipedream_account_id })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not revoke Google grants concurrently with a new consent exchange", async () => {
    const connected = await connect();
    const state = await start();
    fetcher.mockImplementationOnce(async () => {
      await expect(manager.revoke({ userId, connectionId: connected.connectionId })).rejects.toThrow();
      return json(tokens());
    }).mockResolvedValueOnce(json({ emailAddress: "mail@example.test" }));
    await complete(state, "code");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("binds ciphertext to the exact owner and native Gmail account", async () => {
    const connected = await connect();
    const first = await db.nativeGmailStore!.byConnection({ userId, connectionId: connected.connectionId });
    const other = await db.nativeGmailStore!.connect({ userId, externalUserId: "external", email: "other@example.test",
      label: "Other", scopes: [GMAIL_SCOPE], encrypt: () => first!.encryptedCredentials, now: new Date(now) });
    await expect(manager.token({ externalUserId: "external", accountId: other.accountId })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("revokes expired credentials only on typed provider confirmation", async () => {
    const connected = await connect();
    await db.updateServiceStatus(connected.connectionId, "expired");
    fetcher.mockResolvedValueOnce(json({ error: "invalid_request" }, 400));
    await expect(manager.revoke({ userId, connectionId: connected.connectionId })).rejects.toThrow();
    expect(await db.getConnectedService(connected.connectionId)).not.toBeNull();
    fetcher.mockResolvedValueOnce(json({ error: "invalid_token" }, 400));
    expect(await manager.revoke({ userId, connectionId: connected.connectionId })).toBe(true);
  });

  it("bounds a stalled response stream and propagates caller cancellation", async () => {
    const connected = await connect();
    const canonical = await db.getConnectedService(connected.connectionId);
    now += 3_700_000;
    const controller = new AbortController();
    fetcher.mockImplementationOnce(async () => {
      setTimeout(() => controller.abort(), 5);
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("{")); } }));
    });
    await expect(manager.token({ externalUserId: "external", accountId: canonical!.pipedream_account_id }, controller.signal)).rejects.toThrow();
    expect(await db.nativeGmailStore!.lookup({ externalUserId: "external", accountId: canonical!.pipedream_account_id })).not.toBeNull();
  });

  it("rejects forged browser proof before consumption or exchange", async () => {
    const state = await start();
    await expect(manager.complete(state, "code", "a".repeat(64))).rejects.toThrow();
    await expect(manager.cancel(state, "a".repeat(64))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await manager.authorization(state, { userId })).url).toContain(state);
  });

  it("wraps callback exchange and persistence in immutable owner admission", async () => {
    const admit = vi.fn(async (_id, persist) => persist());
    const admitted = new NativeGmailOAuthManager({ store: db.nativeGmailStore!, clientId: "client", clientSecret: "secret",
      redirectUri: "https://api.matrix-os.com/api/integrations/gmail/callback", encryptionKey: key, fetcher, now: () => now, admit });
    fetcher.mockResolvedValueOnce(json(tokens())).mockResolvedValueOnce(json({ emailAddress: "mail@example.test" }));
    const url = new URL((await admitted.start({ userId, externalUserId: "external" })).url);
    const browser = await admitted.authorization(url.searchParams.get("state")!, { userId });
    await admitted.complete(url.searchParams.get("state")!, "code", browser.browserProof);
    expect(admit).toHaveBeenCalledWith(userId, expect.any(Function));
  });
});
