import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImmutableCollaborativeBuildStore } from "../../packages/gateway/src/app-runtime/build-cache.js";
import {
  CollaborativeAppBuildResolutionError,
  CollaborativeAppBuildResolver,
} from "../../packages/gateway/src/collaboration/collaborative-app-build-resolver.js";
import { appRegistryIncarnation } from "../../packages/gateway/src/collaboration/app-incarnation.js";
import { canonicalJson } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import {
  CollaborativeAppBuildBehaviorProbe,
  CollaborativeAppCapabilityVerifier,
  CollaborativeAppReadinessEvaluator,
} from "../../packages/gateway/src/collaboration/collaborative-app-readiness.js";

describe("collaborative app production build resolution", () => {
  let root: string;
  let appDir: string;
  let store: ImmutableCollaborativeBuildStore;
  const catalogId = "50000000-0000-4000-8000-000000000001";
  const createdAt = "2026-11-05T10:00:00.000Z";
  const registration = () => ({
    slug: "team-tracker",
    name: "Team Tracker",
    version: "1.0.0",
    installed_version: "1.0.0",
    description: null,
    author: null,
    category: null,
    tables: { tasks: { columns: { title: { type: "text" } } } },
    created_at: createdAt,
    updated_at: createdAt,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "collaborative-app-production-"));
    appDir = join(root, "apps", "team-tracker");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "input.txt"), "exact bytes");
    await writeFile(join(appDir, "build.mjs"), [
      "import {mkdir,readFile,writeFile} from 'node:fs/promises';",
      "await mkdir('dist',{recursive:true});",
      "const input=await readFile('input.txt','utf8');",
      "await writeFile('dist/index.html',`<main>${input}</main><script>const shared=window.MatrixOS.collaboration;const {query:readShared,mutate,onChange}=shared;readShared({action:'appInfo'});mutate({action:'update'},'0');onChange(()=>readShared({action:'appInfo'}));</script>`);",
    ].join(""));
    await writeFile(join(appDir, "matrix.json"), JSON.stringify({
      name: "Team Tracker",
      slug: "team-tracker",
      version: "1.0.0",
      runtime: "vite",
      runtimeVersion: "1.0.0",
      build: {
        install: "node -e \"process.exit(0)\"",
        command: "node build.mjs",
        output: "dist",
        sourceGlobs: ["input.txt", "matrix.json"],
      },
      collaboration: {
        capability: {
          version: 1,
          storage: "owner_postgres",
          audience: "current_organization_members",
          participantIdentity: "authenticated_actor",
          mutations: "transactional_revisioned",
          updates: "content_free_signal",
          providerPolicy: "existing_authority",
        },
        compatibility: {
          bridgeContractVersion: "matrix-app-bridge-v1",
          runtimeAbi: "matrix-runtime-v1",
          schemaDigest: createHash("sha256").update(canonicalJson(registration().tables)).digest("hex"),
        },
      },
    }));
    store = new ImmutableCollaborativeBuildStore({
      rootDir: join(root, "store"),
      maxSnapshots: 10,
      retentionMs: 60_000,
      cleanupIntervalMs: 60_000,
      startTimer: false,
    });
  });

  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("resolves registry, manifest, declared schema, catalog identity, and exact built bytes", async () => {
    const readiness = { invalidateDriftedBuilds: vi.fn(async () => 0) };
    const catalog = {
      getLiveByPath: vi.fn(async () => null),
      register: vi.fn(async (input) => ({ ...input, id: catalogId, parentId: null, revision: 0, updatedAt: createdAt, deletedAt: null })),
    };
    const resolver = new CollaborativeAppBuildResolver({
      homePath: root,
      ownerId: "user_owner",
      appRegistry: {
        get: async () => registration(),
      } as never,
      catalog: catalog as never,
      readiness,
      store,
    });
    await expect(resolver.registrationIncarnation("user_owner", "team-tracker"))
      .resolves.toBe(appRegistryIncarnation(registration()));
    expect(catalog.register).not.toHaveBeenCalled();
    const resolved = await resolver.resolve("user_owner", "team-tracker", { ensureCatalog: true });
    expect(resolved?.build).toMatchObject({
      appId: "team-tracker",
      catalogId,
      manifestVersion: "1.0.0",
      bridgeContractVersion: "matrix-app-bridge-v1",
      runtimeAbi: "matrix-runtime-v1",
    });
    expect(resolved?.artifactRef).toBe(`objects/${resolved?.build.buildId}`);
    expect(resolved?.build.assetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved?.build.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.resolve(resolved!.build.buildId)).toMatchObject({
      buildId: resolved!.build.buildId,
      assetDigest: resolved!.build.assetDigest,
    });
    expect(catalog.register).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: "user_owner",
      projectId: null,
      kind: "app",
      path: "team-tracker",
    }));
    expect(readiness.invalidateDriftedBuilds).toHaveBeenCalledWith({
      ownerId: "user_owner",
      catalogId,
      currentBuildId: resolved?.build.buildId,
    });

    const checking = {
      id: "60000000-0000-4000-8000-000000000001",
      ownerId: "user_owner",
      build: resolved!.build,
      artifactRef: resolved!.artifactRef,
      status: "checking" as const,
      gateResults: [],
      verifiedAt: null,
      invalidatedAt: null,
      invalidationReason: null,
      verifierVersion: "collaborative-app-v1",
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const readinessResult = await new CollaborativeAppReadinessEvaluator({
      repository: {
        createOrGet: async () => checking,
        transition: async (input) => ({ ...checking, status: input.status, gateResults: input.gateResults, revision: 2 }),
        get: async () => null,
      } as never,
      verifier: new CollaborativeAppCapabilityVerifier(new CollaborativeAppBuildBehaviorProbe(store)),
    }).check({
      ownerId: "user_owner",
      organizationId: "org_matrix_team",
      build: resolved!.build,
      artifactRef: resolved!.artifactRef,
      declaration: resolved!.declaration ?? null,
    });
    expect(readinessResult).toMatchObject({ status: "ready" });
  });

  it("blocks a declared exact build that never uses shared reads, writes, or change signals", async () => {
    await writeFile(join(appDir, "build.mjs"), [
      "import {mkdir,writeFile} from 'node:fs/promises';",
      "await mkdir('dist',{recursive:true});",
      "await writeFile('dist/index.html',`<script>localStorage.setItem('task','browser only')</script>`);",
    ].join(""));
    const resolver = new CollaborativeAppBuildResolver({
      homePath: root,
      ownerId: "user_owner",
      appRegistry: { get: async () => registration() } as never,
      catalog: {
        getLiveByPath: async () => null,
        register: async (candidate) => ({ ...candidate, id: catalogId, parentId: null, revision: 0, updatedAt: createdAt, deletedAt: null }),
      } as never,
      readiness: { invalidateDriftedBuilds: async () => 0 },
      store,
    });
    const resolved = await resolver.resolve("user_owner", "team-tracker", { ensureCatalog: true });
    const checking = {
      id: "60000000-0000-4000-8000-000000000001", ownerId: "user_owner", build: resolved!.build,
      artifactRef: resolved!.artifactRef, status: "checking" as const, gateResults: [], verifiedAt: null,
      invalidatedAt: null, invalidationReason: null, verifierVersion: "collaborative-app-v1", revision: 1,
      createdAt, updatedAt: createdAt,
    };

    const result = await new CollaborativeAppReadinessEvaluator({
      repository: {
        createOrGet: async () => checking,
        transition: async (candidate) => ({ ...checking, status: candidate.status, gateResults: candidate.gateResults, revision: 2 }),
        get: async () => null,
      } as never,
      verifier: new CollaborativeAppCapabilityVerifier(new CollaborativeAppBuildBehaviorProbe(store)),
    }).check({
      ownerId: "user_owner", organizationId: "org_matrix_team", build: resolved!.build,
      artifactRef: resolved!.artifactRef, declaration: resolved!.declaration ?? null,
    });

    expect(result.status).toBe("blocked");
    expect(result.gateResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "owner_postgres", status: "blocked" }),
      expect.objectContaining({ code: "conflict_write", status: "blocked" }),
      expect.objectContaining({ code: "change_signal", status: "blocked" }),
    ]));
  });

  it.each([
    "<main>Static app</main><!-- window.MatrixOS.collaboration.query({action:'appInfo'});window.MatrixOS.collaboration.mutate({action:'update'},'0');window.MatrixOS.collaboration.onChange(()=>{}); -->",
    "<script>// window.MatrixOS.collaboration.query({});window.MatrixOS.collaboration.mutate({},'0');window.MatrixOS.collaboration.onChange(()=>{});</script>",
    "<script>const sample = 'window.MatrixOS.collaboration.query({});window.MatrixOS.collaboration.mutate({},0);window.MatrixOS.collaboration.onChange(()=>{});';</script>",
    "<script type=\"application/json\">window.MatrixOS.collaboration.query({});window.MatrixOS.collaboration.mutate({},0);window.MatrixOS.collaboration.onChange(()=>{});</script>",
    "<script>/* window.MatrixOS.collaboration.query({});window.MatrixOS.collaboration.mutate({},0);window.MatrixOS.collaboration.onChange(()=>{}); */</script>",
  ])("rejects collaboration calls present only in non-executable text: %s", async (html) => {
    await writeFile(join(appDir, "build.mjs"), [
      "import {mkdir,writeFile} from 'node:fs/promises';",
      "await mkdir('dist',{recursive:true});",
      `await writeFile('dist/index.html',${JSON.stringify(html)});`,
    ].join(""));
    const resolver = new CollaborativeAppBuildResolver({
      homePath: root, ownerId: "user_owner",
      appRegistry: { get: async () => registration() } as never,
      catalog: {
        getLiveByPath: async () => null,
        register: async (candidate) => ({ ...candidate, id: catalogId, parentId: null, revision: 0, updatedAt: createdAt, deletedAt: null }),
      } as never,
      readiness: { invalidateDriftedBuilds: async () => 0 }, store,
    });
    const resolved = await resolver.resolve("user_owner", "team-tracker", { ensureCatalog: true });
    const behavior = await new CollaborativeAppBuildBehaviorProbe(store).inspect({
      ownerId: "user_owner", organizationId: "org_matrix_team", build: resolved!.build,
      artifactRef: resolved!.artifactRef, declaration: resolved!.declaration ?? null,
    }, AbortSignal.timeout(10_000));
    expect(behavior).toEqual({ sharedRead: false, revisionedWrite: false, changeSignal: false });
  });

  it("fails closed for a foreign owner, missing registration, or read without a catalog identity", async () => {
    const resolver = new CollaborativeAppBuildResolver({
      homePath: root,
      ownerId: "user_owner",
      appRegistry: { get: async () => null } as never,
      catalog: { getLiveByPath: async () => null } as never,
      readiness: { invalidateDriftedBuilds: async () => 0 },
      store,
    });
    expect(await resolver.resolve("user_other", "team-tracker", { ensureCatalog: true })).toBeNull();
    expect(await resolver.resolve("user_owner", "team-tracker", { ensureCatalog: true })).toBeNull();
    expect(await new CollaborativeAppBuildResolver({
      homePath: root,
      ownerId: "user_owner",
      appRegistry: { get: async () => ({ slug: "team-tracker", created_at: createdAt, tables: {} }) } as never,
      catalog: { getLiveByPath: async () => null } as never,
      readiness: { invalidateDriftedBuilds: async () => 0 },
      store,
    }).resolve("user_owner", "team-tracker", { ensureCatalog: false })).toBeNull();
    expect(await new CollaborativeAppBuildResolver({
      homePath: root,
      ownerId: "user_owner",
      appRegistry: { get: async () => ({ ...registration(), slug: "other-app" }) } as never,
      catalog: { getLiveByPath: async () => null } as never,
      readiness: { invalidateDriftedBuilds: async () => 0 },
      store,
    }).resolve("user_owner", "team-tracker", { ensureCatalog: true })).toBeNull();
  });

  it("fails closed for replaced registration, missing source, missing build declaration, and build failures", async () => {
    const registered = registration();
    const liveCatalog = {
      id: catalogId,
      ownerId: "user_owner",
      projectId: null,
      kind: "app" as const,
      path: "team-tracker",
      parentId: null,
      incarnation: appRegistryIncarnation(registered as never),
      revision: 0,
      updatedAt: createdAt,
      deletedAt: null,
    };
    const base = {
      homePath: root,
      ownerId: "user_owner",
      appRegistry: { get: async () => registered } as never,
      readiness: { invalidateDriftedBuilds: async () => 0 },
      store,
    };
    expect(await new CollaborativeAppBuildResolver({
      ...base,
      catalog: { getLiveByPath: async () => ({ ...liveCatalog, incarnation: "f".repeat(64) }) } as never,
    }).resolve("user_owner", "team-tracker", { ensureCatalog: false })).toBeNull();
    expect(await new CollaborativeAppBuildResolver({
      ...base,
      homePath: join(root, "missing-home"),
      catalog: { getLiveByPath: async () => liveCatalog } as never,
    }).resolve("user_owner", "team-tracker", { ensureCatalog: false })).toBeNull();

    const manifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(appDir, "matrix.json"), "utf8")));
    delete manifest.build;
    await writeFile(join(appDir, "matrix.json"), JSON.stringify(manifest));
    expect(await new CollaborativeAppBuildResolver({
      ...base,
      catalog: { getLiveByPath: async () => liveCatalog } as never,
    }).resolve("user_owner", "team-tracker", { ensureCatalog: false })).toBeNull();

    manifest.build = {
      install: "node -e \"process.exit(0)\"",
      command: "node build.mjs",
      output: "dist",
      sourceGlobs: ["input.txt", "matrix.json"],
    };
    await writeFile(join(appDir, "matrix.json"), JSON.stringify(manifest));
    const currentManifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(appDir, "matrix.json"), "utf8")));
    for (const snapshot of [
      { ok: false as const, error: "build_failed" },
      { ok: true as const, snapshot: { assetDigest: "e".repeat(64), buildId: "f".repeat(64), manifest: currentManifest } },
    ]) {
      const resolver = new CollaborativeAppBuildResolver({
        ...base,
        catalog: { getLiveByPath: async () => liveCatalog } as never,
        build: { buildWithCollaborativeSnapshot: async () => snapshot } as never,
      });
      await expect(resolver.resolve("user_owner", "team-tracker", { ensureCatalog: false }))
        .rejects.toBeInstanceOf(CollaborativeAppBuildResolutionError);
    }
  });

  it("uses bounded undeclared compatibility sentinels for an otherwise buildable legacy manifest", async () => {
    const manifestPath = join(appDir, "matrix.json");
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.collaboration;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const registered = registration();
    const incarnation = appRegistryIncarnation(registered as never);
    const resolver = new CollaborativeAppBuildResolver({
      homePath: root,
      ownerId: "user_owner",
      appRegistry: { get: async () => registered } as never,
      catalog: { getLiveByPath: async () => ({
        id: catalogId,
        ownerId: "user_owner",
        projectId: null,
        kind: "app",
        path: "team-tracker",
        parentId: null,
        incarnation,
        revision: 0,
        updatedAt: createdAt,
        deletedAt: null,
      }) } as never,
      readiness: { invalidateDriftedBuilds: async () => 0 },
      store,
    });
    expect((await resolver.resolve("user_owner", "team-tracker", { ensureCatalog: false }))?.build)
      .toMatchObject({ bridgeContractVersion: "undeclared", runtimeAbi: "undeclared" });
  });

  it("derives exact identity from the manifest captured under the build lock", async () => {
    const registered = registration();
    const incarnation = appRegistryIncarnation(registered as never);
    const lockedManifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(appDir, "matrix.json"), "utf8")));
    lockedManifest.version = "2.0.0";
    lockedManifest.collaboration.compatibility.bridgeContractVersion = "matrix-app-bridge-v2";
    const assetDigest = "f".repeat(64);
    const resolver = new CollaborativeAppBuildResolver({
      homePath: root,
      ownerId: "user_owner",
      appRegistry: { get: async () => registered } as never,
      catalog: { getLiveByPath: async () => ({
        id: catalogId, ownerId: "user_owner", projectId: null, kind: "app", path: "team-tracker",
        parentId: null, incarnation, revision: 0, updatedAt: createdAt, deletedAt: null,
      }) } as never,
      readiness: { invalidateDriftedBuilds: async () => 0 },
      store,
      build: {
        buildWithCollaborativeSnapshot: async (_slug: string, _dir: string, options: {
          buildIdForAssetDigest: (assetDigest: string, manifest: unknown) => string;
        }) => ({
          ok: true,
          snapshot: {
            assetDigest,
            buildId: options.buildIdForAssetDigest(assetDigest, lockedManifest),
            artifactPath: join(root, "captured"),
            createdAt: 1,
            manifest: lockedManifest,
          },
        }),
      } as never,
    });

    await expect(resolver.resolve("user_owner", "team-tracker", { ensureCatalog: false }))
      .resolves.toMatchObject({ build: {
        manifestVersion: "2.0.0",
        bridgeContractVersion: "matrix-app-bridge-v2",
        assetDigest,
      } });
  });

  it("orders drift invalidation with build capture so an older request cannot stale a newer build", async () => {
    const firstWrite = Promise.withResolvers<void>();
    const firstWriteEntered = Promise.withResolvers<void>();
    const readiness = { invalidateDriftedBuilds: vi.fn(async () => {
      if (readiness.invalidateDriftedBuilds.mock.calls.length === 1) {
        firstWriteEntered.resolve();
        await firstWrite.promise;
      }
      return 0;
    }) };
    const registered = registration();
    const resolver = new CollaborativeAppBuildResolver({
      homePath: root,
      ownerId: "user_owner",
      appRegistry: { get: async () => registered } as never,
      catalog: { getLiveByPath: async () => ({
        id: catalogId, ownerId: "user_owner", projectId: null, kind: "app", path: "team-tracker",
        parentId: null, incarnation: appRegistryIncarnation(registered as never), revision: 0,
        updatedAt: createdAt, deletedAt: null,
      }) } as never,
      readiness,
      store,
    });
    const first = resolver.resolve("user_owner", "team-tracker", { ensureCatalog: false });
    await firstWriteEntered.promise;
    await writeFile(join(appDir, "input.txt"), "new exact bytes");
    const second = resolver.resolve("user_owner", "team-tracker", { ensureCatalog: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(readiness.invalidateDriftedBuilds).toHaveBeenCalledTimes(1);
    } finally {
      firstWrite.resolve();
      await Promise.allSettled([first, second]);
    }
    const [older, newer] = await Promise.all([first, second]);
    expect(older?.build.buildId).not.toBe(newer?.build.buildId);
    expect(readiness.invalidateDriftedBuilds).toHaveBeenCalledTimes(2);
  });
});
