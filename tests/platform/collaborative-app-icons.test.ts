import sharp from "sharp";
import { sql } from "kysely";
import { eraseOwnerPlatformData } from "../../packages/platform/src/account-deletion/cleanup-data.js";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COLLABORATIVE_APP_ICON_MAX_BYTES } from "@matrix-os/contracts";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
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
 * launcher. The directory event carries a bounded thumbnail; the platform serves it only to
 * current organization members, never fetches owner URLs, and never serves SVG or HTML.
 */
const now = new Date("2026-11-05T10:00:00.000Z");
const scopeId = "10000000-0000-4000-8000-000000000001";
const runtimeId = "runtime_owner";
const otherRuntimeId = "runtime_other";
const token = "s".repeat(32);
const member = platformCollaborationActors.recipientWithoutComputer;
const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#e02f70" } }).png().toBuffer();
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
        ...(input.iconSha256 ? { thumbnail: { sha256: input.iconSha256, contentType: "image/png" as const, base64: png.toString("base64") } } : {}),
      },
      recipients: [{ actorId: runtime === runtimeId ? platformCollaborationActors.owner : "user_other", status: "accepted" }],
    });
  }

  function iconRequest(actor: string | null, query = `?v=${pngSha}`, headers: Record<string, string> = {}) {
    return routes.request(`/api/collaboration/shared-apps/${scopeId}/icon${query}`, {
      headers: { ...(actor ? { "x-test-actor": actor } : {}), ...headers },
    });
  }

  it("lists the owner manifest name and a versioned platform icon URL after the directory event stores a thumbnail", async () => {
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
    await share({ iconSha256: pngSha });

    const response = await iconRequest(member);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");

    const stale = await iconRequest(member, `?v=${"0".repeat(64)}`);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");

    const revalidated = await iconRequest(member, `?v=${pngSha}`, { "if-none-match": `"${pngSha}"` });
    expect(revalidated.status).toBe(304);
  });

  it("hides icons from outsiders, lapsed members, stopped shares, and unauthenticated requests", async () => {
    await share({ iconSha256: pngSha });

    expect((await iconRequest(null)).status).toBe(401);
    expect((await iconRequest(platformCollaborationActors.outsider)).status).toBe(404);
    currentMemberships.delete(`${member}:org_matrix_team`);
    expect((await iconRequest(member, `?v=${pngSha}`, { "if-none-match": `"${pngSha}"` })).status).toBe(404);
    expect((await iconRequest(member)).status).toBe(404);
    currentMemberships.add(`${member}:org_matrix_team`);

    await share({ iconSha256: pngSha, revision: 2, state: "stopped" });
    expect((await iconRequest(member)).status).toBe(404);
    const stopped = await fixture.collaborationDb.selectFrom("collaboration_directory").select(["app_icon_bytes", "app_icon_content_type", "app_icon_sha256"]).executeTakeFirstOrThrow();
    expect(stopped).toEqual({ app_icon_bytes: null, app_icon_content_type: null, app_icon_sha256: null });
  });

  it("validates icon route parameters at the boundary", async () => {
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

  it("removes the obsolete upload endpoint", async () => {
    expect((await routes.request(`/internal/collaboration/app-icons/${pngSha}`, { method: "PUT", body: png })).status).toBe(404);
  });

  it("fences stale and replayed presentation; replacement discards previous bytes", async () => {
    await share({ name: "Newest", iconSha256: pngSha, revision: 3 });
    expect(await share({ name: "Stale", revision: 2 })).toBe(false);
    expect(await share({ name: "Replay", revision: 3 })).toBe(false);
    expect((await repository.getDirectoryRoute(scopeId))?.app?.name).toBe("Newest");
    expect((await iconRequest(member)).status).toBe(200);
    await share({ name: "No artwork", revision: 4 });
    expect((await iconRequest(member)).status).toBe(404);
    expect((await fixture.collaborationDb.selectFrom("collaboration_directory").select("app_icon_bytes").executeTakeFirstOrThrow()).app_icon_bytes).toBeNull();
  });

  it("never resolves another scope's or runtime's thumbnail by its hash", async () => {
    await share({ iconSha256: pngSha });
    const differentScope = "10000000-0000-4000-8000-000000000002";
    expect((await routes.request(`/api/collaboration/shared-apps/${differentScope}/icon?v=${pngSha}`, { headers: { "x-test-actor": member } })).status).toBe(404);
    await expect(share({ iconSha256: pngSha, revision: 2, runtime: otherRuntimeId })).rejects.toMatchObject({ code: "conflict" });
    expect((await repository.getDirectoryRoute(scopeId))?.runtimeId).toBe(runtimeId);
  });

  it("delivers routing metadata when optional thumbnail validation fails", async () => {
    const event = {
      eventId: "20000000-0000-4000-8000-000000000001", scopeId, runtimeId,
      ownerId: platformCollaborationActors.owner, kind: "app", organizationId: "org_matrix_team",
      audience: "current_membership", authorityGeneration: 1, metadataRevision: 1,
      app: { ...app, name: "Team Tracker", thumbnail: { contentType: "image/png", sha256: pngSha, base64: "not-base64" } },
      recipients: [],
    };
    const request = (payload: unknown, authorization = token) => routes.request("/internal/collaboration/directory", {
      method: "PUT", headers: { authorization: `Bearer ${authorization}`, "x-matrix-runtime-id": runtimeId, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect((await request(event, "x".repeat(32))).status).toBe(401);
    expect((await request({ ...event, ownerId: "user_other" })).status).toBe(403);
    const wide = await sharp({ create: { width: 97, height: 1, channels: 4, background: "red" } }).png().toBuffer();
    for (const [index, thumbnail] of [
      { ...event.app.thumbnail },
      { ...event.app.thumbnail, base64: wide.toString("base64"), sha256: sha256(wide) },
      { ...event.app.thumbnail, base64: Buffer.alloc(48 * 1024 + 1).toString("base64") },
      { ...event.app.thumbnail, base64: png.toString("base64"), sha256: "0".repeat(64) },
      { ...event.app.thumbnail, base64: Buffer.from("<svg><script/></svg>").toString("base64") },
      { ...event.app.thumbnail, base64: png.subarray(0, 40).toString("base64"), sha256: sha256(png.subarray(0, 40)) },
    ].entries()) {
      expect((await request({ ...event, metadataRevision: index + 1, app: { ...event.app, thumbnail } })).status).toBe(204);
      expect((await iconRequest(member)).status).toBe(404);
      expect((await repository.getDirectoryRoute(scopeId))?.app?.name).toBe("Team Tracker");
    }
    expect((await request({ ...event, metadataRevision: 10, app: { ...event.app,
      thumbnail: { contentType: "image/png", sha256: pngSha, base64: png.toString("base64") },
    } })).status).toBe(204);
    expect((await iconRequest(member)).status).toBe(200);
    const listing = await routes.request("/api/collaboration/shared-apps?fields=display", { headers: { "x-test-actor": member } });
    expect(JSON.stringify(await listing.json())).not.toContain(png.toString("base64"));
    expect((await request({ ...event, padding: "x".repeat(96 * 1024) })).status).toBe(413);
  });

  it("erases thumbnail bytes through the existing owner directory cleanup", async () => {
    await share({ iconSha256: pngSha });
    // Erasure requires shared resources to be stopped/detached. Retain bytes to exercise cleanup.
    await fixture.collaborationDb.updateTable("collaboration_directory").set({ organization_id: null, audience: null }).execute();
    await eraseOwnerPlatformData(fixture.db, platformCollaborationActors.owner);
    expect(await fixture.collaborationDb.selectFrom("collaboration_directory").selectAll().execute()).toEqual([]);
    expect((await sql<{ present: boolean }>`SELECT to_regclass('collaboration_app_icons') IS NOT NULL AS present`.execute(fixture.collaborationDb)).rows[0]?.present).toBe(false);
  });
});
