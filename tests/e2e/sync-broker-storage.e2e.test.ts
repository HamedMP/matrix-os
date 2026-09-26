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
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatformR2Client } from "../../packages/gateway/src/sync/platform-r2-client.js";
import { createR2Client, type R2Client } from "../../packages/gateway/src/sync/r2-client.js";
import { insertContainer, type PlatformDB } from "../../packages/platform/src/db.js";
import { createInternalSyncRoutes } from "../../packages/platform/src/internal-sync-routes.js";
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
  let direct: R2Client;
  let brokered: R2Client;

  beforeAll(async () => {
    const bucket = `sync-broker-${Date.now()}`;
    const s3 = new S3Client({ region: "auto", endpoint, forcePathStyle: true,
      credentials: { accessKeyId: "matrixos", secretAccessKey: "matrixos123" } });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    s3.destroy();
    direct = await createR2Client({ accessKeyId: "matrixos", secretAccessKey: "matrixos123", bucket,
      endpoint, forcePathStyle: true });
    ({ db } = await createTestPlatformDb());
    await insertContainer(db, { handle, clerkUserId: "user_alice", port: 5001, shellPort: 6001, status: "running" });
    // Same mount as packages/platform/src/main.ts.
    const app = new Hono().route("/internal/containers/:handle/sync", createInternalSyncRoutes({
      db, r2: direct, platformSecret: secret, r2PrefixRoot: "matrixos-sync" }));
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    brokered = createPlatformR2Client({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      handle, token: createHmac("sha256", secret).update(handle).digest("hex") });
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await destroyTestPlatformDb(db);
    direct?.destroy();
  });

  it("stores in-memory bytes sent with a Content-Length", async () => {
    const bytes = new Uint8Array(randomBytes(4 * 1024 * 1024));
    await brokered.putObject(`${prefix}/files/bytes.bin`, bytes);
    expect(await storedDigest(direct, `${prefix}/files/bytes.bin`)).toBe(digest(bytes));
  });

  it("stores a chunked Node stream by buffering it within the body limit", async () => {
    const bytes = new Uint8Array(randomBytes(256 * 1024));
    await brokered.putObject(`${prefix}/files/stream.bin`, Readable.from([Buffer.from(bytes)]));
    expect(await storedDigest(direct, `${prefix}/files/stream.bin`)).toBe(digest(bytes));
  });

  it("streams a file directly when its length is known", async () => {
    const bytes = new Uint8Array(randomBytes(512 * 1024));
    await direct.putObject(`${prefix}/files/direct.bin`, Readable.from([Buffer.from(bytes)]),
      { contentLength: bytes.byteLength });
    expect(await storedDigest(direct, `${prefix}/files/direct.bin`)).toBe(digest(bytes));
  });
});
