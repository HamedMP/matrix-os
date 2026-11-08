import { afterEach, expect, it, vi } from "vitest";
import { createRoutineFullAccessRoutes } from "../../packages/gateway/src/bots/routine-full-access-routes.js";
import { createRoutineFullAccessPlatformClient } from "../../packages/gateway/src/bots/routine-full-access-platform-client.js";
import type { RoutineFullAccessProof, RoutineFullAccessTuple } from "@matrix-os/contracts";
const principal = { userId: "owner_one", source: "jwt" as const }, path = "/api/chats/chat_one/routine-cli/full-access";
const id = `rcfull_${"a".repeat(32)}`, digest = "b".repeat(64), requestId = "de000000-0000-4000-8000-000000000001";
const status = { revision: 0, eligibility: "eligible" as const, origin: "browser_required" as const, consent: null, challenge: null };
function routes() {
  const service = { status: vi.fn(async () => status), createChallenge: vi.fn(async () => status),
    submitDecision: vi.fn(async () => status), revoke: vi.fn(async () => status) };
  return { service, app: createRoutineFullAccessRoutes({ service, getPrincipal: () => principal }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("resolves the real HTTP dependencies at registration and exposes explicit safe unavailable startup", async () => {
  expect(() => createRoutineFullAccessRoutes({ service: {} as never, getPrincipal: () => principal })).toThrow("dependencies unavailable");
  const app = createRoutineFullAccessRoutes({ service: null, getPrincipal: () => principal });
  const response = await app.request(path);
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: "unavailable", message: "Routine requests are temporarily unavailable." });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("passes only the authenticated principal, fixed Chat and strict bodies through all production routes", async () => {
  const { app, service } = routes(), body = { scopeDigest: digest, decision: "approve", clientRequestId: requestId };
  expect((await app.request(path)).status).toBe(200);
  expect(service.status).toHaveBeenCalledExactlyOnceWith(principal, "chat_one");
  for (const action of ["challenges", "revoke"]) {
    expect((await app.request(`${path}/${action}`, { method: "POST", body: JSON.stringify({ baseRevision: 0 }) })).status).toBe(200);
  }
  expect(service.createChallenge).toHaveBeenCalledExactlyOnceWith(principal, "chat_one", { baseRevision: 0 });
  expect(service.revoke).toHaveBeenCalledExactlyOnceWith(principal, "chat_one", { baseRevision: 0 });
  expect((await app.request(`${path}/challenges/${id}/decision`, { method: "POST", body: JSON.stringify(body) })).status).toBe(403);
  expect(service.submitDecision).not.toHaveBeenCalled();
  expect((await app.request(`${path}/challenges/${id}/decision`, { method: "POST", headers: { "x-matrix-routine-full-access-proof": "fixture-proof" }, body: JSON.stringify(body) })).status).toBe(200);
  expect(service.submitDecision).toHaveBeenCalledExactlyOnceWith(principal, "chat_one", id, body, "fixture-proof");
});
it("rejects forged identities, invalid IDs, stale-shape bodies, query selectors and excessive bytes before dispatch", async () => {
  const { app, service } = routes();
  for (const action of ["challenges", "revoke"]) {
    expect((await app.request(`${path}/${action}`, { method: "POST", body: JSON.stringify({ baseRevision: 0, ownerId: "owner_forged" }) })).status).toBe(400);
    expect((await app.request(`${path}/${action}`, { method: "POST", body: "x".repeat(4001) })).status).toBe(413);
  }
  expect((await app.request(`${path}?ownerId=owner_forged`)).status).toBe(400);
  expect((await app.request(`${path}/challenges/rcfull_invalid/decision`, { method: "POST", body: "{}" })).status).toBe(400);
  expect(service.createChallenge).not.toHaveBeenCalled(); expect(service.revoke).not.toHaveBeenCalled();
  service.status.mockRejectedValueOnce(new Error("/private/path postgres provider secret"));
  const response = await app.request(path); expect(response.status).toBe(503);
  expect(await response.text()).not.toMatch(/private|postgres|provider|secret/);
});

const tuple: RoutineFullAccessTuple = { kind: "turn", handle: "computer-one", machineId: "machine_one", runtimeSlot: "primary", ownerId: "owner_one",
  chatId: "chat_one", scopeId: id, clientRequestId: "req_turn", requestDigest: digest };
function verified(): RoutineFullAccessProof { return { ...tuple, purpose: "routine_cli_full_access_origin", version: 1,
  expiresAt: Date.now() + 60_000, nonce: "c".repeat(32), bodyDigest: digest }; }
function client(fetcher: typeof fetch) { return createRoutineFullAccessPlatformClient({ platformUrl: "https://platform.example.test", handle: "computer-one", token: "transport-only-fixture", fetcher }); }
it("uses the distinct fixed Platform verifier, transport bearer, exact tuple, proof header and bounded signal", async () => {
  const proof = verified(), fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe("https://platform.example.test/internal/containers/computer-one/routine-full-access/verify");
    expect(JSON.parse(String(init?.body))).toEqual(tuple); expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer transport-only-fixture");
    expect(new Headers(init?.headers).get("x-matrix-routine-full-access-proof")).toBe("browser-proof");
    return Response.json({ verified: proof });
  });
  expect(await client(fetcher).verify(tuple, "browser-proof")).toEqual(proof);
});
it.each(["wrong purpose", "wrong target", "expired", "extra key", "oversize"])("fails closed on %s Platform verification response", async fault => {
  const proof = verified(); let body: unknown = { verified: proof };
  if (fault === "wrong purpose") body = { verified: { ...proof, purpose: "routine_cli_owner_action" } };
  if (fault === "wrong target") body = { verified: { ...proof, chatId: "chat_other" } };
  if (fault === "expired") body = { verified: { ...proof, expiresAt: Date.now() - 1 } };
  if (fault === "extra key") body = { verified: proof, authority: true };
  if (fault === "oversize") body = { private: "x".repeat(4097) };
  await expect(client(async () => Response.json(body)).verify(tuple, "browser-proof")).rejects.toThrow();
});
it("cancels a hanging verification response at the existing ten-second network budget", async () => {
  vi.useFakeTimers(); const cancel = vi.fn();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    expect(ms).toBe(10_000); const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Fixture network deadline", "TimeoutError")), ms);
    return controller.signal;
  });
  const response = new Response(new ReadableStream({ cancel }));
  const pending = client(async () => response).verify(tuple, "browser-proof");
  const rejected = expect(pending).rejects.toThrow();
  // Only Node's timer factory is controlled; the production reader/abort cleanup stays real.
  await vi.advanceTimersByTimeAsync(10_000); await rejected; expect(cancel).toHaveBeenCalledOnce();
});
