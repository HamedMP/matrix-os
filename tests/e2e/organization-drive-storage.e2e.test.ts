/**
 * The organization drive against real S3-compatible storage through the real
 * platform storage broker over HTTP, as a customer VPS uses it in production:
 * presigned upload, verification, immutable publication, versions and cleanup.
 * Runs only when MATRIX_TEST_S3_ENDPOINT points at S3-compatible storage (for
 * example MinIO with matrixos/matrixos123 credentials).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapOrganizationDriveDatabase, type OrganizationDriveDatabase } from "../../packages/gateway/src/organization-drive/database.js";
import { OrganizationDriveService } from "../../packages/gateway/src/organization-drive/service.js";
import { createPlatformR2Client } from "../../packages/gateway/src/sync/platform-r2-client.js";
import { createR2Client, type R2Client } from "../../packages/gateway/src/sync/r2-client.js";
import { insertContainer, type PlatformDB } from "../../packages/platform/src/db.js";
import { Hono } from "hono";
import { createInternalSyncRoutes } from "../../packages/platform/src/internal-sync-routes.js";
import { createR2Client as createPlatformStorageClient } from "../../packages/platform/src/r2-client.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../platform/platform-db-test-helper.js";

const endpoint = process.env.MATRIX_TEST_S3_ENDPOINT;
const secret = "platform-secret-organization-drive-e2e";
const handle = "ash";
const org = "org_example";
const scope = "00000000-0000-4000-8000-00000000d001";
const owner = "user_owner";
const member = "user_member";
const bucket = `orgdrive-${Date.now()}`;

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ids = { organizationId: org, scopeId: scope };

async function put(url: string, bytes: Uint8Array): Promise<Response> {
  return fetch(url, { method: "PUT", body: bytes, redirect: "error", signal: AbortSignal.timeout(30_000) });
}
async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  expect(response.ok).toBe(true);
  return new Uint8Array(await response.arrayBuffer());
}

describe.skipIf(!endpoint)("organization drive on real storage", () => {
  let platformDb: PlatformDB;
  let server: ReturnType<typeof serve>;
  let s3: S3Client;
  let direct: R2Client;
  let platformStorage: Awaited<ReturnType<typeof createPlatformStorageClient>>;
  let driveDb: Kysely<OrganizationDriveDatabase>;
  let service: OrganizationDriveService;
  let clock = new Date();

  beforeAll(async () => {
    s3 = new S3Client({ region: "auto", endpoint, forcePathStyle: true,
      credentials: { accessKeyId: "matrixos", secretAccessKey: "matrixos123" } });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    direct = await createR2Client({ accessKeyId: "matrixos", secretAccessKey: "matrixos123", bucket,
      endpoint, publicEndpoint: endpoint, forcePathStyle: true });
    // The platform broker uses its own storage client in production.
    platformStorage = await createPlatformStorageClient({ accessKeyId: "matrixos", secretAccessKey: "matrixos123",
      bucket, endpoint, publicEndpoint: endpoint, forcePathStyle: true });

    ({ db: platformDb } = await createTestPlatformDb());
    await insertContainer(platformDb, { handle, clerkUserId: owner, port: 5001, shellPort: 6001, status: "running" });
    // Same mount as packages/platform/src/main.ts.
    const app = new Hono().route("/internal/containers/:handle/sync", createInternalSyncRoutes({
      db: platformDb, r2: platformStorage, platformSecret: secret, r2PrefixRoot: "matrixos-sync" }));
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const brokered = createPlatformR2Client({ baseUrl: `http://127.0.0.1:${port}`, handle,
      token: createHmac("sha256", secret).update(handle).digest("hex") });

    const instance = await KyselyPGlite.create();
    driveDb = new Kysely<OrganizationDriveDatabase>({ dialect: instance.dialect });
    await bootstrapOrganizationDriveDatabase(driveDb);
    await sql`CREATE TABLE collaboration_scopes (id UUID PRIMARY KEY, resource_id TEXT NOT NULL,
      revision BIGINT NOT NULL, deleted_at TIMESTAMPTZ)`.execute(driveDb);
    await sql`CREATE TABLE collaboration_events (scope_id UUID NOT NULL, scope_seq BIGINT NOT NULL,
      event_id UUID NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, revision BIGINT NOT NULL,
      authority_generation BIGINT NOT NULL, event_type TEXT NOT NULL, payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (scope_id, scope_seq))`.execute(driveDb);
    await sql`INSERT INTO collaboration_scopes (id, resource_id, revision) VALUES (${scope}, 'folder-drive', 1)`.execute(driveDb);
    service = new OrganizationDriveService({ db: driveDb, r2: brokered, ownerId: owner, runtimeSlot: "primary",
      now: () => clock });
    await service.enable({ ...ids, runtimeId: "vps:owner", generation: 1 });
  }, 60_000);

  afterAll(async () => {
    await driveDb?.destroy();
    await new Promise((resolve) => server?.close(resolve));
    await destroyTestPlatformDb(platformDb);
    direct?.destroy?.();
    platformStorage?.destroy();
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    const objects = (listed.Contents ?? []).flatMap((item) => (item.Key ? [{ Key: item.Key }] : []));
    if (objects.length > 0) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    s3.destroy();
  });

  it("owner uploads through a presigned URL, commits, lists and downloads the verified bytes", async () => {
    const bytes = new Uint8Array(randomBytes(3 * 1024 * 1024));
    const reserved = await service.reserve({ ...ids, actorId: owner, request: { path: "reports/notes.txt",
      size: bytes.byteLength, sha256: sha(bytes), requestId: "owner-1", baseVersion: 0 } });
    expect((await put(reserved.putUrl, bytes)).ok).toBe(true);
    const file = await service.commit({ ...ids, actorId: owner, uploadId: reserved.uploadId });
    expect(file).toMatchObject({ path: "reports/notes.txt", version: 1, size: bytes.byteLength, sha256: sha(bytes) });
    expect((await service.list(ids)).files.map((entry) => entry.path)).toEqual(["reports/notes.txt"]);
    const { getUrl } = await service.get({ ...ids, fileId: file.id });
    expect(sha(await download(getUrl))).toBe(sha(bytes));
    expect(await service.usage(ids)).toMatchObject({ usedBytes: bytes.byteLength, reservedBytes: 0 });

    // Re-using the old upload URL must not change what was published.
    const tamper = new Uint8Array(randomBytes(bytes.byteLength));
    await put(reserved.putUrl, tamper);
    expect(sha(await download((await service.get({ ...ids, fileId: file.id })).getUrl))).toBe(sha(bytes));
  });

  it("member uploads a new version; a stale base version conflicts", async () => {
    const [current] = (await service.list(ids)).files;
    const bytes = new TextEncoder().encode("member edit");
    const reserved = await service.reserve({ ...ids, actorId: member, request: { path: "reports/notes.txt",
      size: bytes.byteLength, sha256: sha(bytes), requestId: "member-1", baseVersion: current!.version } });
    expect((await put(reserved.putUrl, bytes)).ok).toBe(true);
    const file = await service.commit({ ...ids, actorId: member, uploadId: reserved.uploadId });
    expect(file).toMatchObject({ version: 2, updatedBy: member });
    expect(new TextDecoder().decode(await download((await service.get({ ...ids, fileId: file.id })).getUrl))).toBe("member edit");
    await expect(service.reserve({ ...ids, actorId: owner, request: { path: "reports/notes.txt",
      size: 3, sha256: sha(new Uint8Array(3)), requestId: "stale", baseVersion: 1 } })).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects bytes that do not match the reserved digest and keeps them unpublished", async () => {
    const expected = new TextEncoder().encode("expected");
    const reserved = await service.reserve({ ...ids, actorId: member, request: { path: "bad.txt",
      size: expected.byteLength, sha256: sha(expected), requestId: "bad-1", baseVersion: 0 } });
    expect((await put(reserved.putUrl, new TextEncoder().encode("tampered"))).ok).toBe(true);
    await expect(service.commit({ ...ids, actorId: member, uploadId: reserved.uploadId })).rejects.toMatchObject({ code: "checksum" });
    expect((await service.list(ids)).files.map((entry) => entry.path)).not.toContain("bad.txt");
  });

  it("storage refuses a PUT whose size differs from the reservation", async () => {
    const bytes = new TextEncoder().encode("twelve bytes");
    const reserved = await service.reserve({ ...ids, actorId: owner, request: { path: "short.txt",
      size: bytes.byteLength, sha256: sha(bytes), requestId: "short-1", baseVersion: 0 } });
    expect((await put(reserved.putUrl, bytes.slice(0, 5))).ok).toBe(false);
    await expect(service.commit({ ...ids, actorId: owner, uploadId: reserved.uploadId })).rejects.toBeTruthy();
  });

  it("retrying the same request after an interrupted upload reuses the reservation and completes", async () => {
    const bytes = new TextEncoder().encode("retry me");
    const request = { path: "retry.txt", size: bytes.byteLength, sha256: sha(bytes), requestId: "retry-1", baseVersion: 0 };
    const first = await service.reserve({ ...ids, actorId: owner, request });
    const second = await service.reserve({ ...ids, actorId: owner, request });
    expect(second.uploadId).toBe(first.uploadId);
    expect((await put(second.putUrl, bytes)).ok).toBe(true);
    await expect(service.commit({ ...ids, actorId: owner, uploadId: second.uploadId })).resolves.toMatchObject({ path: "retry.txt" });
  });

  it("sweep removes staged objects once their upload URLs expire", async () => {
    const staged = await driveDb.selectFrom("organization_drive_garbage").select("object_key").execute();
    expect(staged.length).toBeGreaterThan(0);
    clock = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await service.sweep();
    for (const row of staged) {
      await expect(direct.getObject(row.object_key)).rejects.toBeTruthy();
    }
    const [file] = (await service.list(ids)).files;
    expect((await download((await service.get({ ...ids, fileId: file!.id })).getUrl)).byteLength).toBeGreaterThan(0);
  });
});
