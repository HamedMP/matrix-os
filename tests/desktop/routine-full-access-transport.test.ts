import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { RoutineFullAccessStatus } from "@matrix-os/contracts";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api.js";
import { createCanonicalChatClient } from "../../desktop/src/renderer/src/lib/canonical-chat-client.js";
import { AppError } from "../../desktop/src/shared/app-error.js";
import { createRoutineFullAccessRoutes } from "../../packages/gateway/src/bots/routine-full-access-routes.js";
import { buildForwardedQueryString } from "../../packages/platform/src/request-routing.js";
import { readExplicitVmRoute } from "../../packages/platform/src/session-routing-identity.js";

const principal = { userId: "owner_transport", source: "jwt" as const };
const scopePath = "/api/chats/chat_transport/routine-cli/full-access";
const status: RoutineFullAccessStatus = {
  revision: 0, eligibility: "eligible", origin: "browser_required", consent: null, challenge: null,
};
type ScopeService = NonNullable<Parameters<typeof createRoutineFullAccessRoutes>[0]["service"]>;

function transport(baseUrl: string, runtimeSlot: string) {
  // Only the owner-auth principal and non-authorizing status projection are fixtures.
  // The native clients, Platform path/query producers and strict Gateway routes stay real.
  const service = {
    status: vi.fn(async () => status), createChallenge: vi.fn(async () => status),
    submitDecision: vi.fn(async () => status), revoke: vi.fn(async () => status),
  } satisfies ScopeService;
  const app = new Hono().route("/", createRoutineFullAccessRoutes({ service, getPrincipal: () => principal }));
  const requests: { input: URL; upstream: string; headers: Headers; status: number }[] = [];
  const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const upstream = (readExplicitVmRoute(url.pathname)?.upstreamPath ?? url.pathname) + buildForwardedQueryString(input);
    const response = await app.request(`https://gateway.fixture.test${upstream}`, init);
    requests.push({ input: url, upstream, headers: new Headers(init?.headers), status: response.status });
    return response;
  });
  const api = createApiClient({ baseUrl, getRuntimeSlot: () => runtimeSlot, fetchFn });
  return { app, service, requests, api, client: createCanonicalChatClient(api).routineFullAccess! };
}

it.each([
  ["primary", "https://platform.fixture.test"],
  ["dev", "https://platform.fixture.test"],
  ["primary", "https://platform.fixture.test/vm/owner-pc"],
  ["dev", "https://platform.fixture.test/vm/owner-pc"],
])("reads native Routine CLI status through the strict owner route (runtime=%s, base=%s)", async (runtimeSlot, baseUrl) => {
  const { client, requests, service } = transport(baseUrl, runtimeSlot);
  const result = await client.read("chat_transport").then(value => ({ ok: true, value }), (error: unknown) => {
    if (!(error instanceof AppError)) throw error;
    return { ok: false, httpStatus: error.httpStatus };
  });
  expect({ result, upstream: requests[0]?.upstream, responseStatus: requests[0]?.status }).toEqual({
    result: { ok: true, value: status }, upstream: scopePath, responseStatus: 200,
  });
  expect(requests[0]!.input.pathname).toBe(new URL(baseUrl).pathname.replace(/\/$/, "") + scopePath);
  expect(requests[0]!.input.search).toBe(runtimeSlot === "primary" ? "" : "?runtime=dev");
  expect(requests[0]!.headers.has("X-Matrix-Chat-Metadata")).toBe(false);
  expect(service.status).toHaveBeenCalledExactlyOnceWith(principal, "chat_transport");
  expect(service.submitDecision).not.toHaveBeenCalled();
});

it("keeps scope challenge/revoke query-free without manufacturing a native decision proof", async () => {
  const { client, requests, service } = transport("https://platform.fixture.test/vm/owner-pc", "dev");
  await expect(client.challenge("chat_transport", 0)).resolves.toEqual(status);
  await expect(client.revoke("chat_transport", 0)).resolves.toEqual(status);
  expect(service.createChallenge).toHaveBeenCalledExactlyOnceWith(principal, "chat_transport", { baseRevision: 0 });
  expect(service.revoke).toHaveBeenCalledExactlyOnceWith(principal, "chat_transport", { baseRevision: 0 });
  const challengeId = `rcfull_${"a".repeat(32)}`;
  await expect(client.decide("chat_transport", challengeId, {
    scopeDigest: "b".repeat(64), decision: "approve", clientRequestId: "de000000-0000-4000-8000-000000000001",
  })).rejects.toMatchObject({ httpStatus: 403 });
  expect(requests.map(request => request.upstream)).toEqual([
    `${scopePath}/challenges`, `${scopePath}/revoke`, `${scopePath}/challenges/${challengeId}/decision`,
  ]);
  expect(requests.every(request => !request.headers.has("X-Matrix-Chat-Metadata"))).toBe(true);
  expect(service.submitDecision).not.toHaveBeenCalled();
});

it("preserves unknown caller queries so the strict owner route still rejects them", async () => {
  const { app, api, requests, service } = transport("https://platform.fixture.test/vm/owner-pc", "dev");
  for (const query of ["ownerId=foreign", "fundingVersion=1"]) {
    expect((await app.request(`${scopePath}?${query}`)).status).toBe(400);
    await expect(api.get(`${scopePath}?${query}`)).rejects.toMatchObject({ httpStatus: 400 });
    expect(requests.at(-1)?.upstream).toBe(`${scopePath}?${query}`);
  }
  expect(service.status).not.toHaveBeenCalled();
});

it("retains existing Chat funding and metadata negotiation through the native canonical client", async () => {
  const requests: { url: URL; headers: Headers }[] = [];
  const api = createApiClient({ baseUrl: "https://platform.fixture.test/vm/owner-pc", getRuntimeSlot: () => "dev",
    fetchFn: async (input, init) => {
      requests.push({ url: new URL(input), headers: new Headers(init?.headers) });
      return Response.json({ items: [] });
    } });
  await expect(createCanonicalChatClient(api).list()).resolves.toEqual({ items: [] });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url.pathname).toBe("/vm/owner-pc/api/chats");
  expect(requests[0]!.url.searchParams.get("fundingVersion")).toBe("1");
  expect(requests[0]!.url.searchParams.get("readStateVersion")).toBe("1");
  expect(requests[0]!.url.searchParams.get("importSourceVersion")).toBe("1");
  expect(requests[0]!.url.searchParams.get("runtime")).toBe("dev");
  expect(requests[0]!.headers.get("X-Matrix-Chat-Metadata")).toBe("1");
});

it.each([
  ["/api/chats/chat_transport/routine-cli/full-access-extra", true],
  ["/api/chats/chat_transport/routine-cli/full-accessible", true],
  ["/api/chats/chat_transport/routine-cli/Full-Access", true],
  ["/api/chats/chat_transport/turns", true],
  ["/api/chats-archive", false],
  ["/api/chat-agents", false],
] as const)("preserves existing response negotiation outside the exact scope namespace: %s", async (path, chatResponse) => {
  const fetchFn = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({}));
  const api = createApiClient({ baseUrl: "https://platform.fixture.test", getRuntimeSlot: () => "primary", fetchFn });
  await api.get(path);
  const [url, init] = fetchFn.mock.calls[0]!;
  expect(new URL(url).searchParams.get("fundingVersion")).toBe(chatResponse ? "1" : null);
  expect(new Headers(init?.headers).get("X-Matrix-Chat-Metadata")).toBe(chatResponse ? "1" : null);
});

it("keeps a scope read bound to an explicitly pinned runtime through the real URL producers", async () => {
  const { api, requests, service } = transport("https://platform.fixture.test/vm/owner-pc", "dev");
  await expect(api.forRuntime("primary").get(scopePath)).resolves.toEqual(status);
  expect(requests[0]!.input.search).toBe("");
  expect(requests[0]!.upstream).toBe(scopePath);
  expect(service.status).toHaveBeenCalledExactlyOnceWith(principal, "chat_transport");
});
