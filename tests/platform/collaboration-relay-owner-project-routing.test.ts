/**
 * A private project is kept out of the platform directory until it becomes active, so the relay
 * cannot find its home by scope id while the owner is still preparing it. The owner's setup
 * requests carry the owner-runtime marker and the logical runtime id; only those four requests,
 * and only for the runtime's own owner, are routed by runtime id instead. Everything else about
 * scope routing is unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { CollaborationRelay, type RelayHome } from "../../packages/platform/src/collaboration/relay.js";
import { createOwnerRuntimeHomeResolver } from "../../packages/platform/src/collaboration/direct-wiring.js";

const HOME: RelayHome = { runtimeId: "vps-11111111-1111-4111-8111-111111111111", origin: "https://203.0.113.10:443" };
const DIRECTORY_HOME: RelayHome = { runtimeId: "vps-22222222-2222-4222-8222-222222222222", origin: "https://203.0.113.20:443" };
const OWNER = "user_owner";
const SCOPE = "10000000-0000-4000-8000-00000000d001";
const BASE = `/api/collaboration/scopes/${SCOPE}`;
const OWNER_HEADERS = {
  "x-matrix-collaboration-session": "30000000-0000-4000-8000-00000000d001",
  "x-matrix-collaboration-owner-runtime": "1",
  "x-matrix-collaboration-runtime": HOME.runtimeId,
};

function harness(options: { directory?: RelayHome | null } = {}) {
  const forwarded: string[] = [];
  const resolveOwnerRuntimeHome = vi.fn(async (actorId: string, runtimeId: string) =>
    (actorId === OWNER && runtimeId === HOME.runtimeId ? HOME : null));
  const relay = new CollaborationRelay({
    resolveScopeHome: async () => options.directory ?? null,
    resolveInvitationHome: async () => null,
    resolveRuntimeHome: async () => null,
    resolveSessionHome: async () => null,
    resolveOwnerRuntimeHome,
    fetchImpl: (async (input: string) => {
      forwarded.push(input);
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  const send = (method: string, path: string, headers: Record<string, string> = OWNER_HEADERS, actorId = OWNER) =>
    relay.forward({ actorId, method, path, query: "", headers: new Headers(headers), body: method === "GET" ? null : new Uint8Array() });
  return { relay, forwarded, resolveOwnerRuntimeHome, send };
}

describe("relay routing for a private project's owner setup", () => {
  it("routes the four owner setup requests by runtime when the scope has no directory route", async () => {
    const { relay, forwarded, send } = harness();
    try {
      for (const [method, path] of [
        ["GET", BASE], ["GET", `${BASE}/members`], ["GET", `${BASE}/project/inventory`], ["POST", `${BASE}/project/confirm`],
      ] as const) {
        expect((await send(method, path)).status).toBe(200);
      }
      expect(forwarded).toEqual([
        `${HOME.origin}${BASE}`, `${HOME.origin}${BASE}/members`,
        `${HOME.origin}${BASE}/project/inventory`, `${HOME.origin}${BASE}/project/confirm`,
      ]);
    } finally {
      relay.close();
    }
  });

  it("keeps using the directory when the scope has a route, without consulting the owner runtime", async () => {
    const { relay, forwarded, resolveOwnerRuntimeHome, send } = harness({ directory: DIRECTORY_HOME });
    try {
      expect((await send("GET", BASE)).status).toBe(200);
      expect(forwarded).toEqual([`${DIRECTORY_HOME.origin}${BASE}`]);
      expect(resolveOwnerRuntimeHome).not.toHaveBeenCalled();
    } finally {
      relay.close();
    }
  });

  it("stays unroutable without the owner-runtime marker", async () => {
    const { relay, forwarded, send } = harness();
    try {
      const { "x-matrix-collaboration-owner-runtime": _marker, ...unmarked } = OWNER_HEADERS;
      expect((await send("GET", BASE, unmarked)).status).toBe(404);
      expect((await send("GET", BASE, { ...OWNER_HEADERS, "x-matrix-collaboration-owner-runtime": "true" })).status).toBe(404);
      expect(forwarded).toEqual([]);
    } finally {
      relay.close();
    }
  });

  it("never routes any other scope request by runtime, even with the marker", async () => {
    const { relay, forwarded, send } = harness();
    try {
      for (const [method, path] of [
        ["GET", `${BASE}/chat/messages`], ["POST", `${BASE}/members`], ["POST", BASE], ["DELETE", BASE],
        ["GET", `${BASE}/project/confirm`], ["POST", `${BASE}/project/inventory`], ["GET", `${BASE}/members/extra`],
      ] as const) {
        expect((await send(method, path)).status).toBe(404);
      }
      expect(forwarded).toEqual([]);
    } finally {
      relay.close();
    }
  });

  it("stays unroutable without a well-formed runtime id", async () => {
    const { relay, forwarded, resolveOwnerRuntimeHome, send } = harness();
    try {
      const { "x-matrix-collaboration-runtime": _runtime, ...noRuntime } = OWNER_HEADERS;
      expect((await send("GET", BASE, noRuntime)).status).toBe(404);
      expect((await send("GET", BASE, { ...OWNER_HEADERS, "x-matrix-collaboration-runtime": "vps:../../other" })).status).toBe(404);
      expect(forwarded).toEqual([]);
      expect(resolveOwnerRuntimeHome).not.toHaveBeenCalled();
    } finally {
      relay.close();
    }
  });

  it("refuses a caller who does not own the named runtime", async () => {
    const { relay, forwarded, send } = harness();
    try {
      expect((await send("GET", BASE, OWNER_HEADERS, "user_someone_else")).status).toBe(404);
      expect(forwarded).toEqual([]);
    } finally {
      relay.close();
    }
  });
});

describe("createOwnerRuntimeHomeResolver", () => {
  const LOGICAL = "vps-11111111-1111-4111-8111-111111111111";
  // Distinct from every other id in this file, so the machine check provably receives the caller.
  const CALLER = "user_runtime_owner_7";

  function resolver(record: { ownerId: string } | null, origin: string | null = HOME.origin) {
    const resolveRuntimeOrigin = vi.fn(async () => origin);
    const endpoints = { resolve: vi.fn(async () => record) };
    return { resolve: createOwnerRuntimeHomeResolver({ endpoints, resolveRuntimeOrigin }), resolveRuntimeOrigin, endpoints };
  }

  it("resolves an enrolled runtime registered by the caller, checking ownership against the machine", async () => {
    const { resolve, resolveRuntimeOrigin } = resolver({ ownerId: CALLER });
    await expect(resolve(CALLER, LOGICAL)).resolves.toEqual({ runtimeId: LOGICAL, origin: HOME.origin });
    expect(resolveRuntimeOrigin).toHaveBeenCalledWith("vps:11111111-1111-4111-8111-111111111111", CALLER);
  });

  it("refuses a runtime registered by someone else before looking up any machine", async () => {
    const { resolve, resolveRuntimeOrigin } = resolver({ ownerId: "user_other" });
    await expect(resolve(CALLER, LOGICAL)).resolves.toBeNull();
    expect(resolveRuntimeOrigin).not.toHaveBeenCalled();
  });

  it("refuses an unregistered runtime, a non-enrolled id, and a machine that is not the caller's or not running", async () => {
    await expect(resolver(null).resolve(CALLER, LOGICAL)).resolves.toBeNull();
    const notEnrolled = resolver({ ownerId: CALLER });
    await expect(notEnrolled.resolve(CALLER, "local-home")).resolves.toBeNull();
    expect(notEnrolled.endpoints.resolve).not.toHaveBeenCalled();
    await expect(resolver({ ownerId: CALLER }, null).resolve(CALLER, LOGICAL)).resolves.toBeNull();
  });
});
