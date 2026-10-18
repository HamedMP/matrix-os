import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { BRAIN_INTEGRATION_RESPONSE_MAX_BYTES } from "../../packages/gateway/src/brain/contracts.js";
import { createBrainIntegrationCaller } from "../../packages/gateway/src/brain/sources/integration/index.js";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import { BoundedPipedreamReadError } from "../../packages/gateway/src/integrations/pipedream-bounded-get.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { isBrainReadAction } from "../../packages/gateway/src/integrations/registry-brain.js";

// The read-call route a customer gateway's Company Brain sources reach through the platform: their reads are
// byte-capped raw reads the caller's disconnect cancels, never the SDK's buffered parse of a whole response.
describe("read-call for Company Brain reads", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let db: PlatformDb;
  let app: Hono;
  const proxyGet = vi.fn(async () => ({ labels: [] }));
  const boundedProxy = vi.fn(async (_request: unknown, _signal: AbortSignal): Promise<unknown> => [{ id: 1 }]);

  beforeEach(async () => {
    proxyGet.mockClear();
    boundedProxy.mockClear();
    pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();
    const owner = await db.createUser({
      clerkId: "owner_brain_read", handle: "brainread", displayName: "Brain Read", email: "brain@example.invalid",
      containerId: "container_brain_read", pipedreamExternalId: "pd_brain_read",
    });
    for (const service of ["github", "gmail", "google_drive"]) {
      await db.connectService({ userId: owner.id, service, pipedreamAccountId: `pd_${service}`, accountLabel: "Work",
        scopes: ["read"] });
    }
    const provider = { getAppInfo: vi.fn(async () => null), listAccounts: vi.fn(async () => []), proxyGet, boundedProxy };
    app = new Hono();
    app.route("/api/integrations", createIntegrationRoutes({
      db, pipedream: provider as unknown as PipedreamConnectClient, webhookSecret: "test-only-webhook-secret",
      resolveUserId: async () => owner.id,
    }));
  });

  afterEach(async () => { await db.destroy(); });

  const readCall = (body: unknown) => app.request("/api/integrations/read-call", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const reviews = { service: "github", action: "brain_list_pr_reviews", label: "Work", params: { repo: "acme/widgets", number: 12 } };

  it("names the brain reads, and only those", () => {
    expect(isBrainReadAction("github", "brain_list_pr_reviews")).toBe(true);
    expect(isBrainReadAction("google_drive", "brain_export_text")).toBe(true);
    expect(isBrainReadAction("github", "list_repos")).toBe(false);
    expect(isBrainReadAction("gmail", "list_labels")).toBe(false);
    expect(isBrainReadAction("constructor", "toString")).toBe(false);
  });

  it("reads a brain action through the byte-capped proxy with the request's signal", async () => {
    const response = await readCall(reviews);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ id: 1 }], action: "brain_list_pr_reviews" });
    expect(proxyGet).not.toHaveBeenCalled();
    expect(boundedProxy).toHaveBeenCalledTimes(1);
    const [request, signal] = boundedProxy.mock.calls[0]!;
    expect(request).toMatchObject({
      method: "GET", accountId: "pd_github", maxBytes: BRAIN_INTEGRATION_RESPONSE_MAX_BYTES,
      url: "https://api.github.com/repos/acme/widgets/pulls/12/reviews",
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses an oversized brain answer early instead of buffering it, and leaves other reads as they were", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    boundedProxy.mockRejectedValueOnce(new BoundedPipedreamReadError());
    const refused = await readCall(reviews);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "Integration call failed" });
    expect(proxyGet).not.toHaveBeenCalled();
    expect((await readCall({ service: "gmail", action: "list_labels", label: "Work", params: {} })).status).toBe(200);
    expect(proxyGet).toHaveBeenCalledTimes(1);
    expect(boundedProxy).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("hands a full-size export to a remote caller although JSON escaping makes the reply larger", async () => {
    // Exactly the raw-byte cap, and the worst case for escaping: each byte is six in the JSON reply (\u0001).
    const text = "\u0001".repeat(BRAIN_INTEGRATION_RESPONSE_MAX_BYTES);
    boundedProxy.mockResolvedValueOnce(text);
    const caller = createBrainIntegrationCaller({
      internalBaseUrl: "https://platform.test/api/integrations", machineToken: "machine-token",
      fetch: (async (url: string, init: RequestInit) => app.request(new URL(url).pathname, init)) as typeof fetch,
    });
    const exported = await caller.call("owner_brain_read", {
      service: "google_drive", action: "brain_export_text", label: "Work", params: { fileId: "doc_1" },
    }, new AbortController().signal);
    expect(exported.status).toBe("ok");
    expect(exported.status === "ok" && exported.data === text).toBe(true);
    expect(boundedProxy.mock.calls[0]![0]).toMatchObject({
      accountId: "pd_google_drive", maxBytes: BRAIN_INTEGRATION_RESPONSE_MAX_BYTES,
    });
  });
});
