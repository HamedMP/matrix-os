import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createLocalIntegrationTransport } from "../../packages/gateway/src/bots/integration-client.js";
import { createAppIntegrationReadRoutes, createAppIntegrationReadService, createRuntimeAppIntegrationReadService } from "../../packages/gateway/src/integrations/app-read-bridge.js";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";

describe("owner app integration read bridge", () => {
  let home: string;
  const call = vi.fn(async () => ({ data: { number: 1 } }));
  const inventory = vi.fn(async () => [
    { service: "github", connectionId: "owned-a", label: "Work" },
    { service: "github", connectionId: "owned-b", label: "Work" },
  ]);
  let app: Hono;
  let principal = "owner";
  const grant = { app: "briefing", service: "github", actions: ["list_prs"], connectionIds: ["owned-b"], params: { repo: "example/project" } };
  const input = { app: "briefing", service: "github", action: "list_prs", connectionId: "owned-b", label: "Work", params: { repo: "example/project" } };

  beforeEach(async () => {
    call.mockClear(); inventory.mockClear(); principal = "owner";
    home = await mkdtemp(join(tmpdir(), "app-read-"));
    await mkdir(join(home, "system")); await mkdir(join(home, "apps/briefing"), { recursive: true });
    await writeFile(join(home, "system/app-integrations.json"), JSON.stringify({ grants: [grant] }));
    await writeFile(join(home, "apps/briefing/matrix.json"), JSON.stringify({ slug: "briefing", permissions: ["integrations:github:read"] }));
    app = createAppIntegrationReadRoutes({ homePath: home, ownerIds: ["owner"], getPrincipal: () => ({ userId: principal }), client: { call, inventory } as never });
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  const post = (body: unknown) => app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("projects only granted account IDs and calls selected scoped read", async () => {
    expect(await (await app.request("/?app=briefing")).json()).toEqual({ connections: [{ service: "github", connectionId: "owned-b", label: "Work", actions: ["list_prs"] }] });
    expect((await post(input)).status).toBe(200);
    expect(call).toHaveBeenCalledWith("owner", expect.objectContaining({ service: input.service, action: input.action, connectionId: input.connectionId, label: input.label, params: input.params, read: true }), expect.any(AbortSignal));
  });
  it("denies foreign principal, forged app, account, action and source scopes before transport", async () => {
    principal = "other"; expect((await post(input)).status).toBe(403); principal = "owner";
    for (const change of [{ app: "another" }, { action: "create_issue" }, { connectionId: "owned-a" }, { params: { repo: "example/other" } }]) {
      expect((await post({ ...input, ...change })).status).toBe(403);
    }
    expect(call).not.toHaveBeenCalled();
  });
  it("does not let the manifest grant itself access or retain revoked grants", async () => {
    await rm(join(home, "system/app-integrations.json"));
    expect((await post(input)).status).toBe(403);
    await writeFile(join(home, "system/app-integrations.json"), JSON.stringify({ grants: [grant] }));
    await writeFile(join(home, "apps/briefing/matrix.json"), JSON.stringify({ slug: "briefing", permissions: [] }));
    expect((await post(input)).status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });
  it("revalidates grants and labels after inventory before dispatch", async () => {
    inventory.mockImplementationOnce(async () => {
      await writeFile(join(home, "system/app-integrations.json"), JSON.stringify({ grants: [] }));
      return [{ service: "github", connectionId: "owned-b", label: "Work" }];
    });
    expect((await post(input)).status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });
  it("rechecks current fixed scopes without replaying the source read before a job commits", async () => {
    const service = createAppIntegrationReadService({ homePath: home, ownerIds: ["owner"], client: { call, inventory } as never });
    await service.authorize({ ownerId: "owner", ...input }, new AbortController().signal);
    expect(call).not.toHaveBeenCalled();
    await writeFile(join(home, "system/app-integrations.json"), JSON.stringify({ grants: [{ ...grant, params: { repo: "example/changed" } }] }));
    await expect(service.authorize({ ownerId: "owner", ...input }, new AbortController().signal)).rejects.toMatchObject({ code: "denied" });
    expect(call).not.toHaveBeenCalled();
  });

  it("runs the actual owner bridge through scoped transport and read-call to the selected provider", async () => {
    const provider = { proxyGet: vi.fn(async () => [{ number: 1, head: { sha: "a".repeat(40) } }]) };
    const connections = [
      { id: "owned-a", service: "github", account_label: "Work", status: "active", pipedream_account_id: "pd_a" },
      { id: "owned-b", service: "github", account_label: "Work", status: "active", pipedream_account_id: "pd_b" },
    ];
    const upstream = new Hono();
    upstream.get("/", c => c.json(connections));
    upstream.route("/", createIntegrationReadCallRoutes({ db: { listConnectedServices: async () => connections,
      getUserById: async () => ({ pipedream_external_id: "owner" }), touchServiceUsage: vi.fn(),
    } as never, pipedream: provider as never, resolveUserId: async c => c.req.header("x-platform-user-id") ?? null }));
    const transport = vi.fn(createLocalIntegrationTransport(upstream));
    const service = createRuntimeAppIntegrationReadService({ homePath: home, ownerIds: ["owner"], transport });
    const integrated = createAppIntegrationReadRoutes({ homePath: home, ownerIds: ["owner"], client: null, service, getPrincipal: () => ({ userId: "owner" }) });
    const response = await integrated.request("/", { method: "POST", headers: { "content-type": "application/json", "x-platform-user-id": "forged" }, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ number: 1, head: { sha: "a".repeat(40) } }] });
    expect(transport).toHaveBeenCalledWith("owner", expect.objectContaining({ path: "/read-call", readScope: true, body: expect.objectContaining({ connectionId: "owned-b", label: "Work" }) }));
    expect(provider.proxyGet).toHaveBeenCalledWith(expect.objectContaining({ externalUserId: "owner", accountId: "pd_b", url: "https://api.github.com/repos/example/project/pulls" }));
  });
  it("bounds concurrent manual and scheduler reads on their shared service", async () => {
    const release: Array<() => void> = [];
    const blocked = vi.fn(() => new Promise<typeof input[]>(resolve => { release.push(() => resolve([{ ...input, service: "github" }])); }));
    const client = { inventory: blocked, call };
    const service = createAppIntegrationReadService({ homePath: home, ownerIds: ["owner"], client: client as never });
    const pending = Array.from({ length: 4 }, () => service.read({ ownerId: "owner", ...input }, new AbortController().signal));
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(4));
    await expect(service.read({ ownerId: "owner", ...input }, new AbortController().signal)).rejects.toMatchObject({ code: "busy" });
    for (const resume of release) resume();
    await Promise.all(pending);
  });

  it("permits48 reads plus precommit and postsummary rechecks without spending provider admission", async () => {
    const service = createAppIntegrationReadService({ homePath: home, ownerIds: ["owner"], client: { call, inventory } as never });
    const signal = new AbortController().signal;
    for (let index = 0; index < 48; index++) {
      await service.read({ ownerId: "owner", ...input }, signal);
      await service.authorize({ ownerId: "owner", ...input }, signal);
      await service.authorize({ ownerId: "owner", ...input }, signal);
    }
    expect(call).toHaveBeenCalledTimes(48);
    // Revalidation did not dispatch provider actions or widen the public read budget.
    for (let index = 48; index < 120; index++) await service.read({ ownerId: "owner", ...input }, signal);
    await expect(service.read({ ownerId: "owner", ...input }, signal)).rejects.toMatchObject({ code: "busy" });
    expect(call).toHaveBeenCalledTimes(120);
  });

  it("returns safe errors and validates body and query before transport", async () => {
    expect((await post({ ...input, params: { repo: "example/project", huge: "a".repeat(40_000) } })).status).toBe(400);
    expect((await post({ ...input, ownerId: "owner" })).status).toBe(400);
    expect((await app.request("/?app=../system")).status).toBe(400);
    expect((await app.request("/?app=briefing&owner=other")).status).toBe(400);
    expect((await post({ ...input, params: { huge: "a".repeat(70_000) } })).status).toBe(413);
    call.mockRejectedValueOnce(new Error("private upstream credential"));
    const failed = await post(input); expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private upstream");
  });
});

describe("exact owner read account selection", () => {
  const provider = { proxyGet: vi.fn(async () => []) };
  const db = { listConnectedServices: vi.fn(async () => [
    { id: "a", service: "github", account_label: "Work", pipedream_account_id: "pd_a" },
    { id: "b", service: "github", account_label: "Work", pipedream_account_id: "pd_b" },
  ]), getUserById: vi.fn(async () => ({ pipedream_external_id: "owner" })), touchServiceUsage: vi.fn() };
  const app = new Hono(); app.route("/", createIntegrationReadCallRoutes({ db: db as never, pipedream: provider as never, resolveUserId: async () => "owner" }));
  const request = (connectionId?: string, label = "Work") => app.request("/read-call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "github", action: "list_prs", label, ...(connectionId ? { connectionId } : {}), params: { repo: "example/project" } }) });
  it("selects an exact owned ID while preserving legacy duplicate-label refusal", async () => {
    expect((await request()).status).toBe(409);
    expect((await request("b")).status).toBe(200);
    expect(provider.proxyGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "pd_b" }));
    provider.proxyGet.mockClear();
    expect((await request("foreign")).status).toBe(400);
    expect((await request("b", "Renamed")).status).toBe(400);
    expect(provider.proxyGet).not.toHaveBeenCalled();
  });
});
