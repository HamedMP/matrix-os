import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { build as viteBuild } from "vite";
import { AppManifestSchema } from "../../packages/gateway/src/app-runtime/manifest-schema.js";
import { ImmutableCollaborativeBuildStore } from "../../packages/gateway/src/app-runtime/build-cache.js";
import { createCollaborativeAppBuildIdentity } from "../../packages/gateway/src/collaboration/collaborative-app-identity.js";
import { canonicalJson } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { CollaborativeAppBuildBehaviorProbe, CollaborativeAppCapabilityVerifier } from "../../packages/gateway/src/collaboration/collaborative-app-readiness.js";
import { schemaDigest, updateSchemaDigest } from "../../skills/matrix/collaborative-app-builder/scripts/schema-digest.mjs";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { createAppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine } from "../../packages/gateway/src/app-db-query.js";

const example = resolve("skills/matrix/collaborative-app-builder/assets/team-tracker");

describe("collaborative builder's production artifacts", () => {
  it("provisions the example's real schema and retains owner rows when adding collaboration", async () => {
    const instance = await createTestPGlite();
    const { db, kysely } = createAppDb({ dialect: instance.dialect });
    try {
      await db.bootstrap();
      const raw = JSON.parse(await readFile(join(example, "matrix.json"), "utf8"));
      const registry = createAppRegistry(db, kysely);
      await registry.register({ slug: raw.slug, name: raw.name, tables: raw.storage.tables });
      const query = createQueryEngine(db);
      const saved = await query.insert(raw.slug, "tasks", { title: "Pre-share owner task", done: false });
      const before = await query.find(raw.slug, "tasks");
      // Conversion only adds manifest capability fields; normal registration
      // with the same schema must keep the existing owner data and identity.
      await registry.register({ slug: raw.slug, name: raw.name, version: raw.version, tables: raw.storage.tables });
      const registration = await registry.get(raw.slug);
      expect(registration!.tables).toEqual(raw.storage.tables);
      expect(schemaDigest(registration!.tables)).toBe(raw.collaboration.compatibility.schemaDigest);
      expect(await query.find(raw.slug, "tasks")).toEqual(before);
      await query.update(raw.slug, "tasks", saved.id, { done: true });
      expect(await query.findOne(raw.slug, "tasks", saved.id)).toMatchObject({ title: "Pre-share owner task", done: true });
    } finally { await db.destroy(); }
  });

  it("matches the gateway's canonical schema digest and updates only compatibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-builder-digest-"));
    try {
      const tables = { tasks: { columns: { title: { type: "text" }, done: { type: "boolean" } }, indexes: ["title", "done"] } };
      const original = { slug: "existing-app", storage: { tables }, collaboration: { compatibility: { runtimeAbi: "matrix-runtime-v1", schemaDigest: "stale" } } };
      const path = join(root, "matrix.json");
      const bytes = JSON.stringify(original);
      await writeFile(path, bytes);
      const expected = createHash("sha256").update(canonicalJson(tables)).digest("hex");
      expect(await updateSchemaDigest(root)).toBe(expected);
      expect(await readFile(path, "utf8")).toBe(bytes);
      await updateSchemaDigest(root, true);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...original, collaboration: { compatibility: { ...original.collaboration.compatibility, schemaDigest: expected } } });
      expect(schemaDigest({ tasks: { indexes: ["title", "done"], columns: { done: { type: "boolean" }, title: { type: "text" } } } })).toBe(expected);
      expect(schemaDigest({ tasks: { ...tables.tasks, indexes: ["done", "title"] } })).not.toBe(expected);
      await rm(path);
      const target = join(root, "target.json"); await writeFile(target, bytes); await symlink(target, path);
      await expect(updateSchemaDigest(root, true)).rejects.toThrow("regular manifest");
      expect(await readFile(target, "utf8")).toBe(bytes);
      expect(() => schemaDigest({})).toThrow("storage.tables");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("builds the shipped React app and passes the actual immutable-build readiness verifier", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "matrix-builder-build-")));
    const app = join(root, "app");
    const store = new ImmutableCollaborativeBuildStore({ rootDir: join(root, "store"), maxSnapshots: 2,
      retentionMs: 60_000, cleanupIntervalMs: 60_000, startTimer: false });
    try {
      await cp(example, app, { recursive: true });
      await symlink(resolve("node_modules"), join(app, "node_modules"), "dir");
      execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--project", app, "--noEmit"], { stdio: "pipe" });
      await viteBuild({ root: app, configFile: join(app, "vite.config.ts"), logLevel: "silent" });
      const preflight = execFileSync(process.execPath, [resolve("skills/matrix/app-builder/scripts/verify-app.mjs"), app], { encoding: "utf8" });
      expect(preflight).toContain("Manifest and build verified: /apps/team-tracker/");
      const raw = JSON.parse(await readFile(join(app, "matrix.json"), "utf8"));
      const manifest = AppManifestSchema.parse(raw);
      expect(manifest.collaboration!.compatibility.schemaDigest).toBe(schemaDigest(raw.storage.tables));
      const identity = (assetDigest: string) => createCollaborativeAppBuildIdentity({
        appId: manifest.slug, catalogId: "30000000-0000-4000-8000-000000000001",
        registrationIncarnation: "a".repeat(64), manifestVersion: manifest.version,
        manifest: JSON.parse(JSON.stringify(manifest)), declaredSchema: raw.storage.tables, assetDigest,
        bridgeContractVersion: manifest.collaboration!.compatibility.bridgeContractVersion,
        runtimeAbi: manifest.collaboration!.compatibility.runtimeAbi,
      });
      const snapshot = await store.captureIdentified({ buildRoot: join(app, "dist"), buildIdForAssetDigest: (digest) => identity(digest).buildId });
      const build = identity(snapshot.assetDigest);
      const results = await new CollaborativeAppCapabilityVerifier(new CollaborativeAppBuildBehaviorProbe(store)).verify({
        ownerId: "user_owner", organizationId: "org_team", build,
        artifactRef: `objects/${build.buildId}`, declaration: manifest.collaboration!,
      }, AbortSignal.timeout(30_000));
      expect(results).toEqual(expect.arrayContaining([
        { code: "owner_postgres", status: "passed" }, { code: "conflict_write", status: "passed" }, { code: "change_signal", status: "passed" },
      ]));
      expect(results.every((gate) => gate.status === "passed")).toBe(true);
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
