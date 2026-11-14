import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborativeAppDirectoryResponseSchema } from "@matrix-os/contracts";
import { invalidateAppIndexCache } from "../../packages/gateway/src/app-runtime/app-index.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createOwnerAppPresentationSource } from "../../packages/gateway/src/collaboration/app-presentation-source.js";
import { CollaborativeAppPresentationPublisher } from "../../packages/gateway/src/collaboration/app-presentation-publisher.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborativeAppReadinessRepository } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-repository.js";
import { CollaborativeAppShareRepository } from "../../packages/gateway/src/collaboration/collaborative-app-share-repository.js";
import { CollaborationDirectoryOutbox } from "../../packages/gateway/src/collaboration/directory-outbox.js";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  type PlatformCollaborationTestDatabase,
} from "../platform/collaboration-test-support.js";
import { createCollaborativeAppInfrastructure } from "../../packages/gateway/src/startup/collaboration.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const ownerId = "user_owner";
const member = "user_member";
const organizationId = "org_matrix_team";
const runtimeId = "runtime_owner";
const serviceToken = "s".repeat(48);
const catalogId = "50000000-0000-4000-8000-000000000001";
const readinessId = "60000000-0000-4000-8000-000000000001";
const scopeId = "70000000-0000-4000-8000-000000000001";
const now = new Date("2026-11-05T10:00:00.000Z");
const build = {
  appId: "team-tracker",
  catalogId,
  registrationIncarnation: "a".repeat(64),
  manifestVersion: "1.0.0",
  buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1",
  runtimeAbi: "matrix-runtime-v1",
};

function png(fill: number): Uint8Array {
  const bytes = new Uint8Array(256).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("owner app presentation reaches the recipient launcher", () => {
  let owner: CollaborationTestDatabase;
  let platform: PlatformCollaborationTestDatabase;
  let routes: Hono;
  let home: string;
  let shares: CollaborativeAppShareRepository;
  let outbox: CollaborationDirectoryOutbox;
  let publisher: CollaborativeAppPresentationPublisher;
  let currentTime: number;
  const platformFetch = vi.fn<typeof fetch>();

  /** One owner share of an exact, ready build, created through the production repositories. */
  async function shareApp(input: { appId: string; catalogId: string; readinessId: string; scopeId: string; sequence: number }) {
    const digit = String(input.sequence);
    const appBuild = { ...build, appId: input.appId, catalogId: input.catalogId, buildId: digit.repeat(64), registrationIncarnation: `a${digit}`.repeat(32) };
    await new CollaborationResourceCatalog(owner.db, { now: () => now, createId: () => input.catalogId }).register({
      ownerId, projectId: null, kind: "app", path: input.appId, incarnation: appBuild.registrationIncarnation,
    });
    const readiness = new CollaborativeAppReadinessRepository(owner.db, { now: () => now, createId: () => input.readinessId });
    await readiness.createOrGet({ ownerId, build: appBuild, artifactRef: `objects/${appBuild.buildId}`, verifierVersion: "v1" });
    await readiness.transition({
      id: input.readinessId, ownerId, expectedRevision: 1, status: "ready",
      gateResults: [{ code: "cleanup", status: "passed" }], verifiedAt: now,
    });
    const repository = new CollaborativeAppShareRepository(owner.db, { now: () => now, createId: () => input.scopeId });
    await repository.createAtomic({
      ownerId, organizationId, catalogId: input.catalogId, readinessId: input.readinessId,
      expectedResourceRevision: 0, expectedReadinessRevision: 2, expectedBuildId: appBuild.buildId, expectedBinding: null,
      clientRequestId: `80000000-0000-4000-8000-${digit.padStart(12, "0")}`, payloadHash: "f".repeat(64), runtimeId,
    });
    return repository;
  }

  async function writeApp(name: string, icon = "sprint-board", appId = build.appId) {
    await mkdir(join(home, "apps", appId), { recursive: true });
    await writeFile(join(home, "apps", appId, "index.html"), "<html></html>");
    await writeFile(join(home, "apps", appId, "matrix.json"), JSON.stringify({
      name, slug: appId, icon, version: "1.0.0", runtimeVersion: "^24.0.0", runtime: "static",
    }));
    // Owner manifest writes invalidate the catalog index the same way.
    invalidateAppIndexCache();
  }

  async function writeIcon(bytes: Uint8Array | string, file = "sprint-board.png", mtimeSeconds = 1_700_000_000) {
    await mkdir(join(home, "system/icons"), { recursive: true });
    await writeFile(join(home, "system/icons", file), bytes);
    await utimes(join(home, "system/icons", file), mtimeSeconds, mtimeSeconds);
  }

  async function launcher() {
    const response = await routes.request("/api/collaboration/shared-apps?limit=10&presentation=1", { headers: { "x-test-actor": member } });
    expect(response.status).toBe(200);
    return CollaborativeAppDirectoryResponseSchema.parse(await response.json()).items;
  }

  async function artwork(iconUrl: string) {
    return routes.request(iconUrl, { headers: { "x-test-actor": member } });
  }

  beforeEach(async () => {
    currentTime = now.getTime();
    home = await mkdtemp(join(tmpdir(), "shared-app-presentation-"));
    owner = await createCollaborationTestDatabase();
    await new ChatRepository(owner.db).bootstrap();
    await bootstrapCollaborationDatabase(owner.db);
    shares = await shareApp({ appId: build.appId, catalogId, readinessId, scopeId, sequence: 1 });

    platform = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(platform.collaborationDb);
    routes = new Hono();
    routes.route("/", createPlatformCollaborationRoutes({
      repository: new PlatformCollaborationRepository(platform.collaborationDb, { now: () => now }),
      resolveActor: async (context) => context.req.header("x-test-actor") ?? null,
      authenticateRuntime: async (input) => input.runtimeId === runtimeId && input.bearerToken === serviceToken
        ? { runtimeId, ownerId } : null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId === ownerId ? "Owner" : "Member" }),
      resolveInvitationIdentifier: async () => null,
      listOrganizationIds: async () => [organizationId],
      isCurrentOrganizationMember: async ({ actorId }) => actorId === member,
      now: () => now,
    }));
    platformFetch.mockReset();
    platformFetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://platform.matrix.test");
      return routes.request(`${url.pathname}${url.search}`, init);
    });
    const connection = { db: owner.db, platformBaseUrl: "https://platform.matrix.test", runtimeId, serviceToken, fetchImpl: platformFetch };
    outbox = new CollaborationDirectoryOutbox({ ...connection, now: () => now, startTimer: false });
    publisher = new CollaborativeAppPresentationPublisher({
      ...connection,
      ownerId,
      source: createOwnerAppPresentationSource(home),
      now: () => new Date(currentTime),
      startTimer: false,
    });
    expect(await outbox.runOnce()).toBe(1);
  });

  afterEach(async () => {
    await publisher.shutdown();
    await outbox.shutdown();
    await destroyPlatformCollaborationTestDatabase(platform);
    await owner.destroy();
    await rm(home, { recursive: true, force: true });
  });

  it("shows the owner's display name and custom icon, and re-publishes nothing when unchanged", async () => {
    const icon = png(7);
    await writeApp("Sprint Board");
    await writeIcon(icon);

    expect(await publisher.runOnce()).toBe(1);
    const [item] = await launcher();
    expect(item?.presentation).toEqual({
      name: "Sprint Board",
      iconUrl: `/api/collaboration/shared-apps/${scopeId}/artwork/${sha256(icon)}`,
    });
    const served = await artwork(item!.presentation!.iconUrl!);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(icon);
    // No owner path or runtime credential travels to recipients.
    const listing = JSON.stringify(await launcher());
    expect(listing).not.toContain(home);
    expect(listing).not.toContain(serviceToken);

    platformFetch.mockClear();
    expect(await publisher.runOnce()).toBe(0);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("publishes the owner's inert SVG icon, as Shared Tasks Lab uses", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="tile"><stop stop-color="#5476bd"/></linearGradient></defs><rect width="110" height="110" rx="27" fill="url(#tile)"/></svg>';
    await writeApp("Shared Tasks Lab", "shared-tasks-lab");
    await writeIcon(svg, "shared-tasks-lab.svg");
    expect(await publisher.runOnce()).toBe(1);
    const presentation = (await launcher())[0]!.presentation!;
    const bytes = new TextEncoder().encode(svg);
    expect(presentation).toEqual({
      name: "Shared Tasks Lab",
      iconUrl: `/api/collaboration/shared-apps/${scopeId}/artwork/${sha256(bytes)}`,
    });
    const served = await artwork(presentation.iconUrl!);
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  });

  it("follows owner renames and icon changes, retiring the previous artwork URL", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(1));
    await publisher.runOnce();
    const oldUrl = (await launcher())[0]!.presentation!.iconUrl!;

    const replacement = png(2);
    await writeApp("Team Sprint Board");
    await writeIcon(replacement, "sprint-board.png", 1_700_000_100);
    expect(await publisher.runOnce()).toBe(1);
    const updated = (await launcher())[0]!.presentation!;
    expect(updated.name).toBe("Team Sprint Board");
    expect(updated.iconUrl).toBe(`/api/collaboration/shared-apps/${scopeId}/artwork/${sha256(replacement)}`);
    expect((await artwork(oldUrl)).status).toBe(404);
    expect(new Uint8Array(await (await artwork(updated.iconUrl!)).arrayBuffer())).toEqual(replacement);
  });

  it("publishes the name without artwork when the icon is missing, a symlink, unsupported, or a bundled fallback", async () => {
    await writeApp("Sprint Board");
    await publisher.runOnce();
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board" });

    const outside = join(home, "private-owner-file.png");
    await writeFile(outside, png(3));
    await mkdir(join(home, "system/icons"), { recursive: true });
    await symlink(outside, join(home, "system/icons", "sprint-board.png"));
    await writeApp("Sprint Board 2");
    await publisher.runOnce();
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board 2" });

    await rm(join(home, "system/icons", "sprint-board.png"));
    await writeIcon("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    await writeApp("Sprint Board 3");
    await publisher.runOnce();
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board 3" });

    // The catalog falls back to shipped game artwork for an unknown stem; that is not the owner's icon.
    await rm(join(home, "system/icons", "sprint-board.png"));
    await writeIcon(png(4), "game-center.png");
    await writeApp("Sprint Board 4");
    await publisher.runOnce();
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board 4" });
  });

  it("removes the artwork for members once the owner stops sharing", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(5));
    await publisher.runOnce();
    const iconUrl = (await launcher())[0]!.presentation!.iconUrl!;

    await shares.stopAtomic({
      scopeId, ownerId, expectedScopeRevision: 1, expectedBindingRevision: 1,
      clientRequestId: "80000000-0000-4000-8000-000000000002", payloadHash: "9".repeat(64),
    });
    expect(await outbox.runOnce()).toBe(1);
    expect(await launcher()).toEqual([]);
    expect((await artwork(iconUrl)).status).toBe(404);
    platformFetch.mockClear();
    expect(await publisher.runOnce()).toBe(0);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("republishes after the platform loses presentation, such as a recheck or restore", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(9));
    expect(await publisher.runOnce()).toBe(1);
    await platform.collaborationDb.deleteFrom("collaboration_app_presentations").execute();
    expect((await launcher())[0]).not.toHaveProperty("presentation");

    currentTime += 15 * 60_000;
    expect(await publisher.runOnce()).toBe(1);
    expect((await launcher())[0]!.presentation?.iconUrl).toContain(sha256(png(9)));
  });

  it("republishes when the share's binding changes even though name and artwork did not", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(10));
    expect(await publisher.runOnce()).toBe(1);
    await owner.db.updateTable("collaboration_app_bindings").set((eb) => ({ revision: eb("revision", "+", 1) }))
      .where("scope_id", "=", scopeId).execute();
    platformFetch.mockClear();
    expect(await publisher.runOnce()).toBe(1);
    expect(platformFetch).toHaveBeenCalledTimes(1);
  });

  it("backs off without disturbing directory delivery when the platform does not support presentation", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(6));
    platformFetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/presentation")) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
      return routes.request(`${url.pathname}${url.search}`, init);
    });
    expect(await publisher.runOnce()).toBe(0);
    platformFetch.mockClear();
    expect(await publisher.runOnce()).toBe(0);
    expect(platformFetch).not.toHaveBeenCalled();
    expect((await launcher())[0]).not.toHaveProperty("presentation");

    // Once the platform supports it, the retry after the backoff publishes normally.
    platformFetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      return routes.request(`${url.pathname}${url.search}`, init);
    });
    currentTime += 60_000;
    expect(await publisher.runOnce()).toBe(1);
    expect((await launcher())[0]!.presentation?.name).toBe("Sprint Board");
  });

  it("starts with owner collaboration infrastructure and stops with it", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(8));
    vi.stubGlobal("fetch", platformFetch);
    const storeRoot = await mkdtemp(join(tmpdir(), "shared-app-presentation-builds-"));
    try {
      const infrastructure = createCollaborativeAppInfrastructure({
        db: owner.db,
        buildStoreRoot: storeRoot,
        presentation: {
          homePath: home,
          ownerId,
          config: { runtimeId, platformBaseUrl: "https://platform.matrix.test", serviceToken, clientOrigins: [] },
        },
      });
      await vi.waitFor(async () => {
        expect((await launcher())[0]!.presentation?.name).toBe("Sprint Board");
      }, { timeout: 10_000 });
      await infrastructure.close();
    } finally {
      vi.unstubAllGlobals();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("retries instead of uploading when the icon changes after it was described", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(11));
    const replacement = png(12);
    platformFetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      // The owner saves a new icon while the presentation request is in flight.
      if (url.pathname.endsWith("/presentation") && !platformFetch.mock.calls.some(([seen]) => String(seen).includes("/artwork/"))) {
        await writeIcon(replacement, "sprint-board.png", 1_700_000_200);
      }
      return routes.request(`${url.pathname}${url.search}`, init);
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await publisher.runOnce()).toBe(0);
    expect(platformFetch.mock.calls.some(([input]) => String(input).includes("/artwork/"))).toBe(false);
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board" });

    currentTime += 60_000;
    expect(await publisher.runOnce()).toBe(1);
    expect((await launcher())[0]!.presentation?.iconUrl).toContain(sha256(replacement));
  });

  it.each([
    ["the platform is unreachable", async () => { throw new TypeError("fetch failed"); }],
    ["the platform answers with an unexpected body", async () => new Response(JSON.stringify({ ok: true }), { status: 200 })],
  ])("backs off when %s", async (_case, failure) => {
    await writeApp("Sprint Board");
    await writeIcon(png(13));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    platformFetch.mockImplementation(failure as typeof fetch);
    expect(await publisher.runOnce()).toBe(0);
    platformFetch.mockClear();
    expect(await publisher.runOnce()).toBe(0);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("retries when the platform rejects the artwork upload", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(14));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    platformFetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/artwork/")) return new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
      return routes.request(`${url.pathname}${url.search}`, init);
    });
    expect(await publisher.runOnce()).toBe(0);
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board" });
  });

  it("shares one cycle between concurrent callers and stops publishing after shutdown", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(15));
    const [first, second] = await Promise.all([publisher.runOnce(), publisher.runOnce()]);
    expect([first, second]).toEqual([1, 1]);
    await publisher.shutdown();
    await publisher.shutdown();
    platformFetch.mockClear();
    expect(await publisher.runOnce()).toBe(0);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("refuses an insecure platform origin or a missing runtime credential", () => {
    const base = { db: owner.db, ownerId, runtimeId, source: createOwnerAppPresentationSource(home), startTimer: false };
    expect(() => new CollaborativeAppPresentationPublisher({ ...base, platformBaseUrl: "http://platform.matrix.test", serviceToken }))
      .toThrow();
    expect(() => new CollaborativeAppPresentationPublisher({ ...base, platformBaseUrl: "https://platform.matrix.test", serviceToken: "short" }))
      .toThrow("Collaboration presentation service token is unavailable");
  });

  it("publishes nothing for a name that is not safe to show members", async () => {
    await writeApp("/home/owner/apps/team-tracker");
    expect(await publisher.runOnce()).toBe(0);
    expect((await launcher())[0]).not.toHaveProperty("presentation");
  });

  it("publishes no artwork for an oversized, unreadable, or non-file icon", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1);
    oversized.set(png(1).slice(0, 8));
    await writeApp("Sprint Board 1");
    await writeIcon(oversized);
    await publisher.runOnce();
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board 1" });

    await writeIcon(png(16), "sprint-board.png", 1_700_000_300);
    await chmod(join(home, "system/icons", "sprint-board.png"), 0o000);
    await writeApp("Sprint Board 2");
    await publisher.runOnce();
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board 2" });

    await rm(join(home, "system/icons", "sprint-board.png"), { force: true });
    await mkdir(join(home, "system/icons", "sprint-board.png"));
    await writeApp("Sprint Board 3");
    await publisher.runOnce();
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board 3" });
  });

  it("lets shutdown wait for an in-flight cycle", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(17));
    const pending = publisher.runOnce();
    await publisher.shutdown();
    expect(await pending).toBeLessThanOrEqual(1);
    platformFetch.mockClear();
    expect(await publisher.runOnce()).toBe(0);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("does not hang when a described icon is replaced by a named pipe before upload", async () => {
    await writeApp("Sprint Board");
    await writeIcon(png(21));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    platformFetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/presentation")) {
        const icon = join(home, "system/icons", "sprint-board.png");
        await rm(icon, { force: true });
        execFileSync("mkfifo", [icon]);
      }
      return routes.request(`${url.pathname}${url.search}`, init);
    });
    const outcome = await Promise.race([
      publisher.runOnce(),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
    ]);
    expect(outcome).toBe(0);
    expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board" });
    await publisher.shutdown();
  }, 15_000);

  it("never publishes artwork reached through a symlinked icons directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "shared-app-presentation-outside-"));
    try {
      await writeFile(join(outside, "sprint-board.png"), png(18));
      await mkdir(join(home, "system"), { recursive: true });
      await symlink(outside, join(home, "system", "icons"));
      await writeApp("Sprint Board");
      expect(await publisher.runOnce()).toBe(1);
      expect((await launcher())[0]!.presentation).toEqual({ name: "Sprint Board" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rotates through every active share when there are more than one page", async () => {
    await writeApp("Sprint Board");
    await writeApp("Retro Board", "retro-board", "retro-board");
    await writeIcon(png(19));
    await writeIcon(png(20), "retro-board.png");
    const secondScope = "70000000-0000-4000-8000-000000000002";
    await shareApp({
      appId: "retro-board", catalogId: "50000000-0000-4000-8000-000000000002",
      readinessId: "60000000-0000-4000-8000-000000000002", scopeId: secondScope, sequence: 2,
    });
    expect(await outbox.runOnce()).toBe(1);
    await publisher.shutdown();
    publisher = new CollaborativeAppPresentationPublisher({
      db: owner.db, platformBaseUrl: "https://platform.matrix.test", runtimeId, serviceToken, fetchImpl: platformFetch,
      ownerId, source: createOwnerAppPresentationSource(home), now: () => new Date(currentTime), startTimer: false, pageSize: 1,
    });
    expect(await publisher.runOnce()).toBe(1);
    expect(await publisher.runOnce()).toBe(1);
    const names = (await launcher()).map((item) => item.presentation?.name).sort();
    expect(names).toEqual(["Retro Board", "Sprint Board"]);
    // A later wrap-around keeps both published without re-sending unchanged snapshots.
    platformFetch.mockClear();
    for (let cycle = 0; cycle < 3; cycle += 1) await publisher.runOnce();
    expect(platformFetch).not.toHaveBeenCalled();
  });
});
