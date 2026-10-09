import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { BrainIntegrationCallRequest } from "../../packages/gateway/src/brain/contracts.js";
import {
  BRAIN_INTEGRATION_REMOTE_REPLY_MAX_BYTES, createBrainIntegrationCaller, readBoundedJson, type BrainIntegrationCallerDeps,
  type BrainIntegrationRegistry,
} from "../../packages/gateway/src/brain/sources/integration/index.js";
import type { ServiceAction, ServiceDefinition } from "../../packages/gateway/src/integrations/types.js";
import { fakeFetch, jsonResponse } from "./helpers/brain-integration-fetch.js";

const BASE = "https://platform.test/internal/containers/alice/integrations";
const MACHINE = "machine-token";
const request: BrainIntegrationCallRequest = { service: "github", action: "list_issues", params: { repo: "acme/widgets", state: "all" } };
const signal = () => new AbortController().signal;

function remote(responses: Parameters<typeof fakeFetch>[0], extra: Partial<BrainIntegrationCallerDeps> = {}) {
  const fake = fakeFetch(responses);
  return { fake, caller: createBrainIntegrationCaller({ internalBaseUrl: `${BASE}/`, machineToken: MACHINE, fetch: fake.fetch, ...extra }) };
}

const envelope = (data: unknown, action = "list_issues") => jsonResponse({ data, service: "github", action });
const connections = (...labels: [string, string][]) => jsonResponse(labels.map(([service, account_label]) => ({ id: "c", service, account_label })));

describe("integration caller, remote transport", () => {
  it("posts a read call with the machine bearer, signed owner delegation and the read scope header", async () => {
    const { fake, caller } = remote([envelope([{ number: 1 }])]);
    expect(await caller.call("owner_a", { ...request, label: "work" }, signal())).toEqual({ status: "ok", data: [{ number: 1 }] });
    const call = fake.calls[0]!;
    expect(call.url).toBe(`${BASE}/read-call`);
    expect(call.init).toMatchObject({ method: "POST", redirect: "error" });
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${MACHINE}`);
    expect(headers.get("x-platform-user-id")).toBe("owner_a");
    expect(headers.get("x-platform-verified")).toBe(createHmac("sha256", MACHINE).update("owner_a").digest("hex"));
    expect(headers.get("x-matrix-integration-read-scope")).toBe("read");
    expect(JSON.parse(String(call.init.body))).toEqual({ service: "github", action: "list_issues", label: "work", params: request.params });
  });

  it("finds the account label when none is given, caches it with a lifetime and a cap", async () => {
    let clock = 0;
    const { fake, caller } = remote([
      connections(["linear", "l"], ["github", "work"]), envelope(1), envelope(2),
      connections(["github", "home"]), envelope(3), connections(["github", "work"], ["github", "home"]),
    ], { now: () => clock });
    expect(await caller.call("owner_a", request, signal())).toEqual({ status: "ok", data: 1 });
    expect(await caller.call("owner_a", request, signal())).toEqual({ status: "ok", data: 2 });
    clock += 5 * 60_000 + 1;
    expect(await caller.call("owner_a", request, signal())).toEqual({ status: "ok", data: 3 });
    expect(fake.calls.map((call) => call.init.method ?? "GET")).toEqual(["GET", "POST", "POST", "GET", "POST"]);
    expect(JSON.parse(String(fake.calls[4]!.init.body)).label).toBe("home");
    // Several accounts and no pinned label: refused, never the first one.
    expect(await caller.call("owner_b", request, signal())).toEqual({ status: "invalid" });

    const many = remote(Array.from({ length: 257 }, () => [connections(["github", "x"]), envelope(0)]).flat());
    for (let i = 0; i < 257; i += 1) await many.caller.call(`owner_${i}`, request, signal());
    expect(many.fake.calls).toHaveLength(514);
  });

  it("answers not_connected or unavailable when the label cannot be found", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await remote([connections(["linear", "l"])]).caller.call("o", request, signal())).toEqual({ status: "not_connected" });
    expect(await remote([connections(["github", " bad"])]).caller.call("o", request, signal())).toEqual({ status: "not_connected" });
    // The platform refusing this gateway's machine credentials is not the owner's account: never "reconnect".
    expect(await remote([jsonResponse({ error: "Unauthorized" }, 401)]).caller.call("o", request, signal())).toEqual({ status: "unavailable" });
    expect(warn).toHaveBeenCalledWith("[brain-integration] remote auth rejected");
    expect(await remote([jsonResponse({ nope: true })]).caller.call("o", request, signal())).toEqual({ status: "unavailable" });
    expect(await remote([new Response("not json")]).caller.call("o", request, signal())).toEqual({ status: "unavailable" });
    warn.mockRestore();
  });

  it.each([
    [jsonResponse({ error: "Integration account unavailable" }, 400), { status: "not_connected" }],
    [jsonResponse({ error: "Invalid action parameters" }, 400), { status: "invalid" }],
    [new Response("not json", { status: 400 }), { status: "invalid" }],
    [jsonResponse({}, 429, { "retry-after": "30" }), { status: "rate_limited", retryAfterSeconds: 30 }],
    [jsonResponse({}, 429, { "retry-after": "99999" }), { status: "rate_limited", retryAfterSeconds: 3600 }],
    [jsonResponse({}, 429), { status: "rate_limited", retryAfterSeconds: 60 }],
    [jsonResponse({ error: "Unauthorized" }, 401), { status: "unavailable" }],
    [jsonResponse({}, 403), { status: "invalid" }],
    [jsonResponse({}, 409), { status: "invalid" }],
    [jsonResponse({}, 501), { status: "invalid" }],
    [jsonResponse({ error: "Integration call failed" }, 502), { status: "unavailable" }],
    [jsonResponse({ error: "Integration call failed", upstream: "unauthorized" }, 502), { status: "unauthorized" }],
    [jsonResponse({ error: "Integration call failed", upstream: "not_found" }, 502), { status: "not_found" }],
    [jsonResponse({ error: "Integration call failed", upstream: "teapot" }, 502), { status: "unavailable" }],
    [jsonResponse("upstream", 502), { status: "unavailable" }],
    [new Response("bad gateway", { status: 502 }), { status: "unavailable" }],
    [jsonResponse({}, 503), { status: "unavailable" }],
    [envelope([], "other_action"), { status: "unavailable" }],
    [new Response("[]", { status: 200, headers: { "content-length": String(BRAIN_INTEGRATION_REMOTE_REPLY_MAX_BYTES + 1) } }),
      { status: "unavailable" }],
  ])("maps read-call answer %# to an outcome", async (response, outcome) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await remote([response]).caller.call("o", { ...request, label: "work" }, signal())).toEqual(outcome);
    warn.mockRestore();
  });

  it("answers unavailable on network failures and timeouts, and rejects only when the caller aborts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await remote([new TypeError("fetch failed")]).caller.call("o", { ...request, label: "w" }, signal())).toEqual({ status: "unavailable" });
    expect(await remote([() => Promise.reject("plain")]).caller.call("o", { ...request, label: "w" }, signal())).toEqual({ status: "unavailable" });
    const hanging = remote([() => new Promise<Response>(() => undefined)], { timeoutMs: 5 });
    expect(await hanging.caller.call("o", { ...request, label: "w" }, signal())).toEqual({ status: "unavailable" });
    const controller = new AbortController();
    const pending = remote([() => new Promise<Response>(() => undefined)]).caller.call("o", { ...request, label: "w" }, controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    await expect(remote([]).caller.call("o", request, controller.signal)).rejects.toThrow("stop");
    expect(warn).toHaveBeenCalledWith("[brain-integration] remote github/list_issues failed:", "TypeError");
    warn.mockRestore();
  });
});

describe("integration caller, request checks", () => {
  const action = (risk: ServiceAction["risk"]): ServiceAction => ({ description: "x", risk, params: { q: { type: "string", required: true } } });
  const service = (connectorKind: ServiceDefinition["connectorKind"]): ServiceDefinition => ({
    id: "github", name: "GitHub", category: "dev", connectorKind, icon: "", logoUrl: "",
    actions: { read: action("read"), write: action("write") },
  });
  const registry = (kind: ServiceDefinition["connectorKind"]): BrainIntegrationRegistry => ({
    getService: (id) => id === "github" ? service(kind) : undefined,
    getAction: (id, name) => id === "github" ? service(kind).actions[name] : undefined,
  });

  it("refuses bad services, params, owners and labels, and answers unavailable for a read the registry lacks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const caller = createBrainIntegrationCaller({ internalBaseUrl: BASE, machineToken: MACHINE, registry: registry("pipedream") });
    const preset = createBrainIntegrationCaller({ internalBaseUrl: BASE, machineToken: MACHINE, registry: registry("mcp_preset") });
    const ok = { service: "github", action: "read", params: { q: "x" } } as const;
    for (const [owner, bad] of [
      ["o", { ...ok, service: "slack" }], ["o", { ...ok, params: {} }], ["o", { ...ok, label: " x" }], ["bad owner", ok],
      ["o", { ...ok, label: "a\u0000b" }], ["o", { ...ok, label: "a\u0001b" }], ["o", { ...ok, label: "a\nb" }],
    ] as const) {
      expect(await caller.call(owner, bad as BrainIntegrationCallRequest, signal())).toEqual({ status: "invalid" });
    }
    // A missing registry action is a gap in this server, not the owner's config.
    for (const gap of [{ ...ok, service: "linear" }, { ...ok, action: "missing" }, { ...ok, action: "write" }] as const) {
      expect(await caller.call("o", gap as BrainIntegrationCallRequest, signal())).toEqual({ status: "unavailable" });
    }
    expect(await preset.call("o", ok, signal())).toEqual({ status: "unavailable" });
    expect(warn).toHaveBeenCalledWith("[brain-integration] github/missing is not a registered read action");
    warn.mockRestore();
  });

  it("answers unavailable without a transport, and prefers the remote transport when both are set", async () => {
    expect(await createBrainIntegrationCaller({}).call("o", request, signal())).toEqual({ status: "unavailable" });
    expect(await createBrainIntegrationCaller({ internalBaseUrl: BASE }).call("o", request, signal())).toEqual({ status: "unavailable" });
    const db = { getUserByClerkId: vi.fn(), getUserById: vi.fn(), listConnectedServices: vi.fn() };
    const { fake, caller } = remote([envelope(7)], { db: db as never, pipedream: {} as never });
    expect(await caller.call("o", { ...request, label: "w" }, signal())).toEqual({ status: "ok", data: 7 });
    expect(fake.calls).toHaveLength(1);
    expect(db.getUserByClerkId).not.toHaveBeenCalled();
  });
});

describe("integration caller, local transport", () => {
  const USER_ID = "0b6c5d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";
  const connection = (label: string) => ({ service: "github", account_label: label, pipedream_account_id: `apn_${label}` });
  /** Like the platform database: users and connections are keyed by UUID, and a non-UUID id is a Postgres 22P02. */
  type Read = (request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  function local(options: { connections?: unknown[]; externalId?: string | null; proxyGet?: Read; bounded?: boolean } = {}) {
    // The raw, byte-capped read every brain call takes (pipedream.boundedProxy).
    const proxyGet = vi.fn<Read>(options.proxyGet ?? (async () => [{ number: 1 }]));
    const user = { id: USER_ID, clerk_id: "user_2abc", pipedream_external_id: options.externalId === undefined ? "ext_1" : options.externalId };
    const uuidOnly = (id: string) => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    };
    const db = {
      getUserByClerkId: vi.fn(async (clerkId: string) => (clerkId === user.clerk_id ? user : null)),
      getUserById: vi.fn(async (id: string) => { uuidOnly(id); return id === USER_ID ? user : null; }),
      listConnectedServices: vi.fn(async (id: string) => { uuidOnly(id); return id === USER_ID ? options.connections ?? [connection("work")] : []; }),
    };
    const sdkProxyGet = vi.fn(async () => [{ number: 1 }]);
    const pipedream = options.bounded === false ? { proxyGet: sdkProxyGet } : { boundedProxy: proxyGet, proxyGet: sdkProxyGet };
    const caller = createBrainIntegrationCaller({ db: db as never, pipedream: pipedream as never, timeoutMs: 50 });
    return { caller, proxyGet, sdkProxyGet, db };
  }
  const statusError = (status: number, headers?: Record<string, string>) => Object.assign(new Error("provider"), { status, headers });

  it("runs the registry action for the platform user behind the owner's Clerk id", async () => {
    const { caller, proxyGet, db } = local({ connections: [connection("home"), connection("work")] });
    expect(await caller.call("user_2abc", { ...request, label: "work" }, signal())).toEqual({ status: "ok", data: [{ number: 1 }] });
    expect(db.listConnectedServices).toHaveBeenCalledWith(USER_ID);
    expect(db.getUserById).not.toHaveBeenCalled();
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      externalUserId: "ext_1", accountId: "apn_work", method: "GET", url: "https://api.github.com/repos/acme/widgets/issues",
      maxBytes: 4 * 1024 * 1024,
    }), expect.any(AbortSignal));
  });

  it("cancels the raw read when the call times out and never falls back to an unbounded SDK read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let seen: AbortSignal | null = null;
    const hung = local({ proxyGet: (_request, signal) => { seen = signal; return new Promise(() => undefined); } });
    expect(await hung.caller.call("user_2abc", request, signal())).toEqual({ status: "unavailable" });
    expect(seen!.aborted).toBe(true);
    const unbounded = local({ bounded: false });
    expect(await unbounded.caller.call("user_2abc", request, signal())).toEqual({ status: "unavailable" });
    expect(unbounded.sdkProxyGet).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[brain-integration] local github/list_issues failed:", "BoundedPipedreamReadError");
    warn.mockRestore();
  });

  it("accepts a platform user id, and answers not_connected for an owner with no platform user", async () => {
    const byId = local();
    expect(await byId.caller.call(USER_ID, request, signal())).toEqual({ status: "ok", data: [{ number: 1 }] });
    expect(byId.db.getUserById).toHaveBeenCalledWith(USER_ID);
    const unknown = local();
    expect(await unknown.caller.call("default", request, signal())).toEqual({ status: "not_connected" });
    expect(await unknown.caller.call("1b6c5d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e", request, signal())).toEqual({ status: "not_connected" });
    expect(unknown.db.getUserById).toHaveBeenCalledTimes(1);
    expect(unknown.db.listConnectedServices).not.toHaveBeenCalled();
    expect(unknown.proxyGet).not.toHaveBeenCalled();
  });

  it("maps missing, ambiguous and unusable connections", async () => {
    expect(await local({ connections: [] }).caller.call("user_2abc", request, signal())).toEqual({ status: "not_connected" });
    expect(await local({ connections: [connection("w"), connection("w")] }).caller.call("user_2abc", { ...request, label: "w" }, signal()))
      .toEqual({ status: "invalid" });
    expect(await local({ externalId: null }).caller.call("user_2abc", request, signal())).toEqual({ status: "unavailable" });
    expect(await local({ proxyGet: async () => undefined }).caller.call("user_2abc", request, signal())).toEqual({ status: "ok", data: undefined });
  });

  it("refuses an unlabeled read when the owner has several accounts of the service, never the first one", async () => {
    const several = local({ connections: [connection("home"), connection("work")] });
    expect(await several.caller.call("user_2abc", request, signal())).toEqual({ status: "invalid" });
    expect(several.proxyGet).not.toHaveBeenCalled();
    // Accounts of other services do not count, and a pinned label still picks its account.
    const linear = { service: "linear", account_label: "l", pipedream_account_id: "apn_l" };
    const only = local({ connections: [linear, connection("work")] });
    expect(await only.caller.call("user_2abc", request, signal())).toEqual({ status: "ok", data: [{ number: 1 }] });
    expect(only.proxyGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "apn_work" }), expect.any(AbortSignal));
    expect(await several.caller.call("user_2abc", { ...request, label: "home" }, signal())).toEqual({ status: "ok", data: [{ number: 1 }] });
    expect(several.proxyGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "apn_home" }), expect.any(AbortSignal));
  });

  it.each([
    [statusError(429, { "retry-after": "12" }), { status: "rate_limited", retryAfterSeconds: 12 }],
    [statusError(401), { status: "unauthorized" }], [statusError(403), { status: "unauthorized" }],
    [statusError(403, { "x-ratelimit-remaining": "9" }), { status: "unauthorized" }],
    [statusError(403, { "retry-after": "30" }), { status: "rate_limited", retryAfterSeconds: 30 }],
    [statusError(403, { "x-ratelimit-remaining": "0" }), { status: "rate_limited", retryAfterSeconds: 60 }],
    // A secondary rate limit: a 403 whose only sign is its message, in the error text or its body.
    [Object.assign(new Error("You have exceeded a secondary rate limit."), { status: 403 }), { status: "rate_limited", retryAfterSeconds: 60 }],
    [Object.assign(new Error("StatusCode: 403"), { statusCode: 403, body: { message: "You have exceeded a secondary rate limit." } }),
      { status: "rate_limited", retryAfterSeconds: 60 }],
    [Object.assign(new Error("StatusCode: 403"), { statusCode: 403, body: "secondary rate limit" }), { status: "rate_limited", retryAfterSeconds: 60 }],
    [Object.assign(new Error("StatusCode: 403"), { statusCode: 403, body: { message: "Bad credentials" } }), { status: "unauthorized" }],
    [Object.assign(new Error("StatusCode: 403"), { statusCode: 403, body: null }), { status: "unauthorized" }],
    [Object.assign(new Error("provider"), { statusCode: 403, rawResponse: { headers: new Headers({ "x-ratelimit-remaining": "0" }) } }),
      { status: "rate_limited", retryAfterSeconds: 60 }],
    [statusError(404), { status: "not_found" }], [statusError(410), { status: "not_found" }],
    [statusError(422), { status: "invalid" }], [statusError(400), { status: "invalid" }],
    [statusError(500), { status: "unavailable" }],
  ])("maps provider failure %# to an outcome", async (error, outcome) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await local({ proxyGet: async () => { throw error; } }).caller.call("user_2abc", request, signal())).toEqual(outcome);
    warn.mockRestore();
  });

  it("answers unavailable when the provider outlives the call timeout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await local({ proxyGet: () => new Promise(() => undefined) }).caller.call("user_2abc", request, signal())).toEqual({ status: "unavailable" });
    warn.mockRestore();
  });
});

function chunked(chunks: string[], cancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
      else controller.close();
    },
    cancel,
  });
}

describe("bounded JSON body reader", () => {
  it("reads JSON within the cap", async () => {
    expect(await readBoundedJson(new Response(chunked(['{"a":', "1}"])), 100, signal())).toEqual({ ok: true, value: { a: 1 } });
  });

  it("refuses bad lengths, oversized bodies, invalid UTF-8 and missing bodies", async () => {
    const lengthy = (value: string) => new Response("{}", { headers: { "content-length": value } });
    expect(await readBoundedJson(lengthy("abc"), 100, signal())).toEqual({ ok: false, reason: "too_large" });
    expect(await readBoundedJson(lengthy("101"), 100, signal())).toEqual({ ok: false, reason: "too_large" });
    expect(await readBoundedJson(new Response(chunked(["x".repeat(60), "y".repeat(60)])), 100, signal())).toEqual({ ok: false, reason: "too_large" });
    expect(await readBoundedJson(new Response(new Uint8Array([0xff, 0xfe])), 100, signal())).toEqual({ ok: false, reason: "invalid" });
    expect(await readBoundedJson(new Response(null), 100, signal())).toEqual({ ok: false, reason: "invalid" });
  });

  it("cancels the body and rethrows when the signal aborts mid-read", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(readBoundedJson(new Response(chunked(["{}"])), 100, controller.signal)).rejects.toThrow("stop");
  });

  it("logs a failed cancel by name and rethrows unexpected parse errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const thrown of [new RangeError("cancel"), "plain"]) {
      const failing = new Response(chunked(["x".repeat(200)], () => { throw thrown; }));
      expect(await readBoundedJson(failing, 100, signal())).toEqual({ ok: false, reason: "too_large" });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith("[brain-sources] response body cancel failed:", "RangeError");
    expect(warn).toHaveBeenCalledWith("[brain-sources] response body cancel failed:", "UnknownError");
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => { throw new RangeError("odd"); });
    try {
      await expect(readBoundedJson(new Response("{}"), 100, signal())).rejects.toThrow(RangeError);
    } finally {
      parse.mockRestore();
      warn.mockRestore();
    }
  });
});
