import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { BrainIntegrationCallRequest } from "../../packages/gateway/src/brain/contracts.js";
import {
  createBrainIntegrationCaller, readBoundedJson, type BrainIntegrationCallerDeps, type BrainIntegrationRegistry,
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
    [new Response("[]", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } }), { status: "unavailable" }],
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
