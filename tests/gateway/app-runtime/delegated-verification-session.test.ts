import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { invalidateManifestCache } from "../../../packages/gateway/src/app-runtime/manifest-loader.js";
import { registerAppRuntimeRoutes } from "../../../packages/gateway/src/server/app-runtime-routes.js";

// ENG-290 RED contract proposal, not a production implementation. Endpoint names
// and the dependency seam below are provisional. The real registrar currently
// ignores this seam and returns 404 for issuance: no fake capability verifier or
// test-only route makes these tests green. Downstream cases cannot qualify until
// issuance exists. This in-process suite does NOT prove platform routing, browser
// bridge execution, or live Postgres persistence; those remain acceptance gates.
const OWNER = "user_owner";
const RUNTIME = "runtime_owner_primary";
const RUN = "run_approved";
const CONTROL_SECRET = "fixture-control-secret-not-an-automation-credential";
const NOW = Date.UTC(2026, 9, 14, 12);
const TTL_MS = 30_000;
type RunState = {
  ownerId: string;
  runtimeId: string;
  status: "running" | "cancelled" | "completed";
  approval: null | { slug: string; expiresAt: number; revokedAt: number | null };
};
const GrantSchema = z.strictObject({
  capability: z.string().min(32).max(512), launchUrl: z.string().max(2048),
  expiresAt: z.number().int(),
  binding: z.strictObject({ ownerId: z.string(), runtimeId: z.string(), runId: z.string(), slug: z.string() }),
});
type Grant = z.infer<typeof GrantSchema>;

let home: string;
let app: Hono;
let manager: ReturnType<typeof registerAppRuntimeRoutes> | undefined;
let run: RunState;
let provenance: "owner-built" | "imported";
const bridgeQuery = vi.fn(async () => [{ id: "row_fixture", title: "Persisted fixture" }]);

async function createFixture(slug: string, listingTrust = "first_party") {
  const dir = join(home, "apps", slug);
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "matrix.json"), JSON.stringify({
    name: slug, slug, version: "1.0.0", runtime: "vite", runtimeVersion: "^1.0.0",
    scope: "personal", listingTrust, database: "postgres",
    build: { command: "pnpm build", output: "dist" },
    storage: { tables: { entries: { columns: { title: "text" } } } },
  }));
  // Prebuilt route fixture only, not a claimed React/Vite build or live Notes.
  await writeFile(join(dir, "dist", "index.html"), `<!doctype html><title>${slug}</title><p>Production entry: ${slug}</p>`);
  invalidateManifestCache();
}

function ownerHeaders(actorId = OWNER) {
  return {
    Authorization: `Bearer ${CONTROL_SECRET}`,
    "x-platform-user-id": actorId,
    "x-platform-verified": createHmac("sha256", CONTROL_SECRET).update(actorId).digest("hex"),
    "Content-Type": "application/json",
  };
}

function requestGrant(body: Record<string, unknown> = {}, actorId = OWNER, slug = "notes") {
  return app.request(`/api/apps/${slug}/verification-sessions`, {
    method: "POST", headers: ownerHeaders(actorId),
    body: JSON.stringify({ runtimeId: RUNTIME, runId: RUN, ...body }),
  });
}

async function grant(slug = "notes"): Promise<Grant> {
  const response = await requestGrant({}, OWNER, slug);
  expect(response.status, "owner-approved delegation issuance must exist").toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = GrantSchema.parse(await response.json());
  expect(body.binding).toEqual({ ownerId: OWNER, runtimeId: RUNTIME, runId: RUN, slug });
  expect(body.capability).toEqual(expect.any(String));
  expect(body.expiresAt).toBeGreaterThan(NOW);
  expect(body.expiresAt).toBeLessThanOrEqual(NOW + TTL_MS);
  const url = new URL(body.launchUrl, "https://owner.example.test");
  expect(url.pathname).toBe(`/apps/${slug}/`);
  expect(url.searchParams.get("verification")).toBe(body.capability);
  expect(body).not.toHaveProperty("ownerToken");
  expect(JSON.stringify(body)).not.toContain(CONTROL_SECRET);
  return body;
}

function redeem(value: Grant, slug?: string) {
  const url = new URL(value.launchUrl, "https://owner.example.test");
  if (slug) url.pathname = `/apps/${slug}/`;
  // Automation never receives ownerHeaders(), Clerk cookies, or machine secret.
  return app.request(url.toString(), { headers: { Accept: "text/html" }, redirect: "manual" });
}

async function open(value: Grant) {
  const response = await redeem(value);
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("location")).toBe("/apps/notes/");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  expect(cookie).not.toContain(CONTROL_SECRET);
  expect(cookie).not.toContain("__session=");
  return cookie!;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("MATRIX_AUTH_TOKEN", CONTROL_SECRET);
  vi.stubEnv("MATRIX_USER_ID", OWNER);
  vi.stubEnv("MATRIX_HANDLE", "owner-fixture");
  vi.stubEnv("MATRIX_AUTH_ALLOW_INSECURE_DEV", "0");
  vi.stubEnv("ALLOW_COMMUNITY_INSTALLS", "0");
  home = await mkdtemp(join(tmpdir(), "eng-290-"));
  run = {
    ownerId: OWNER, runtimeId: RUNTIME, status: "running",
    approval: { slug: "notes", expiresAt: NOW + TTL_MS, revokedAt: null },
  };
  provenance = "owner-built";
  bridgeQuery.mockClear();
  app = new Hono();
  app.use("*", authMiddleware(CONTROL_SECRET));
  // Future implementation must consume authoritative dependencies, not trust
  // body owner/approval hints. A fixed single-run fixture is bounded by design.
  const deps = {
    homePath: home, appSessionMasterSecret: CONTROL_SECRET,
    devAppAuthBypass: false, publicHost: "owner.example.test", onAppError: vi.fn(),
    delegatedVerification: {
      ownerId: OWNER, runtimeId: RUNTIME, ttlMs: TTL_MS, maxEntries: 16,
      readRun: async (id: string) => id === RUN ? run : null,
      readAppProvenance: async () => provenance,
      executeBridgeQuery: bridgeQuery,
      audit: vi.fn(),
    },
  };
  manager = registerAppRuntimeRoutes(app, deps);
  await createFixture("notes");
  await createFixture("other-app");
});

afterEach(async () => {
  await manager?.shutdownAll();
  manager = undefined;
  await rm(home, { recursive: true, force: true });
  invalidateManifestCache();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("ENG-290 delegated app verification (intentionally RED)", () => {
  it("opens the exact production entry with the host bridge and no owner credentials", async () => {
    const cookie = await open(await grant());
    const response = await app.request("/apps/notes/", { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Production entry: notes");
    expect(html).toContain("MatrixOS");
    expect(html).not.toContain(CONTROL_SECRET);
    // Scoped bridge transport proposal. Adapter spy proves dispatch identity
    // only; it deliberately does not claim a real Postgres/browser round trip.
    const query = await app.request("/apps/notes/__matrix/bridge/query", {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "find", table: "entries", app: "notes" }),
    });
    expect(query.status).toBe(200);
    expect(await query.json()).toEqual([{ id: "row_fixture", title: "Persisted fixture" }]);
    expect(bridgeQuery).toHaveBeenCalledWith(
      { ownerId: OWNER, runtimeId: RUNTIME, runId: RUN, slug: "notes" },
      { action: "find", table: "entries", app: "notes" },
    );
    expect((await app.request("/api/bridge/query", {
      method: "POST", headers: { Cookie: cookie }, body: "{}",
    })).status).toBe(401);
  });

  it.each(["missing", "unapproved", "cancelled", "completed", "revoked"] as const)(
    "denies issuance for a %s run despite authenticated owner access", async (state) => {
      if (state === "unapproved") run.approval = null;
      if (state === "cancelled" || state === "completed") run.status = state;
      if (state === "revoked") run.approval!.revokedAt = NOW;
      const response = await requestGrant(state === "missing" ? { runId: "run_unknown" } : {});
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "App verification unavailable" });
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );

  it.each(["actor", "run-owner", "runtime", "slug"] as const)("denies a mismatched %s at issuance", async (boundary) => {
    if (boundary === "run-owner") run.ownerId = "user_other";
    if (boundary === "runtime") run.runtimeId = "runtime_other";
    const response = await requestGrant({}, boundary === "actor" ? "user_other" : OWNER,
      boundary === "slug" ? "other-app" : "notes");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "App verification unavailable" });
  });

  it("rejects a cross-slug redemption and never dispatches bridge data", async () => {
    expect((await redeem(await grant(), "other-app")).status).toBe(401);
    expect(bridgeQuery).not.toHaveBeenCalled();
  });

  it("allows exactly one redemption, rejecting replay", async () => {
    const value = await grant();
    await open(value);
    expect((await redeem(value)).status).toBe(401);
  });

  it("expires the capability at its exact deadline", async () => {
    const value = await grant();
    vi.setSystemTime(value.expiresAt);
    expect((await redeem(value)).status).toBe(401);
  });

  it.each(["cancelled", "revoked", "expired"] as const)("denies redemption after approval becomes %s", async (state) => {
    const value = await grant();
    if (state === "cancelled") run.status = "cancelled";
    if (state === "revoked") run.approval!.revokedAt = NOW + 1;
    if (state === "expired") run.approval!.expiresAt = NOW;
    expect((await redeem(value)).status).toBe(401);
  });

  it.each(["cancelled", "revoked", "expired"] as const)("denies document and bridge access after an opened session becomes %s", async (state) => {
    const value = await grant();
    const cookie = await open(value);
    if (state === "cancelled") run.status = "cancelled";
    if (state === "revoked") run.approval!.revokedAt = NOW + 1;
    if (state === "expired") vi.setSystemTime(value.expiresAt);
    expect((await app.request("/apps/notes/", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await app.request("/apps/notes/__matrix/bridge/query", {
      method: "POST", headers: { Cookie: cookie }, body: "{}",
    })).status).toBe(401);
    expect(bridgeQuery).not.toHaveBeenCalled();
  });

  it.each(["owner", "runtime"] as const)("rechecks %s scope at redemption instead of granting ambient owner authority", async (boundary) => {
    const value = await grant();
    if (boundary === "owner") run.ownerId = "user_other";
    if (boundary === "runtime") run.runtimeId = "runtime_other";
    expect((await redeem(value)).status).toBe(401);
  });

  it("rejects caller-authored owner/runtime/approval hints", async () => {
    run.approval = null;
    const response = await requestGrant({ ownerId: OWNER, approved: true, ttlMs: 600_000 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "App verification unavailable" });
  });

  it("keeps a redeemed session and bridge scoped to the approved slug", async () => {
    const cookie = await open(await grant());
    expect((await app.request("/apps/other-app/", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await app.request("/apps/notes/__matrix/bridge/query", {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "find", app: "other-app", table: "entries" }),
    })).status).toBe(403);
    expect(bridgeQuery).not.toHaveBeenCalled();
  });

  it.each(["imported-first-party", "community", "unknown"])("denies %s apps without promoting trust", async (kind) => {
    provenance = "imported";
    await createFixture("notes", kind === "imported-first-party" ? "first_party" : kind);
    const response = await requestGrant();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "App verification unavailable" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
