import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COLLABORATIVE_APP_ICON_MAX_BYTES } from "@matrix-os/contracts";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { CollaborativeAppIconRepository } from "../../packages/platform/src/collaboration/app-icon-repository.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

/**
 * ENG-490: a shared app shows its owner's real raster icon and manifest name in every member
 * launcher. The owner runtime uploads content-addressed bytes; the platform serves them only to
 * current organization members, never fetches owner URLs, and never serves SVG or HTML.
 */
const now = new Date("2026-11-05T10:00:00.000Z");
const scopeId = "10000000-0000-4000-8000-000000000001";
const runtimeId = "runtime_owner";
const otherRuntimeId = "runtime_other";
const token = "s".repeat(32);
const member = platformCollaborationActors.recipientWithoutComputer;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("IHDR-test-icon-bytes"),
]);
const pngSha = sha256(png);
const app = {
  appId: "team-tracker",
  catalogId: "50000000-0000-4000-8000-000000000001",
  readinessId: "60000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: 1,
  state: "active" as const,
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("collaborative app icons", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let routes: Hono;
  const currentMemberships = new Set<string>();

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
    routes = new Hono();
    routes.route("/", createPlatformCollaborationRoutes({
      repository,
      resolveActor: async (context) => context.req.header("x-test-actor") ?? null,
      authenticateRuntime: async (input) => input.bearerToken === token
        && (input.runtimeId === runtimeId || input.runtimeId === otherRuntimeId)
        ? { runtimeId: input.runtimeId, ownerId: input.runtimeId === runtimeId ? platformCollaborationActors.owner : "user_other" }
        : null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId === platformCollaborationActors.owner ? "Owner" : "Member" }),
      resolveInvitationIdentifier: async () => null,
      listOrganizationIds: async () => ["org_matrix_team"],
      isCurrentOrganizationMember: async ({ actorId, organizationId }) =>
        currentMemberships.has(`${actorId}:${organizationId}`),
      now: () => now,
    }));
    currentMemberships.add(`${member}:org_matrix_team`);
  });

  afterEach(async () => {
    currentMemberships.clear();
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  function upload(body: Uint8Array, sha = sha256(body), runtime = runtimeId, headers: Record<string, string> = {}) {
    return routes.request(`/internal/collaboration/app-icons/${sha}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "x-matrix-runtime-id": runtime,
        "content-type": "application/octet-stream",
        ...headers,
      },
      body,
    });
  }

  async function share(input: { name?: string; iconSha256?: string; revision?: number; state?: "active" | "stopped"; runtime?: string } = {}) {
    const runtime = input.runtime ?? runtimeId;
    return repository.applyDirectoryEvent({
      eventId: `20000000-0000-4000-8000-00000000000${input.revision ?? 1}`,
      scopeId,
      runtimeId: runtime,
      ownerId: runtime === runtimeId ? platformCollaborationActors.owner : "user_other",
      kind: "app",
      organizationId: "org_matrix_team",
      audience: input.state === "stopped" ? undefined : "current_membership",
      authorityGeneration: 1,
      metadataRevision: input.revision ?? 1,
      app: {
        ...app,
        shareRevision: input.revision ?? 1,
        state: input.state ?? "active",
        ...(input.name ? { name: input.name } : {}),
        ...(input.iconSha256 ? { iconSha256: input.iconSha256 } : {}),
      },
      recipients: [{ actorId: runtime === runtimeId ? platformCollaborationActors.owner : "user_other", status: "accepted" }],
    });
  }

  function iconRequest(actor: string | null, query = `?v=${pngSha}`, headers: Record<string, string> = {}) {
    return routes.request(`/api/collaboration/shared-apps/${scopeId}/icon${query}`, {
      headers: { ...(actor ? { "x-test-actor": actor } : {}), ...headers },
    });
  }

  it("lists the owner manifest name and a versioned platform icon URL after the runtime uploads raster bytes", async () => {
    expect((await upload(png)).status).toBe(204);
    await share({ name: "Team Tracker", iconSha256: pngSha });

    const listing = await routes.request("/api/collaboration/shared-apps?fields=display", { headers: { "x-test-actor": member } });
    expect(listing.status).toBe(200);
    const body = await listing.json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      scopeId,
      appId: app.appId,
      name: "Team Tracker",
      iconUrl: `/api/collaboration/shared-apps/${scopeId}/icon?v=${pngSha}`,
    });

    const single = await routes.request(`/api/collaboration/shared-apps/${scopeId}?fields=display`, { headers: { "x-test-actor": member } });
    expect(await single.json()).toMatchObject({ name: "Team Tracker", iconUrl: body.items[0]!.iconUrl });
  });

  it("keeps responses parseable by released strict clients that do not opt in to display fields", async () => {
    // Released shells and Electron builds parse directory items with a strict schema that
    // predates `name` and `iconUrl`; they never send `fields=display`.
    const legacyKeys = ["appId", "authorityGeneration", "buildId", "catalogId", "organizationId", "owner",
      "readinessId", "registrationIncarnation", "runtimeId", "scopeId", "shareRevision"];
    await upload(png);
    await share({ name: "Team Tracker", iconSha256: pngSha });
    const listing = await routes.request("/api/collaboration/shared-apps?limit=10", { headers: { "x-test-actor": member } });
    const item = (await listing.json() as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(Object.keys(item).sort()).toEqual(legacyKeys);
    const single = await routes.request(`/api/collaboration/shared-apps/${scopeId}`, { headers: { "x-test-actor": member } });
    expect(Object.keys(await single.json() as Record<string, unknown>).sort()).toEqual(legacyKeys);
    expect((await routes.request("/api/collaboration/shared-apps?fields=everything", { headers: { "x-test-actor": member } })).status)
      .toBe(422);
    expect((await routes.request("/api/collaboration/shared-apps?fields=display&fields=display", { headers: { "x-test-actor": member } })).status)
      .toBe(422);
  });

  it("serves icon bytes to a current member with inert, versioned caching headers", async () => {
    await upload(png);
    await share({ iconSha256: pngSha });

    const response = await iconRequest(member);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

    const stale = await iconRequest(member, `?v=${"0".repeat(64)}`);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");

    const revalidated = await iconRequest(member, `?v=${pngSha}`, { "if-none-match": `"${pngSha}"` });
    expect(revalidated.status).toBe(304);
  });

  it("hides icons from outsiders, lapsed members, stopped shares, and unauthenticated requests", async () => {
    await upload(png);
    await share({ iconSha256: pngSha });

    expect((await iconRequest(null)).status).toBe(401);
    expect((await iconRequest(platformCollaborationActors.outsider)).status).toBe(404);
    currentMemberships.delete(`${member}:org_matrix_team`);
    expect((await iconRequest(member)).status).toBe(404);
    currentMemberships.add(`${member}:org_matrix_team`);

    await share({ iconSha256: pngSha, revision: 2, state: "stopped" });
    expect((await iconRequest(member)).status).toBe(404);
  });

  it("validates icon route parameters at the boundary", async () => {
    await upload(png);
    await share({ iconSha256: pngSha });
    const headers = { "x-test-actor": member };
    expect((await routes.request("/api/collaboration/shared-apps/not-a-uuid/icon", { headers })).status).toBe(422);
    expect((await iconRequest(member, "?v=not-hex")).status).toBe(422);
    expect((await iconRequest(member, `?v=${pngSha}&path=../../etc`)).status).toBe(422);
  });

  it("returns not found for a share without an icon so the launcher keeps its letter tile", async () => {
    await share({ name: "Team Tracker" });
    const listing = await routes.request("/api/collaboration/shared-apps?fields=display", { headers: { "x-test-actor": member } });
    const item = (await listing.json() as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item.name).toBe("Team Tracker");
    expect(item).not.toHaveProperty("iconUrl");
    expect((await iconRequest(member, "")).status).toBe(404);
  });

  it("rejects unauthenticated, oversized, non-raster, and mislabelled uploads", async () => {
    expect((await routes.request(`/internal/collaboration/app-icons/${pngSha}`, { method: "PUT", body: png })).status).toBe(401);
    expect((await upload(png, pngSha, runtimeId, { authorization: `Bearer ${"x".repeat(32)}` })).status).toBe(401);

    const oversized = Buffer.alloc(COLLABORATIVE_APP_ICON_MAX_BYTES + 1);
    png.copy(oversized);
    expect((await upload(oversized)).status).toBe(413);

    const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>");
    expect((await upload(svg)).status).toBe(422);
    const html = Buffer.from("<!doctype html><html><script>alert(1)</script></html>");
    expect((await upload(html)).status).toBe(422);
    expect((await upload(png, "f".repeat(64))).status).toBe(422);
    expect((await upload(png, "NOT-A-HASH")).status).toBe(422);

    expect(await fixture.collaborationDb.selectFrom("collaboration_app_icons").select("sha256").execute()).toEqual([]);
  });

  it("stores content-addressed icons idempotently", async () => {
    expect((await upload(png)).status).toBe(204);
    expect((await upload(png)).status).toBe(204);
    expect(await fixture.collaborationDb.selectFrom("collaboration_app_icons")
      .select(["runtime_id", "sha256", "content_type"]).execute())
      .toEqual([{ runtime_id: runtimeId, sha256: pngSha, content_type: "image/png" }]);
  });

  it("never lets one runtime reference icon bytes another runtime uploaded", async () => {
    expect((await upload(png, pngSha, otherRuntimeId)).status).toBe(204);
    await share({ iconSha256: pngSha });
    const route = await repository.getDirectoryRoute(scopeId);
    expect(route?.app?.iconSha256).toBeUndefined();
    expect((await iconRequest(member)).status).toBe(404);
  });

  it("collects old unreferenced icons while keeping icons a directory row still names", async () => {
    const stalePng = Buffer.concat([png, Buffer.from("stale")]);
    await upload(png);
    await upload(stalePng);
    await share({ iconSha256: pngSha });
    await fixture.collaborationDb.updateTable("collaboration_app_icons")
      .set({ last_uploaded_at: new Date(now.getTime() - 8 * 24 * 60 * 60_000).toISOString() })
      .execute();

    expect(await new CollaborativeAppIconRepository(fixture.collaborationDb, { now: () => now }).collectUnreferenced(10)).toBe(1);
    expect((await fixture.collaborationDb.selectFrom("collaboration_app_icons").select("sha256").execute())
      .map((row) => row.sha256)).toEqual([pngSha]);
  });

  it("caps each runtime's stored icons by evicting its oldest unreferenced upload", async () => {
    const icons = Array.from({ length: 3 }, (_, index) => Buffer.concat([png, Buffer.from(`variant-${index}`)]));
    const iconRepository = new CollaborativeAppIconRepository(fixture.collaborationDb, { now: () => now, maxPerRuntime: 2 });
    for (const [index, icon] of icons.entries()) {
      await iconRepository.put({
        runtimeId,
        sha256: sha256(icon),
        contentType: "image/png",
        bytes: icon,
        uploadedAt: new Date(now.getTime() + index * 1_000),
      });
    }
    await share({ iconSha256: sha256(icons[2]!) });
    const fourth = Buffer.concat([png, Buffer.from("variant-3")]);
    await iconRepository.put({ runtimeId, sha256: sha256(fourth), contentType: "image/png", bytes: fourth,
      uploadedAt: new Date(now.getTime() + 10_000) });
    const stored = await fixture.collaborationDb.selectFrom("collaboration_app_icons").select("sha256").execute();
    expect(stored.map((row) => row.sha256).sort()).toEqual([sha256(icons[2]!), sha256(fourth)].sort());
  });
});
