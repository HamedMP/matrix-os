import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeStagedObject, StagedObjectValidationError } from "../../../packages/gateway/src/sync/blob-publication.js";
import { handleCommit } from "../../../packages/gateway/src/sync/commit.js";
import { readManifest, type ManifestMeta } from "../../../packages/gateway/src/sync/manifest.js";
import { buildBlobKey, buildStagingKey } from "../../../packages/gateway/src/sync/r2-keys.js";
import type { R2Client } from "../../../packages/gateway/src/sync/r2-client.js";

const scope = { ownerId: "user1", runtimeSlot: "primary" } as const;
const STAGE_A = "11111111-1111-4111-8111-111111111111";
const STAGE_B = "22222222-2222-4222-8222-222222222222";

function sha256(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

async function consumeBody(body: unknown): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof Readable || (
    body !== null
    && typeof body === "object"
    && Symbol.asyncIterator in body
  )) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("unsupported fake body");
}

function createMemoryR2() {
  const objects = new Map<string, Buffer>();
  const r2 = {
    getObject: vi.fn(async (key: string) => {
      const body = objects.get(key);
      if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return {
        body: { transformToByteArray: async () => new Uint8Array(body) },
        etag: `"${sha256(body).slice(7, 23)}"`,
        contentLength: body.byteLength,
      };
    }),
    putObject: vi.fn(async (key: string, body: unknown) => {
      const bytes = await consumeBody(body);
      objects.set(key, bytes);
      return { etag: `"${sha256(bytes).slice(7, 23)}"` };
    }),
    deleteObject: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
    getPresignedGetUrl: vi.fn(),
    getPresignedPutUrl: vi.fn(),
    createMultipartUpload: vi.fn(),
    getPresignedPartUrl: vi.fn(),
    completeMultipartUpload: vi.fn(),
    abortMultipartUpload: vi.fn(),
    destroy: vi.fn(),
  };
  return { objects, r2: r2 as unknown as R2Client };
}

describe("immutable blob publication", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("promotes objects above the broker limit with bounded multipart requests", async () => {
    const { objects, r2 } = createMemoryR2();
    const body = Buffer.alloc(101 * 1024 * 1024, 7);
    objects.set(buildStagingKey(scope, STAGE_A), body);
    vi.mocked(r2.createMultipartUpload).mockResolvedValue("upload-1");
    vi.mocked(r2.getPresignedPartUrl).mockResolvedValue("https://storage.example/part");
    vi.mocked(r2.completeMultipartUpload).mockResolvedValue({ etag: "complete" });
    let uploaded = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const part = await consumeBody(init.body);
      expect(part.length).toBeLessThanOrEqual(16 * 1024 * 1024);
      uploaded += part.length;
      return new Response(null, { headers: { etag: "part-etag" } });
    }));
    await finalizeStagedObject({ r2, scope, stagingId: STAGE_A, expectedHash: sha256(body), expectedSize: body.length });
    expect(uploaded).toBe(body.length);
    expect(r2.putObject).not.toHaveBeenCalled();
    expect(r2.completeMultipartUpload).toHaveBeenCalledOnce();
  });

  it("rejects an expired publication without accepting a manifest", async () => {
    const { r2 } = createMemoryR2();
    await expect(finalizeStagedObject({ r2, scope, stagingId: STAGE_A, expectedHash: sha256(Buffer.from("a")), expectedSize: 1, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(r2.getObject).not.toHaveBeenCalled();
  });

  it("cancels a stalled download at the publication deadline", async () => {
    const { r2 } = createMemoryR2();
    const controller = new AbortController();
    const cancel = vi.fn();
    vi.mocked(r2.getObject).mockResolvedValue({
      body: new ReadableStream({ cancel }), contentLength: 1,
    });
    const pending = finalizeStagedObject({ r2, scope, stagingId: STAGE_A, expectedHash: sha256(Buffer.from("a")), expectedSize: 1, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(r2.getObject).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(r2.putObject).not.toHaveBeenCalled();
  });
  it("validates staged bytes before promoting them to a content-addressed key", async () => {
    const { objects, r2 } = createMemoryR2();
    const body = Buffer.from("accepted bytes");
    const hash = sha256(body);
    objects.set(buildStagingKey(scope, STAGE_A), body);

    const result = await finalizeStagedObject({
      r2,
      scope,
      stagingId: STAGE_A,
      expectedHash: hash,
      expectedSize: body.byteLength,
    });

    expect(result.objectKey).toBe(buildBlobKey(scope, hash));
    expect(objects.get(result.objectKey)).toEqual(body);
    expect(objects.has(buildStagingKey(scope, STAGE_A))).toBe(true);
  });

  it("rejects a hash mismatch without creating the claimed immutable object", async () => {
    const { objects, r2 } = createMemoryR2();
    const body = Buffer.from("tampered bytes");
    const claimedHash = sha256(Buffer.from("expected bytes"));
    objects.set(buildStagingKey(scope, STAGE_A), body);

    await expect(finalizeStagedObject({
      r2,
      scope,
      stagingId: STAGE_A,
      expectedHash: claimedHash,
      expectedSize: body.byteLength,
    })).rejects.toMatchObject<Partial<StagedObjectValidationError>>({
      name: "StagedObjectValidationError",
      code: "hash_mismatch",
    });
    expect(objects.has(buildBlobKey(scope, claimedHash))).toBe(false);
  });

  it("rejects an oversized declared object before buffering a non-streaming body", async () => {
    const { r2 } = createMemoryR2();
    const transformToByteArray = vi.fn(async () => new Uint8Array([1]));
    vi.mocked(r2.getObject).mockResolvedValueOnce({
      body: { transformToByteArray } as unknown as ReadableStream,
      contentLength: 1024,
    });

    await expect(finalizeStagedObject({
      r2,
      scope,
      stagingId: STAGE_A,
      expectedHash: sha256(Buffer.from("x")),
      expectedSize: 1,
    })).rejects.toMatchObject<Partial<StagedObjectValidationError>>({
      code: "size_mismatch",
    });
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("keeps the accepted writer's bytes when a concurrent stale commit is rejected", async () => {
    const { objects, r2 } = createMemoryR2();
    const bodyA = Buffer.from("writer A");
    const bodyB = Buffer.from("writer B");
    const hashA = sha256(bodyA);
    const hashB = sha256(bodyB);
    objects.set(buildStagingKey(scope, STAGE_A), bodyA);
    objects.set(buildStagingKey(scope, STAGE_B), bodyB);

    let meta: ManifestMeta | null = null;
    const db = {
      async getManifestMeta() {
        return meta;
      },
      async upsertManifestMeta(_scope: unknown, next: Omit<ManifestMeta, "updated_at">) {
        if (!meta || next.version > meta.version) {
          meta = { ...next, updated_at: new Date() };
        }
      },
      async advanceManifestMeta(
        _scope: unknown,
        expectedVersion: number,
        next: Omit<ManifestMeta, "updated_at">,
      ) {
        if ((meta?.version ?? 0) !== expectedVersion) return false;
        meta = { ...next, updated_at: new Date() };
        return true;
      },
      async withAdvisoryLock<T>(_scope: unknown, fn: (executor: unknown) => Promise<T>) {
        return fn({ transaction: true });
      },
    };
    const deps = { r2, db, broadcast: vi.fn() };

    const accepted = await handleCommit(deps, scope, "writer-a", {
      protocolVersion: 3,
      files: [{
        path: "shared.txt",
        hash: hashA,
        size: bodyA.byteLength,
        stagingId: STAGE_A,
      }],
      expectedVersion: 0,
    });
    const rejected = await handleCommit(deps, scope, "writer-b", {
      protocolVersion: 3,
      files: [{
        path: "shared.txt",
        hash: hashB,
        size: bodyB.byteLength,
        stagingId: STAGE_B,
      }],
      expectedVersion: 0,
    });

    expect(accepted).toEqual({ manifestVersion: 1, committed: 1 });
    expect(rejected).toMatchObject({ error: "version_conflict", currentVersion: 1 });
    const published = await readManifest({ r2, db }, scope);
    const entry = published.manifest.files["shared.txt"]!;
    expect(entry.hash).toBe(hashA);
    expect(entry.objectKey).toBe(buildBlobKey(scope, hashA));
    expect(objects.get(entry.objectKey!)).toEqual(bodyA);

    // A still-valid/replayed staging URL can mutate only its staging object.
    objects.set(buildStagingKey(scope, STAGE_A), Buffer.from("late replay"));
    expect(objects.get(entry.objectKey!)).toEqual(bodyA);
  });
});
