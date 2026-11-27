/**
 * Connect Apps adapter contracts (spec 2691): what Core advertises matches
 * what execution enforces, and a dispatched write is never abandoned.
 * Real registry and adapter; only the connection store and the provider
 * execution are faked.
 */
import { describe, expect, it } from "vitest";
import { createCoreConnectedApps } from "../../packages/gateway/src/integrations/custom-mcp/core-connected-apps.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const userId = "11111111-1111-4111-8111-111111111111";

function store(service: string, accountId = "apn_1") {
  const row = { id: "22222222-2222-4222-8222-222222222222", user_id: userId, service, pipedream_account_id: accountId,
    account_label: service, account_email: "owner@example.test", scopes: [], status: "active" as const,
    connected_at: new Date(), last_used_at: null };
  return {
    connectionId: row.id,
    db: {
      listConnectedServices: async () => [row],
      getUserById: async () => ({ pipedream_external_id: "pd-ext" }) as never,
      touchServiceUsage: async () => {},
    },
  };
}

function deferred() {
  let resolve!: (value: { data: unknown }) => void;
  const promise = new Promise<{ data: unknown }>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Connect Apps adapter", () => {
  it("keeps native Gmail out of the Pipedream-only Core adapter", async () => {
    const { db, connectionId } = store("gmail", "gmail_33333333-3333-4333-8333-333333333333");
    const apps = createCoreConnectedApps({ db, pipedream: {} as PipedreamConnectClient,
      execute: async () => { throw new Error("must not dispatch"); } });
    const legacy = createCoreConnectedApps({ db: store("gmail").db, pipedream: {} as PipedreamConnectClient });
    const [gmail] = await legacy.list(userId);
    const read = gmail!.tools.find(tool => tool.risk === "read")!;
    await expect(apps.list(userId)).resolves.toEqual([]);
    await expect(apps.call({ userId, connectionId, action: read.name, signal: AbortSignal.timeout(1000) }))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("lets a dispatched write finish and report its real result after the caller cancels", async () => {
    // Fault: Core reports "cancelled" while the provider write still lands, inviting a duplicate retry.
    const { db, connectionId } = store("figma");
    const provider = deferred();
    let dispatched = 0;
    const apps = createCoreConnectedApps({ db, pipedream: {} as PipedreamConnectClient,
      execute: () => { dispatched++; return provider.promise; } });
    const controller = new AbortController();
    const call = apps.call({ userId, connectionId, action: "post_comment",
      arguments: { fileKey: "F", message: "hi" }, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    provider.resolve({ data: { id: "comment-1" } });
    await expect(call).resolves.toEqual({ id: "comment-1" });
    expect(dispatched).toBe(1);
  });

  it("abandons a cancelled read and never dispatches after cancellation", async () => {
    const { db, connectionId } = store("figma");
    const provider = deferred();
    let dispatched = 0;
    const apps = createCoreConnectedApps({ db, pipedream: {} as PipedreamConnectClient,
      execute: () => { dispatched++; return provider.promise; } });
    const controller = new AbortController();
    const read = apps.call({ userId, connectionId, action: "get_file", arguments: { fileKey: "F" }, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await expect(read).rejects.toBeDefined();

    await expect(apps.call({ userId, connectionId, action: "post_comment", arguments: { fileKey: "F", message: "x" },
      signal: AbortSignal.abort() })).rejects.toBeDefined();
    expect(dispatched).toBe(1);
  });

  it("advertises the full action contract, including nullable fields from paramsSchema", async () => {
    // Fault: clients build calls from a schema that omits values execution accepts (Asana dueOn: null clears a date).
    const asana = await createCoreConnectedApps({ db: store("asana").db, pipedream: {} as PipedreamConnectClient }).list(userId);
    const update = asana[0]!.tools.find(tool => tool.name === "update_task")!.inputSchema as {
      $schema?: string; properties: Record<string, { anyOf?: Array<{ type?: string }> }> };
    expect(update.$schema).toBeUndefined();
    expect(update.properties.dueOn!.anyOf?.map(entry => entry.type)).toContain("null");

    const figma = await createCoreConnectedApps({ db: store("figma").db, pipedream: {} as PipedreamConnectClient }).list(userId);
    expect(figma[0]!.tools.find(tool => tool.name === "get_file")!.inputSchema).toMatchObject({ type: "object", required: ["fileKey"] });
    expect(JSON.stringify(figma)).not.toContain("owner@example.test");
  });

  it("refuses inherited property names as actions", async () => {
    const { db, connectionId } = store("figma");
    const apps = createCoreConnectedApps({ db, pipedream: {} as PipedreamConnectClient,
      execute: async () => { throw new Error("must not dispatch"); } });
    await expect(apps.call({ userId, connectionId, action: "constructor", signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "forbidden" });
  });
});
