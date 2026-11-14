import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CollaborativeAppDirectoryResponseSchema,
  CollaborativeAppLaunchResponseSchema,
} from "@matrix-os/contracts";
import { CollaborativeAppLaunchSessions } from "../../packages/platform/src/collaboration/app-launch-sessions.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-11-05T10:00:00.000Z");
const scopeId = "10000000-0000-4000-8000-000000000001";
const organizationId = "org_matrix_team";
const member = platformCollaborationActors.recipientWithoutComputer;
const runtimeToken = "r".repeat(48);
const app = {
  appId: "team-tracker",
  catalogId: "50000000-0000-4000-8000-000000000001",
  readinessId: "60000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: 1,
  state: "active" as const,
};

function png(fill: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const runtimeHeaders = (runtimeId = "runtime_owner") => ({
  authorization: `Bearer ${runtimeToken}`,
  "x-matrix-runtime-id": runtimeId,
});

describe("shared app presentation: owner publication to recipient launcher", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let sessions: CollaborativeAppLaunchSessions;
  let routes: Hono;
  const currentMemberships = new Set<string>();
  let metadataRevision = 1;

  async function applyApp(next: Partial<typeof app> = {}) {
    metadataRevision += 1;
    await repository.applyDirectoryEvent({
      eventId: `20000000-0000-4000-8000-${String(metadataRevision).padStart(12, "0")}`,
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "app",
      organizationId,
      audience: next.state && next.state !== "active" ? undefined : "current_membership",
      authorityGeneration: 1,
      metadataRevision,
      app: { ...app, ...next },
      recipients: [{ actorId: platformCollaborationActors.owner, status: next.state === "stopped" ? "revoked" : "accepted" }],
    });
  }

  async function publish(body: unknown, runtimeId = "runtime_owner") {
    return routes.request(`/internal/collaboration/shared-apps/${scopeId}/presentation`, {
      method: "PUT",
      headers: { ...runtimeHeaders(runtimeId), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function upload(bytes: Uint8Array, digest = sha256(bytes), contentType = "image/png", runtimeId = "runtime_owner") {
    return routes.request(`/internal/collaboration/shared-apps/${scopeId}/artwork/${digest}`, {
      method: "PUT",
      headers: { ...runtimeHeaders(runtimeId), "content-type": contentType },
      body: bytes,
    });
  }

  async function listAs(actorId: string, query = "?limit=10&presentation=1") {
    const response = await routes.request(`/api/collaboration/shared-apps${query}`, { headers: { "x-test-actor": actorId } });
    expect(response.status).toBe(200);
    return CollaborativeAppDirectoryResponseSchema.parse(await response.json());
  }

  async function publishArtwork(bytes: Uint8Array, name = "Sprint Board") {
    const published = await publish({
      appId: app.appId, name, artwork: { sha256: sha256(bytes), contentType: "image/png", byteLength: bytes.byteLength },
    });
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({ artworkRequired: true });
    expect((await upload(bytes)).status).toBe(204);
  }

  beforeEach(async () => {
    metadataRevision = 0;
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
    sessions = new CollaborativeAppLaunchSessions({
      db: fixture.collaborationDb,
      open: async () => ({ request: async () => new Response("<main></main>"), close: async () => undefined }),
      now: () => now.getTime(),
      startTimer: false,
    });
    routes = new Hono();
    routes.route("/", createPlatformCollaborationRoutes({
      repository,
      launchSessions: sessions,
      resolveActor: async (context) => context.req.header("x-test-actor") ?? null,
      authenticateRuntime: async ({ runtimeId, bearerToken }) => bearerToken === runtimeToken && runtimeId === "runtime_owner"
        ? { runtimeId, ownerId: platformCollaborationActors.owner }
        : bearerToken === runtimeToken && runtimeId === "runtime_other"
          ? { runtimeId, ownerId: "user_platform_other_owner" }
          : null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId === platformCollaborationActors.owner ? "Owner" : "Member" }),
      resolveInvitationIdentifier: async () => null,
      listOrganizationIds: async () => [organizationId],
      isCurrentOrganizationMember: async ({ actorId, organizationId: requested }) => currentMemberships.has(`${actorId}:${requested}`),
      now: () => now,
    }));
    currentMemberships.add(`${member}:${organizationId}`);
    await applyApp();
  });

  afterEach(async () => {
    currentMemberships.clear();
    await sessions.close();
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  it("shows members the owner's name and artwork only when the client asks for presentation", async () => {
    const icon = png(7);
    await publishArtwork(icon);

    const listed = await listAs(member);
    const iconUrl = `/api/collaboration/shared-apps/${scopeId}/artwork/${sha256(icon)}`;
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.presentation).toEqual({ name: "Sprint Board", iconUrl });

    // Released clients parse items strictly: without the opt-in they get the exact legacy shape.
    const legacy = await routes.request("/api/collaboration/shared-apps?limit=10", { headers: { "x-test-actor": member } });
    expect(Object.keys((await legacy.json() as { items: Record<string, unknown>[] }).items[0]!)).not.toContain("presentation");

    const single = await routes.request(`/api/collaboration/shared-apps/${scopeId}?presentation=1`, { headers: { "x-test-actor": member } });
    expect((await single.json() as { presentation: unknown }).presentation).toEqual({ name: "Sprint Board", iconUrl });

    const artwork = await routes.request(iconUrl, { headers: { "x-test-actor": member } });
    expect(artwork.status).toBe(200);
    expect(artwork.headers.get("content-type")).toBe("image/png");
    expect(artwork.headers.get("cache-control")).toBe("private, no-cache");
    expect(artwork.headers.get("x-content-type-options")).toBe("nosniff");
    expect(artwork.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(new Uint8Array(await artwork.arrayBuffer())).toEqual(icon);
    const etag = artwork.headers.get("etag")!;
    const revalidated = await routes.request(iconUrl, { headers: { "x-test-actor": member, "if-none-match": etag } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  it("serves inert SVG artwork sandboxed with its own type", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#5476bd"/></svg>');
    expect((await publish({
      appId: app.appId, name: "Shared Tasks Lab", artwork: { sha256: sha256(svg), contentType: "image/svg+xml", byteLength: svg.byteLength },
    })).status).toBe(200);
    expect((await upload(svg, sha256(svg), "image/svg+xml")).status).toBe(204);
    const iconUrl = (await listAs(member)).items[0]!.presentation!.iconUrl!;
    const served = await routes.request(iconUrl, { headers: { "x-test-actor": member } });
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(svg);
  });

  it("uses the owner's name and artwork for the shared launch target", async () => {
    const icon = png(9);
    await publishArtwork(icon);
    const launched = await routes.request(`/api/collaboration/shared-apps/${scopeId}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": member },
      body: JSON.stringify({ clientRequestId: "40000000-0000-4000-8000-000000000001", expectedShareRevision: "1", expectedBuildId: app.buildId }),
    });
    expect(launched.status).toBe(201);
    const target = CollaborativeAppLaunchResponseSchema.parse(await launched.json()).target;
    expect(target).toMatchObject({
      name: "Sprint Board",
      iconUrl: `/api/collaboration/shared-apps/${scopeId}/artwork/${sha256(icon)}`,
    });
  });

  it("keeps the owner's name without an icon while artwork is absent or not yet uploaded", async () => {
    expect((await publish({ appId: app.appId, name: "Sprint Board", artwork: null })).status).toBe(200);
    expect((await listAs(member)).items[0]!.presentation).toEqual({ name: "Sprint Board" });

    const icon = png(3);
    await publish({ appId: app.appId, name: "Sprint Board", artwork: { sha256: sha256(icon), contentType: "image/png", byteLength: icon.byteLength } });
    expect((await listAs(member)).items[0]!.presentation).toEqual({ name: "Sprint Board" });
    expect((await routes.request(`/api/collaboration/shared-apps/${scopeId}/artwork/${sha256(icon)}`, {
      headers: { "x-test-actor": member },
    })).status).toBe(404);
  });

  it("serves only the current artwork: a changed icon gets a new URL and the old one stops working", async () => {
    const first = png(1);
    const second = png(2);
    await publishArtwork(first);
    const oldUrl = (await listAs(member)).items[0]!.presentation!.iconUrl!;
    // Re-publishing unchanged metadata does not ask for the bytes again.
    expect(await (await publish({
      appId: app.appId, name: "Sprint Board", artwork: { sha256: sha256(first), contentType: "image/png", byteLength: first.byteLength },
    })).json()).toEqual({ artworkRequired: false });

    await publishArtwork(second, "Sprint Board v2");
    const updated = (await listAs(member)).items[0]!.presentation!;
    expect(updated.name).toBe("Sprint Board v2");
    expect(updated.iconUrl).not.toBe(oldUrl);
    expect((await routes.request(oldUrl, { headers: { "x-test-actor": member } })).status).toBe(404);
    expect(new Uint8Array(await (await routes.request(updated.iconUrl!, { headers: { "x-test-actor": member } })).arrayBuffer()))
      .toEqual(second);
  });

  it("denies artwork to signed-out actors, outsiders, former members, and after the owner stops sharing", async () => {
    const icon = png(5);
    await publishArtwork(icon);
    const iconUrl = (await listAs(member)).items[0]!.presentation!.iconUrl!;

    expect((await routes.request(iconUrl)).status).toBe(401);
    expect((await routes.request(iconUrl, { headers: { "x-test-actor": platformCollaborationActors.outsider } })).status).toBe(404);
    expect((await routes.request(`/api/collaboration/shared-apps/not-a-uuid/artwork/${sha256(icon)}`, {
      headers: { "x-test-actor": member },
    })).status).toBe(422);
    expect((await routes.request(`/api/collaboration/shared-apps/${scopeId}/artwork/..%2F..%2Fsystem`, {
      headers: { "x-test-actor": member },
    })).status).toBe(422);

    currentMemberships.delete(`${member}:${organizationId}`);
    expect((await routes.request(iconUrl, { headers: { "x-test-actor": member } })).status).toBe(404);
    currentMemberships.add(`${member}:${organizationId}`);

    await applyApp({ state: "stopped", shareRevision: 2 });
    expect((await routes.request(iconUrl, { headers: { "x-test-actor": member } })).status).toBe(404);
    const remaining = await fixture.collaborationDb.selectFrom("collaboration_app_presentations").selectAll().execute();
    expect(remaining).toEqual([]);
  });

  it("discards presentation when the share is rebound to a different app", async () => {
    await publishArtwork(png(4));
    await applyApp({ appId: "other-app", shareRevision: 2 });
    expect((await listAs(member)).items[0]).not.toHaveProperty("presentation");
  });

  it("accepts publication only from the owning runtime for an actively shared app", async () => {
    const body = { appId: app.appId, name: "Sprint Board", artwork: null };
    expect((await routes.request(`/internal/collaboration/shared-apps/${scopeId}/presentation`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).status).toBe(401);
    expect((await publish(body, "runtime_other")).status).toBe(404);
    expect((await publish({ ...body, appId: "other-app" })).status).toBe(404);
    expect((await publish({ ...body, name: "/home/owner/apps/team-tracker" })).status).toBe(422);
    expect((await publish({ ...body, extra: true })).status).toBe(422);
    expect((await routes.request(`/internal/collaboration/shared-apps/not-a-uuid/presentation`, {
      method: "PUT", headers: { ...runtimeHeaders(), "content-type": "application/json" }, body: JSON.stringify(body),
    })).status).toBe(422);
    await applyApp({ state: "stopped", shareRevision: 2 });
    expect((await publish(body)).status).toBe(404);
  });

  it("stores artwork bytes only when they match the declared digest, type, and size limit", async () => {
    const icon = png(6);
    await publish({ appId: app.appId, name: "Sprint Board", artwork: { sha256: sha256(icon), contentType: "image/png", byteLength: icon.byteLength } });

    expect((await upload(icon, sha256(icon), "image/png", "runtime_other")).status).toBe(404);
    expect((await upload(png(8), sha256(icon))).status).toBe(409);
    const undeclared = png(10);
    expect((await upload(undeclared)).status).toBe(409);
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    // Scriptable SVG is never stored, whichever type it claims; unsupported types are refused outright.
    expect((await upload(svg, sha256(svg), "image/svg+xml")).status).toBe(409);
    expect((await upload(svg, sha256(svg), "image/png")).status).toBe(409);
    expect((await upload(icon, sha256(icon), "image/gif")).status).toBe(415);
    expect((await upload(icon, sha256(icon), "image/jpeg")).status).toBe(409);
    const oversized = png(1, 4 * 1024 * 1024 + 1);
    expect((await upload(oversized)).status).toBe(413);
    expect((await listAs(member)).items[0]!.presentation).toEqual({ name: "Sprint Board" });

    expect((await upload(icon)).status).toBe(204);
    expect((await listAs(member)).items[0]!.presentation!.iconUrl).toContain(sha256(icon));
  });

  it("requires the owner runtime and valid identifiers to upload artwork, and rejects malformed publications", async () => {
    const icon = png(11);
    expect((await routes.request(`/internal/collaboration/shared-apps/${scopeId}/artwork/${sha256(icon)}`, {
      method: "PUT", headers: { "content-type": "image/png" }, body: icon,
    })).status).toBe(401);
    expect((await upload(icon, "not-a-digest")).status).toBe(422);
    expect((await routes.request(`/internal/collaboration/shared-apps/${scopeId}/presentation`, {
      method: "PUT", headers: { ...runtimeHeaders(), "content-type": "application/json" }, body: "{not json",
    })).status).toBe(422);
    // An empty listing with presentation requested stays an exact empty page.
    expect(await listAs(platformCollaborationActors.outsider)).toEqual({ items: [] });
  });

  it("limits artwork reads per member", async () => {
    await publishArtwork(png(12));
    const iconUrl = (await listAs(member)).items[0]!.presentation!.iconUrl!;
    let status = 200;
    for (let attempt = 0; attempt < 601 && status !== 429; attempt += 1) {
      status = (await routes.request(iconUrl, { headers: { "x-test-actor": member, "if-none-match": `"${sha256(png(12))}"` } })).status;
    }
    expect(status).toBe(429);
  });

  it("answers storage failures with a generic error and no internal detail", async () => {
    await publishArtwork(png(13));
    const iconUrl = (await listAs(member)).items[0]!.presentation!.iconUrl!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await fixture.collaborationDb.destroy();
    const responses = [
      await publish({ appId: app.appId, name: "Sprint Board", artwork: null }),
      await upload(png(14)),
      await routes.request(iconUrl, { headers: { "x-test-actor": member } }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Collaboration unavailable" });
    }
    expect(warn).toHaveBeenCalled();
    fixture = await createPlatformCollaborationTestDatabase();
  });
});
