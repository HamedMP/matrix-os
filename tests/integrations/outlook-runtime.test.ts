import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { createPlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import { createUnavailablePipedreamClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { createOutlookRuntime } from "../../packages/gateway/src/integrations/outlook/runtime.js";

const service = "microsoft_outlook";
const redirectUri = "https://app.matrix-os.com/api/integrations/outlook/oauth/callback";

describe("Outlook lifecycle through the existing integration routes", () => {
  let db: ReturnType<typeof createPlatformDb>;
  let ownerId: string;

  beforeEach(async () => {
    db = createPlatformDb({ dialect: (await createTestPGlite()).dialect });
    await db.migrate();
    ownerId = (await db.createUser({
      clerkId: "user_owner", handle: "owner", displayName: "Owner",
      email: "owner@example.com", containerId: "owner-machine",
    })).id;
  });

  afterEach(async () => {
    await db?.destroy();
  });

  it("connects, performs an exact scoped read, refreshes and disconnects without Pipedream", async () => {
    const tokens = { access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(tokens))
      .mockResolvedValueOnce(Response.json({ id: "graph-id", mail: "outlook@example.com" }))
      .mockResolvedValueOnce(Response.json({ value: [{ id: "message" }] }))
      .mockResolvedValueOnce(Response.json({ ...tokens, refresh_token: "refreshed" }));
    const outlook = await createOutlookRuntime({
      db, clientId: "99c876a4-a5bd-4ad4-82ab-80a7d58ca7ad", clientSecret: "client-secret",
      encryptionKey: Buffer.alloc(32, 19).toString("hex"), redirectUri, fetcher,
    });
    const pipedream = createUnavailablePipedreamClient();
    const app = createIntegrationRoutes({
      db, pipedream, webhookSecret: "", outlook, outlookGraph: outlook.graph, pipedreamAvailable: false,
      resolveUserId: async context => context.req.header("x-test-owner") === "owner" ? ownerId : null,
    });
    const req = (path: string, method = "GET", body?: unknown) => app.request(path, {
      method, headers: { "x-test-owner": "owner", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const started = await req("/connect", "POST", { service, label: "Work", redirectUri: "matrixos://integrations" });
    expect(started.status).toBe(200);
    const authorize = new URL((await started.json()).url);
    const launchPath = "/outlook/oauth/authorize" + authorize.search;
    expect((await app.request(launchPath)).status).toBe(401);
    const launch = await req(launchPath);
    expect(launch.status).toBe(302);
    const browserCookie = launch.headers.get("set-cookie")!;
    expect(browserCookie).toContain("SameSite=None");
    expect(browserCookie).toContain("HttpOnly");
    const complete = await app.request("/outlook/oauth/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Cookie: browserCookie.split(";")[0] },
      body: new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "microsoft-code" }),
    });
    expect(complete.status).toBe(303);
    expect(complete.headers.get("location")).toBe("matrixos://integrations");
    const [connection] = await (await req("/")).json();
    expect(connection).toMatchObject({ service, account_label: "Work", account_email: "outlook@example.com", outlook_connection: "matrix" });
    expect(connection).not.toHaveProperty("pipedream_account_id");
    const binding = { connectionId: connection.id, service, accountLabel: "Work", expectedEmail: "outlook@example.com" };
    const read = await req("/read-call", "POST", { service, action: "list_messages", label: "Work", accountBinding: binding });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ data: { value: [{ id: "message" }] } });
    expect((await req(`/${connection.id}/refresh`, "POST")).status).toBe(200);
    expect((await req(`/${connection.id}`, "DELETE")).status).toBe(200);
    expect(await (await req("/")).json()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect((await db.getUserById(ownerId))?.pipedream_external_id).toBeNull();
  });
});
