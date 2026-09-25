import { Kysely, sql } from "kysely";
import { Readable } from "node:stream";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it } from "vitest";
import { bootstrapOrganizationDriveDatabase, type OrganizationDriveDatabase } from "../../packages/gateway/src/organization-drive/database.js";
import { OrganizationDriveService } from "../../packages/gateway/src/organization-drive/service.js";

const org = "org_authority";
const scope = "00000000-0000-4000-8000-000000000001";
const actor = "user_ash";
const sha256 = "a".repeat(64);

async function fixture(quotaBytes = 100) {
  const instance = await KyselyPGlite.create();
  const db = new Kysely<OrganizationDriveDatabase>({ dialect: instance.dialect });
  await bootstrapOrganizationDriveDatabase(db);
  let object = new Uint8Array();
  let nativeStream = false;
  const r2 = {
    getPresignedPutUrl: async () => "https://storage.example/put",
    getPresignedGetUrl: async () => "https://storage.example/get",
    getObject: async () => ({ body: nativeStream ? Readable.from([object]) : new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(object); controller.close(); },
    }), contentLength: object.byteLength }),
    deleteObject: async () => {},
  };
  const service = new OrganizationDriveService({ db, r2, ownerId: "user_ash", runtimeSlot: "primary" });
  await service.enable({ organizationId: org, scopeId: scope, runtimeId: "vps:ash", generation: 1, quotaBytes });
  return { db, service, setObject(value: Uint8Array) { object = value; },
    setNativeObject(value: Uint8Array) { object = value; nativeStream = true; }, close: () => db.destroy() };
}

describe("organization drive service", () => {
  it("reserves quota atomically and replays an identical request", async () => {
    const f = await fixture(10);
    try {
      const request = { path: "work/a.txt", size: 8, sha256, requestId: "one", baseVersion: 0 };
      const first = await f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor, request });
      const replay = await f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor, request });
      expect(replay.uploadId).toBe(first.uploadId);
      await expect(f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor,
        request: { ...request, requestId: "two" } })).rejects.toMatchObject({ code: "quota" });
      await expect(f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor,
        request: { ...request, size: 9 } })).rejects.toMatchObject({ code: "conflict" });
    } finally { await f.close(); }
  });

  it("does not publish content until its bytes and digest are verified", async () => {
    const f = await fixture();
    try {
      const content = new TextEncoder().encode("hello");
      const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
      const reserved = await f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor,
        request: { path: "work/a.txt", size: 5, sha256: digest, requestId: "upload", baseVersion: 0 } });
      expect(await f.service.list({ organizationId: org, scopeId: scope })).toEqual([]);
      f.setObject(content);
      const committed = await f.service.commit({ organizationId: org, scopeId: scope, actorId: actor, uploadId: reserved.uploadId });
      expect(committed.version).toBe(1);
      expect((await f.service.list({ organizationId: org, scopeId: scope }))[0]?.path).toBe("work/a.txt");
      expect(await f.service.commit({ organizationId: org, scopeId: scope, actorId: actor, uploadId: reserved.uploadId })).toEqual(committed);
    } finally { await f.close(); }
  });

  it("verifies the Node stream shape returned by the direct R2 SDK", async () => {
    const f = await fixture();
    try {
      const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
      const reserved = await f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor,
        request: { path: "node.txt", size: 5, sha256: digest, requestId: "native", baseVersion: 0 } });
      f.setNativeObject(new TextEncoder().encode("hello"));
      await expect(f.service.commit({ organizationId: org, scopeId: scope, actorId: actor,
        uploadId: reserved.uploadId })).resolves.toMatchObject({ path: "node.txt" });
    } finally { await f.close(); }
  });

  it("rejects hash mismatch and releases the reservation", async () => {
    const f = await fixture(5);
    try {
      const reserved = await f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor,
        request: { path: "a.txt", size: 5, sha256, requestId: "bad", baseVersion: 0 } });
      f.setObject(new TextEncoder().encode("hello"));
      await expect(f.service.commit({ organizationId: org, scopeId: scope, actorId: actor, uploadId: reserved.uploadId }))
        .rejects.toMatchObject({ code: "checksum" });
      expect(await f.service.list({ organizationId: org, scopeId: scope })).toEqual([]);
      await expect(f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor,
        request: { path: "a.txt", size: 5, sha256, requestId: "good", baseVersion: 0 } })).resolves.toBeDefined();
    } finally { await f.close(); }
  });

  it("releases expired reservations during a bounded sweep", async () => {
    const f = await fixture(5);
    try {
      await f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor,
        request: { path: "a.txt", size: 5, sha256, requestId: "expires", baseVersion: 0 } });
      await sql`UPDATE organization_drive_uploads SET expires_at = now() - interval '1 minute'`.execute(f.db);
      await f.service.sweep();
      expect(await f.service.usage({ organizationId: org, scopeId: scope })).toMatchObject({ reservedBytes: 0 });
      await expect(f.service.reserve({ organizationId: org, scopeId: scope, actorId: actor,
        request: { path: "a.txt", size: 5, sha256, requestId: "new", baseVersion: 0 } })).resolves.toBeDefined();
    } finally { await f.close(); }
  });
});
