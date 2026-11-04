import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppCapabilityRoutes } from "../../../packages/gateway/src/app-capabilities/routes";
import { createAppChatRuntime } from "../../../packages/gateway/src/app-capabilities/chats";
import { invalidateAppIndexCache } from "../../../packages/gateway/src/app-runtime/app-index";
import { APP_CHAT_OPERATIONS, AppChatRequestSchema } from "../../../packages/contracts/src/app-chats";

const chatId = "chat_0123456789abcdef";
const runId = "run_0123456789abcdef";
const principal = { userId: "owner", source: "configured" } as never;
let home: string;
let sinks: Array<(input: { owner: { type: string; ownerId: string }; event: unknown }) => void>;
let replay: ReturnType<typeof vi.fn>;
let service: Record<string, ReturnType<typeof vi.fn>>;
let runtime: ReturnType<typeof createAppChatRuntime>;

const record = { chat: { id: chatId } };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "app-chats-"));
  await Promise.all([mkdir(join(home, "system")), mkdir(join(home, "apps"))]);
  sinks = [];
  replay = vi.fn(async () => ({ events: [], gap: false }));
  service = {
    navigation: vi.fn(async () => ({ version: 1, items: [], truncated: false })),
    list: vi.fn(async () => ({ chats: [] })),
    updateUserState: vi.fn(async () => { throw new Error("private database detail"); }),
    submitApproval: vi.fn(async () => { throw new Error("unexpected"); }),
    delete: vi.fn(async () => ({ chatId, deletedAt: "2026-11-05T00:00:00.000Z" })),
  };
  runtime = createAppChatRuntime({
    service: service as never,
    catalog: { getCatalog: vi.fn(async () => ({ instances: [] })), refresh: vi.fn() } as never,
    projects: { list: vi.fn(async () => ({ projects: [{ id: "p1", slug: "p1", name: "One" }] })) },
    events: {
      registerOutboxSink: (sink: never) => { sinks.push(sink); return { dispose: () => { sinks = sinks.filter(item => item !== sink); } }; },
      replayOutboxWindow: replay as never,
    },
  });
});
afterEach(async () => { runtime.close(); await rm(home, { recursive: true, force: true }); });

async function installApp(slug: string, manifest: Record<string, unknown> = {}) {
  await mkdir(join(home, "apps", slug), { recursive: true });
  await writeFile(join(home, "apps", slug, "matrix.json"), JSON.stringify({
    name: slug, slug, version: "1.0.0", runtime: "static", runtimeVersion: "^1.0.0",
    scope: "personal", listingTrust: "first_party", ...manifest,
  }));
  invalidateAppIndexCache();
}
async function policy(apps: Record<string, unknown>) {
  await writeFile(join(home, "system/app-capabilities.json"), JSON.stringify({ apps }));
}
function call(request: Record<string, unknown>, app = "board", userId = "owner") {
  const host = new Hono();
  host.route("/", createAppCapabilityRoutes({
    homePath: home, ownerIds: ["owner"], resolveOwner: () => userId, integrations: null, aiAllowed: async () => false,
    chats: { runtime: () => runtime, resolvePrincipal: () => principal },
  }));
  return host.request("/", { method: "POST", body: JSON.stringify({ app, input: { kind: "chats", request } }) });
}
async function reply(request: Record<string, unknown>, app?: string) {
  const response = await call(request, app);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ ok: boolean; status: number; result?: never; error?: { code: string; safeMessage: string; retryable: boolean } }>;
}

describe("app chat authorization", () => {
  it("gives an owner-built first-party app every scope without a policy file", async () => {
    await installApp("board");
    expect((await reply({ op: "access" })).result).toEqual({ scopes: ["read", "organize", "send", "approve", "delete"] });
    expect(await reply({ op: "navigation" })).toMatchObject({ ok: true, result: { items: [] } });
    expect(service.navigation).toHaveBeenCalledWith({ type: "personal", ownerId: "owner" }, expect.objectContaining({ version: 1 }));
  });

  it.each([
    ["community", { listingTrust: "community" }],
    ["hidden", { hidden: true }],
    ["installed", { installed_from: "store" }],
    ["forked", { forked_from: "someone/app" }],
    ["shared", { scope: "shared" }],
  ])("denies a %s app before reaching Chat", async (_label, manifest) => {
    await installApp("board", manifest);
    expect(await reply({ op: "navigation" })).toMatchObject({ ok: false, status: 403, error: { code: "app_chat_denied" } });
    expect(await reply({ op: "access" })).toMatchObject({ ok: true, result: { scopes: [] } });
    expect(service.navigation).not.toHaveBeenCalled();
  });

  it("denies an unknown app and a caller who is not the computer owner", async () => {
    expect(await reply({ op: "navigation" }, "missing")).toMatchObject({ ok: false, status: 403 });
    await installApp("board");
    expect((await call({ op: "navigation" }, "board", "someone-else")).status).toBe(403);
    expect(service.navigation).not.toHaveBeenCalled();
  });

  it("lets the owner grant an imported app exact scopes", async () => {
    await installApp("board", { installed_from: "store" });
    await policy({ board: { chats: ["read"] } });
    expect((await reply({ op: "access" })).result).toEqual({ scopes: ["read"] });
    expect(await reply({ op: "navigation" })).toMatchObject({ ok: true });
    expect(await reply({ op: "delete", chatId, clientRequestId: "req_1" })).toMatchObject({ ok: false, status: 403 });
    expect(service.delete).not.toHaveBeenCalled();
  });

  it("treats a policy entry without chats as a revocation for a trusted app", async () => {
    await installApp("board");
    await policy({ board: { services: {} } });
    expect(await reply({ op: "navigation" })).toMatchObject({ ok: false, status: 403 });
  });

  it("intersects scopes across folder and slug aliases", async () => {
    await installApp("folder", { slug: "board" });
    await policy({ folder: { chats: ["read", "send"] }, board: { chats: ["read"] } });
    expect((await reply({ op: "access" }, "board")).result).toEqual({ scopes: ["read"] });
    expect((await reply({ op: "access" }, "folder")).result).toEqual({ scopes: ["read"] });
  });

  it("applies a revocation on the very next request", async () => {
    await installApp("board");
    expect(await reply({ op: "navigation" })).toMatchObject({ ok: true });
    await policy({ board: { chats: [] } });
    expect(await reply({ op: "navigation" })).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects an operation outside the contract", async () => {
    await installApp("board");
    expect((await call({ op: "credentials" })).status).toBe(400);
  });
});

describe("app chat dispatch", () => {
  beforeEach(() => installApp("board"));

  it("reaches the native route and maps pinning to user state", async () => {
    service.updateUserState!.mockResolvedValueOnce({ chat: { id: chatId } });
    await reply({ op: "setPinned", chatId, pinned: true });
    expect(service.updateUserState).toHaveBeenCalledWith({ type: "personal", ownerId: "owner" }, chatId, { pinned: true });
  });

  it("never returns internal error text to the app", async () => {
    const result = await reply({ op: "setPinned", chatId, pinned: true });
    expect(result).toMatchObject({ ok: false, status: 503, error: { retryable: true } });
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });

  it("validates bodies with the native route schema", async () => {
    expect(await reply({ op: "setTitle", chatId, body: { nonsense: true } })).toMatchObject({ ok: false, status: 400, error: { code: "invalid_request" } });
  });

  it("does not forward platform approval proofs, so proof-gated approvals fail closed", async () => {
    service.submitApproval!.mockResolvedValueOnce({});
    await reply({ op: "submitApproval", chatId, runId, approvalId: "appr_1", body: { clientRequestId: "req_1", decision: "approve" } });
    expect(service.submitApproval).toHaveBeenCalledTimes(1);
    expect(service.submitApproval!.mock.calls[0]![5]).toEqual({});
  });

  it("lists owner projects and the provider catalog", async () => {
    expect((await reply({ op: "projects" })).result).toEqual({ projects: [{ id: "p1", slug: "p1", name: "One" }] });
    expect(await reply({ op: "providers" })).toMatchObject({ ok: true });
  });

  it("reports unavailable while the Chat runtime has not started", async () => {
    runtime.close();
    const host = new Hono();
    host.route("/", createAppCapabilityRoutes({
      homePath: home, ownerIds: ["owner"], resolveOwner: () => "owner", integrations: null, aiAllowed: async () => false,
      chats: { runtime: () => null, resolvePrincipal: () => principal },
    }));
    const response = await host.request("/", { method: "POST", body: JSON.stringify({ app: "board", input: { kind: "chats", request: { op: "navigation" } } }) });
    expect(await response.json()).toMatchObject({ ok: false, status: 503, error: { retryable: true } });
  });
});

describe("app chat route mapping", () => {
  const ids = { chatId, runId, turnId: "cturn_0123456789abcdef", queuedTurnId: "qturn_0123456789abcdef", approvalId: "appr_1", requestId: "req_1" };
  const samples: Record<string, Record<string, unknown>> = {
    navigation: {}, list: { limit: 1 }, search: { query: "x" }, get: { chatId }, turnAdmission: { chatId, clientRequestId: "req_1", requestHash: "a".repeat(64) },
    create: { body: {} }, setTitle: { chatId, body: {} }, setProject: { chatId, body: {} }, setPinned: { chatId, pinned: true }, setReadState: { chatId, body: {} },
    acknowledgeCompletion: { chatId, runId }, sendTurn: { chatId, body: {} }, queueTurn: { chatId, body: {} },
    updateQueuedTurn: { chatId, queuedTurnId: ids.queuedTurnId, body: {} }, cancelQueuedTurn: { chatId, queuedTurnId: ids.queuedTurnId, body: {} },
    reorderQueuedTurns: { chatId, body: {} }, steerRun: { chatId, runId, body: {} }, steerQueuedTurn: { chatId, runId, queuedTurnId: ids.queuedTurnId, body: {} },
    cancelRun: { chatId, runId, body: {} }, submitInput: { chatId, runId, requestId: ids.requestId, body: {} }, retryTurn: { chatId, turnId: ids.turnId, body: {} },
    submitApproval: { chatId, runId, approvalId: ids.approvalId, body: {} }, delete: { chatId, clientRequestId: "req_1" },
  };

  it("covers every forwarded operation", () => {
    const answeredElsewhere = new Set(["access", "events", "projects", "providers"]);
    expect(Object.keys(samples).sort()).toEqual(APP_CHAT_OPERATIONS.filter(operation => !answeredElsewhere.has(operation)).sort());
  });

  it.each(Object.entries(samples))("%s reaches a registered native route", async (op, params) => {
    await installApp("board");
    const routed = createAppChatRuntime({
      service: new Proxy({}, { get: () => async () => ({}) }) as never,
      catalog: { getCatalog: vi.fn(), refresh: vi.fn() } as never,
      projects: { list: vi.fn() },
      events: { registerOutboxSink: () => ({ dispose() {} }), replayOutboxWindow: replay as never },
    });
    const result = await routed.dispatch(principal, AppChatRequestSchema.parse({ op, ...params }), AbortSignal.timeout(5_000));
    routed.close();
    // An unmatched path is Hono's plain 404, reported to the app as not found.
    expect(result.status).not.toBe(404);
  });
});

describe("app chat events", () => {
  const event = { cursor: 7, chatId, revision: 2, eventType: "chat.updated", createdAt: "2026-11-05T00:00:00.000Z", payload: { streamContent: { secret: true } } };
  beforeEach(() => installApp("board"));

  it("returns metadata only and never persisted stream content", async () => {
    replay.mockResolvedValueOnce({ events: [event], gap: false, nextCursor: 7 });
    const result = await reply({ op: "events", cursor: 1 });
    expect(result.result).toEqual({ events: [{ cursor: 7, chatId, revision: 2, eventType: "chat.updated", createdAt: event.createdAt }], gap: false, nextCursor: 7 });
  });

  it("reports a replay gap so the app reloads", async () => {
    replay.mockResolvedValueOnce({ events: [], gap: true, nextCursor: 9 });
    expect((await reply({ op: "events", cursor: 1 })).result).toEqual({ events: [], gap: true, nextCursor: 9 });
  });

  it("wakes a long poll on a committed event for the same owner only", async () => {
    replay.mockResolvedValueOnce({ events: [], gap: false }).mockResolvedValueOnce({ events: [event], gap: false, nextCursor: 7 });
    const pending = reply({ op: "events", cursor: 1, waitMs: 20_000 });
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sinks.length).toBeGreaterThan(0));
    sinks[0]!({ owner: { type: "personal", ownerId: "other" }, event });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(replay).toHaveBeenCalledTimes(1);
    sinks[0]!({ owner: { type: "personal", ownerId: "owner" }, event });
    expect((await pending).result).toMatchObject({ nextCursor: 7 });
  });

  it("returns an empty batch when the wait expires", async () => {
    expect((await reply({ op: "events", cursor: 1, waitMs: 10 })).result).toEqual({ events: [], gap: false });
  });

  it("releases its outbox sink on close", () => {
    runtime.close();
    expect(sinks).toHaveLength(0);
  });
});

describe("app chat budget", () => {
  it("rate limits Chat separately from integrations", async () => {
    await installApp("board");
    const host = new Hono();
    host.route("/", createAppCapabilityRoutes({
      homePath: home, ownerIds: ["owner"], resolveOwner: () => "owner", integrations: null, aiAllowed: async () => false,
      chats: { runtime: () => runtime, resolvePrincipal: () => principal },
    }));
    const send = (input: unknown) => host.request("/", { method: "POST", body: JSON.stringify({ app: "board", input }) });
    for (let index = 0; index < 130; index += 1) expect(await (await send({ kind: "chats", request: { op: "access" } })).json()).toMatchObject({ ok: true });
    expect((await send({ kind: "capabilities" })).status).toBe(200);
  });
});
