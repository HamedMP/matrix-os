/**
 * Real-storage check for platform-brokered sync writes. The S3 SDK's checksum
 * middleware rejects web streams and streams of unknown length before any request
 * is sent, so mocked storage cannot catch this. Runs only when
 * MATRIX_TEST_S3_ENDPOINT points at S3-compatible storage (for example MinIO with
 * matrixos/matrixos123 credentials).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformR2Client } from "../../packages/gateway/src/sync/platform-r2-client.js";
import { createR2Client, type R2Client } from "../../packages/gateway/src/sync/r2-client.js";
import { insertContainer, type PlatformDB } from "../../packages/platform/src/db.js";
import { createInternalSyncRoutes } from "../../packages/platform/src/internal-sync-routes.js";
import { createR2Client as createPlatformStorageClient } from "../../packages/platform/src/r2-client.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../platform/platform-db-test-helper.js";

const endpoint = process.env.MATRIX_TEST_S3_ENDPOINT;
const secret = "platform-secret-sync-broker-e2e";
const handle = "alice";
const prefix = "matrixos-sync/user_alice";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Compare digests: a byte-wise deep equal of megabytes blocks the event loop for seconds.
async function storedDigest(r2: R2Client, key: string): Promise<string> {
  const { body } = await r2.getObject(key);
  return digest(new Uint8Array(await new Response(body as ReadableStream).arrayBuffer()));
}

describe.skipIf(!endpoint)("platform-brokered sync writes on real storage", () => {
  let db: PlatformDB;
  let server: ReturnType<typeof serve>;
  let s3: S3Client;
  let bucket: string;
  let direct: R2Client;
  let brokered: R2Client;
  const brokerWrites: Array<number | undefined> = [];

  beforeAll(async () => {
    bucket = `sync-broker-${Date.now()}`;
    s3 = new S3Client({ region: "auto", endpoint, forcePathStyle: true,
      credentials: { accessKeyId: "matrixos", secretAccessKey: "matrixos123" } });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    direct = await createR2Client({ accessKeyId: "matrixos", secretAccessKey: "matrixos123", bucket,
      endpoint, forcePathStyle: true });
    // The platform broker uses its own storage client in production.
    const platformStorage = await createPlatformStorageClient({ accessKeyId: "matrixos",
      secretAccessKey: "matrixos123", bucket, endpoint, forcePathStyle: true });
    const brokerStorage = { ...platformStorage, putObject: (...args: Parameters<typeof platformStorage.putObject>) => {
      brokerWrites.push(args[2]?.contentLength);
      return platformStorage.putObject(...args);
    } };
    ({ db } = await createTestPlatformDb());
    await insertContainer(db, { handle, clerkUserId: "user_alice", port: 5001, shellPort: 6001, status: "running" });
    // Same mount as packages/platform/src/main.ts.
    const app = new Hono().route("/internal/containers/:handle/sync", createInternalSyncRoutes({
      db, r2: brokerStorage, platformSecret: secret, r2PrefixRoot: "matrixos-sync" }));
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    brokered = createPlatformR2Client({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      handle, token: createHmac("sha256", secret).update(handle).digest("hex") });
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await destroyTestPlatformDb(db);
    direct?.destroy();
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    const objects = (listed.Contents ?? []).flatMap((item) => (item.Key ? [{ Key: item.Key }] : []));
    if (objects.length > 0) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    s3.destroy();
  });

  it("stores in-memory bytes sent with a Content-Length", async () => {
    const bytes = new Uint8Array(randomBytes(4 * 1024 * 1024));
    await brokered.putObject(`${prefix}/files/bytes.bin`, bytes);
    expect(await storedDigest(direct, `${prefix}/files/bytes.bin`)).toBe(digest(bytes));
    expect(brokerWrites.at(-1)).toBe(bytes.byteLength);
  });

  it("stores a chunked Node stream by buffering it within the body limit", async () => {
    const bytes = new Uint8Array(randomBytes(256 * 1024));
    await brokered.putObject(`${prefix}/files/stream.bin`, Readable.from([Buffer.from(bytes)]));
    expect(await storedDigest(direct, `${prefix}/files/stream.bin`)).toBe(digest(bytes));
    expect(brokerWrites.at(-1)).toBeUndefined();
  });

  it("streams a Node stream through the broker when its length is declared", async () => {
    const bytes = new Uint8Array(randomBytes(768 * 1024));
    await brokered.putObject(`${prefix}/files/declared.bin`, Readable.from([Buffer.from(bytes)]),
      { contentLength: bytes.byteLength });
    expect(await storedDigest(direct, `${prefix}/files/declared.bin`)).toBe(digest(bytes));
    expect(brokerWrites.at(-1)).toBe(bytes.byteLength);
  });

  it("streams a file directly when its length is known", async () => {
    const bytes = new Uint8Array(randomBytes(512 * 1024));
    await direct.putObject(`${prefix}/files/direct.bin`, Readable.from([Buffer.from(bytes)]),
      { contentLength: bytes.byteLength });
    expect(await storedDigest(direct, `${prefix}/files/direct.bin`)).toBe(digest(bytes));
  });
});
