import { randomBytes } from "node:crypto";
import pg from 'pg';
import { PostgresDialect } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { createTestIntegrationDb } from "./native-integration-db-test-helper.js";

const callbackUrl = "https://app.example.test/api/integrations/gmail/pipedream/callback";
describe("Gmail Pipedream attempt receipts", () => {
  let db: PlatformDb;
  let owner: string | null;
  let app: ReturnType<typeof createIntegrationRoutes>;
  let pipedream: PipedreamConnectClient;
  let issued: Array<{ token: string; webhookUri: string; scope?: string }>;
  let eligible: boolean;
  const inspectAccount = vi.fn();
  let admit = vi.fn(async (_input: unknown, persist: () => Promise<void>) => persist());
  const metadata = { id: "apn_work", externalUserId: "pd_owner", app: "gmail", healthy: true, dead: false };
  beforeEach(async () => {
    ({ db } = await createTestIntegrationDb());
    if (process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL) {
      // Use a real multi-connection pool for races; the fixture manager keeps its
      // independent owner connection until after our pool drains in afterEach.
      const database = (await db.raw("SELECT current_database() AS name", [])).rows[0]!.name;
      const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL);
      url.pathname = "/" + String(database);
      db = createPlatformDb({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url.href, max: 10 }) }) });
      await db.migrate();
    }
    owner = (await db.createUser({ clerkId: "attempt-owner", handle: "attemptowner", displayName: "Owner", email: "owner@example.invalid", containerId: "attempt-owner", pipedreamExternalId: "pd_owner" })).id;
    issued = []; eligible = true; inspectAccount.mockReset(); inspectAccount.mockResolvedValue(metadata);
    admit = vi.fn(async (_input, persist) => persist());
    pipedream = { inspectAccount, revokeAccount: vi.fn(async () => { inspectAccount.mockResolvedValue({ ...metadata, healthy: false, dead: true }); }),
      createConnectToken: vi.fn(async (_id, options) => {
        const token = "ctok_" + randomBytes(16).toString("hex");
        issued.push({ token, webhookUri: options?.webhookUri ?? "", ...(options?.scope ? { scope: options.scope } : {}) });
        return { token, expiresAt: new Date(Date.now() + 600_000).toISOString(), connectLinkUrl: "https://pipedream.com/connect?token=" + token };
      }), getOAuthUrl: (url: string) => url,
      listAccounts: vi.fn(async () => []), getAppInfo: vi.fn(async () => null), discoverActions: vi.fn(async () => []),
    } as unknown as PipedreamConnectClient;
    app = createIntegrationRoutes({ db, pipedream, webhookSecret: "legacy-test-secret", resolveUserId: async () => owner,
      verifiedConnectedWebhook: (input, persist) => admit(input, persist), nativeGmailEligible: async () => eligible,
      pipedreamGmailAttempts: { callbackUrl, environment: "production" } });
  });
  afterEach(async () => { await db.destroy(); vi.restoreAllMocks(); });
  async function start(label?: string) {
    const result = await app.request("/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "gmail", connectionMethod: "pipedream", ...(label ? { label } : {}) }) });
    expect(result.status).toBe(200);
    const body = await result.json() as { url: string; service: string; attemptId: string };
    expect(body.attemptId).toMatch(/^[a-f0-9-]{36}$/);
    const proof = new URL(issued.at(-1)!.webhookUri).searchParams.get("proof")!;
    expect(proof).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain(proof);
    expect(JSON.stringify(body)).not.toContain("webhook");
    return body;
  }
  function callback(index: number, override: Record<string, unknown> = {}, proof?: string) {
    const issuedAttempt = issued[index]!;
    const url = new URL(issuedAttempt.webhookUri);
    if (proof !== undefined) url.searchParams.set("proof", proof);
    return app.request(url.pathname.replace(/^\/api\/integrations/, "") + url.search, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      event: "CONNECTION_SUCCESS", connect_token: issuedAttempt.token, environment: "production", connect_session_id: 1.4058728083872854e38,
      account: { id: "apn_work", external_id: "pd_owner", healthy: true, dead: false, app: { name_slug: "gmail" } }, ...override,
    }) });
  }
  const status = async (id: string) => (await app.request("/gmail/pipedream/attempts/" + id));
  it.each(['production', 'gmail-pilot'] as const)('enforces the exact %s callback through receipt and legacy factories', async nativeMobileTarget => {
    for (const receipts of [false, true]) {
      const router = createIntegrationRoutes({ db, pipedream, nativeMobileTarget, webhookSecret: 'test', resolveUserId: async () => owner,
        nativeGmailEligible: async () => receipts, verifiedConnectedWebhook: (input, persist) => admit(input, persist),
        ...(receipts ? { pipedreamGmailAttempts: { callbackUrl, environment: 'production' as const } } : {}) });
      const expected = nativeMobileTarget === 'production' ? 'matrixos://integrations' : 'matrixos-gmail-pilot://integrations';
      const wrong = nativeMobileTarget === 'production' ? 'matrixos-gmail-pilot://integrations' : 'matrixos://integrations';
      for (const redirectUri of [wrong, expected + '/', expected + '?next=evil', 'https://untrusted.invalid', 'matrixos-gmail-pilot://sso-callback']) {
        expect((await router.request('/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'gmail', connectionMethod: 'pipedream', redirectUri }) })).status).toBe(400);
      }
      const before = issued.length;
      const response = await router.request('/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'gmail', connectionMethod: 'pipedream', redirectUri: expected }) });
      expect(response.status).toBe(200); expect(issued).toHaveLength(before + 1);
      expect(pipedream.createConnectToken).toHaveBeenLastCalledWith('pd_owner', expect.objectContaining({ successRedirectUri: expected, errorRedirectUri: expected }));
      if (receipts) expect((await response.json()).attemptId).toBeDefined();
    }
  });
  it('fixes receipt token scope server-side and ignores browser-requested capabilities', async () => {
    const response = await app.request('/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'gmail', connectionMethod: 'pipedream', scope: 'connect:*' }) });
    expect(response.status).toBe(200);
    expect(issued[0]!.scope).toBe('connect:accounts:read connect:accounts:write');
    expect(pipedream.createConnectToken).toHaveBeenCalledWith('pd_owner', expect.objectContaining({ scope: 'connect:accounts:read connect:accounts:write', expiresIn: 600 }));
  });
  it("completes exactly one receipt and preserves a same-ID account and its renamed label", async () => {
    const original = await db.connectService({ userId: owner!, service: "gmail", pipedreamAccountId: "apn_work", accountLabel: "Finance", scopes: ["read"] });
    const attempt = await start();
    expect(await (await status(attempt.attemptId)).json()).toEqual({ status: "pending" });
    expect((await callback(0)).status).toBe(200);
    expect(await (await status(attempt.attemptId)).json()).toEqual({ status: "succeeded", accountId: original.id });
    expect((await db.getConnectedService(original.id))!.account_label).toBe("Finance");
    expect((await db.getConnectedService(original.id))!.scopes).toEqual(["read"]);
    expect((await callback(0)).status).toBe(200);
    expect(inspectAccount).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(1);
  });
  it("keeps an old callback and its replay out of a newer attempt", async () => {
    const first = await start("First"); const second = await start("Second");
    expect((await callback(0)).status).toBe(200);
    expect((await callback(0)).status).toBe(200);
    expect(await (await status(second.attemptId)).json()).toEqual({ status: "pending" });
    expect((await callback(1)).status).toBe(200);
    const result = await (await status(second.attemptId)).json();
    expect(result.status).toBe("succeeded");
    expect((await db.getConnectedService(result.accountId))!.account_label).toBe("Second");
    expect((await (await status(first.attemptId)).json()).status).toBe("succeeded");
  });
  it("rejects mismatched nonce, token, environment and account binding without consuming the receipt", async () => {
    const attempt = await start();
    expect((await callback(0, {}, "0".repeat(64))).status).toBe(403);
    expect((await callback(0, { connect_token: "ctok_" + "0".repeat(32) })).status).toBe(403);
    expect((await callback(0, { environment: "development" })).status).toBe(403);
    inspectAccount.mockResolvedValue({ ...metadata, externalUserId: "other" });
    expect((await callback(0)).status).toBe(403);
    expect(await (await status(attempt.attemptId)).json()).toEqual({ status: "pending" });
    expect(await db.listConnectedServices(owner!)).toEqual([]);
  });
  it("fails closed on provider errors/unhealthy accounts and deletion admission", async () => {
    const attempt = await start();
    inspectAccount.mockRejectedValueOnce(new Error("private-provider-failure"));
    const failed = await callback(0); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private-provider");
    inspectAccount.mockResolvedValueOnce({ ...metadata, healthy: false });
    expect((await callback(0)).status).toBe(403);
    admit.mockImplementationOnce(async () => {});
    expect((await callback(0)).status).toBe(200);
    expect(await (await status(attempt.attemptId)).json()).toEqual({ status: "failed" });
    expect(await db.listConnectedServices(owner!)).toEqual([]);
  });
  it("serializes duplicate callbacks and rolls back both receipt and projection on failure", async () => {
    const attempt = await start();
    await db.raw("CREATE FUNCTION deny_attempt_success() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$", []);
    await db.raw("CREATE TRIGGER deny_attempt_success BEFORE UPDATE ON gmail_pipedream_attempts FOR EACH ROW EXECUTE FUNCTION deny_attempt_success()", []);
    expect((await callback(0)).status).toBe(503);
    expect(await db.listConnectedServices(owner!)).toEqual([]);
    expect(await (await status(attempt.attemptId)).json()).toEqual({ status: "pending" });
    await db.raw("DROP TRIGGER deny_attempt_success ON gmail_pipedream_attempts", []);
    const responses = await Promise.all([callback(0), callback(0)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await db.listConnectedServices(owner!)).toHaveLength(1);
    expect((await (await status(attempt.attemptId)).json()).status).toBe("succeeded");
  });
  it('checks provider availability after owner admission so a queued callback cannot undo disconnect', async () => {
    const original = await db.connectService({ userId: owner!, service: 'gmail', pipedreamAccountId: 'apn_work', accountLabel: 'Work', scopes: [] });
    const attempt = await start();
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    admit.mockImplementationOnce(async (_input, persist) => { enter(); await released; await persist(); });
    const queued = callback(0);
    await entered;
    const removed = await app.request('/' + original.id, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    release();
    expect((await queued).status).toBe(403);
    expect(await db.listConnectedServices(owner!)).toEqual([]);
    expect(await (await status(attempt.attemptId)).json()).toEqual({ status: 'pending' });
  });
  it("caps simultaneous owner starts and cleans expired records without exposing secrets", async () => {
    const request = () => app.request("/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "gmail", connectionMethod: "pipedream" }) });
    // PGlite has one connection and cannot model concurrent transactions.
    const responses: Response[] = [];
    if (process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL) responses.push(...await Promise.all(Array.from({ length: 10 }, request)));
    else for (let i = 0; i < 10; i++) responses.push(await request());
    expect(responses.filter(response => response.status === 200)).toHaveLength(8);
    const rows = await db.raw("SELECT nonce_hash,token_hash FROM gmail_pipedream_attempts", []);
    expect(rows.rows).toHaveLength(8);
    expect(rows.rows.every(row => /^[a-f0-9]{64}$/.test(String(row.nonce_hash)) && /^[a-f0-9]{64}$/.test(String(row.token_hash)))).toBe(true);
    await db.raw("UPDATE gmail_pipedream_attempts SET expires_at=now()-interval '1 second'", []);
    await db.pipedreamGmailAttempts!.cleanup();
    expect((await db.raw("SELECT id FROM gmail_pipedream_attempts", [])).rows).toEqual([]);
  });
  it("handles provider connection errors and malformed/oversized payloads safely", async () => {
    const attempt = await start();
    const uri = new URL(issued[0]!.webhookUri);
    const path = uri.pathname.replace(/^\/api\/integrations/, "") + uri.search;
    expect((await app.request(path, { method: "POST", body: "{" })).status).toBe(400);
    expect((await app.request(path, { method: "POST", body: "x".repeat(70_000) })).status).toBe(413);
    expect((await callback(0, { event: "CONNECTION_ERROR", error: "private-provider-error" })).status).toBe(200);
    expect(await (await status(attempt.attemptId)).json()).toEqual({ status: "failed" });
    expect((await callback(0)).status).toBe(200);
    expect(await db.listConnectedServices(owner!)).toEqual([]);
  });
  it("keeps legacy services unchanged and removes receipt access when the flag is off", async () => {
    const attempt = await start();
    const other = await app.request('/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'slack' }) });
    expect(other.status).toBe(200); expect(await other.json()).not.toHaveProperty('attemptId');
    expect(issued[1]!.webhookUri).toBe('');
    expect(issued[1]!.scope).toBeUndefined();
    app = createIntegrationRoutes({ db, pipedream, webhookSecret: 'legacy-test-secret', resolveUserId: async () => owner });
    expect((await status(attempt.attemptId)).status).toBe(404);
    expect((await callback(0)).status).toBe(404);
    expect(await db.pipedreamGmailAttempts!.status(attempt.attemptId, owner!)).toEqual({ status: 'pending' });
    await db.raw("UPDATE gmail_pipedream_attempts SET expires_at=now()-interval '1 second'", []);
    await db.migrate(); // Store cleanup runs even when receipt routes are disabled.
    expect((await db.raw('SELECT id FROM gmail_pipedream_attempts', [])).rows).toEqual([]);
  });
  it('keeps non-pilot Gmail on legacy consent while a stored pilot attempt remains isolated', async () => {
    const pilot = await start();
    eligible = false;
    const response = await app.request('/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'gmail', connectionMethod: 'pipedream' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('attemptId');
    expect(issued[1]!.webhookUri).toBe('');
    expect(issued[1]!.scope).toBeUndefined();
    expect(await db.pipedreamGmailAttempts!.status(pilot.attemptId, owner!)).toEqual({ status: 'pending' });
    expect((await db.raw('SELECT id FROM gmail_pipedream_attempts', [])).rows).toHaveLength(1);
  });
  it('fails closed when platform owner admission is absent', () => {
    expect(() => createIntegrationRoutes({ db, pipedream, webhookSecret: 'legacy-test-secret', resolveUserId: async () => owner,
      nativeGmailEligible: async () => true, pipedreamGmailAttempts: { callbackUrl, environment: 'production' } })).toThrow('Gmail connection receipts unavailable');
  });
  it("authenticates status, validates IDs and expires callbacks without projection", async () => {
    const attempt = await start();
    const originalOwner = owner; owner = null; expect((await status(attempt.attemptId)).status).toBe(401);
    owner = (await db.createUser({ clerkId: "other", handle: "other", displayName: "Other", email: "other@example.invalid", containerId: "other" })).id;
    expect((await status(attempt.attemptId)).status).toBe(404);
    owner = originalOwner; expect((await status("invalid")).status).toBe(400);
    await db.raw("UPDATE gmail_pipedream_attempts SET expires_at = now() - interval '1 second' WHERE id=$1", [attempt.attemptId]);
    expect(await (await status(attempt.attemptId)).json()).toEqual({ status: "expired" });
    expect((await callback(0)).status).toBe(200);
    expect(await db.listConnectedServices(owner!)).toEqual([]);
  });
});
