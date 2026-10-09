import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationDirectoryOutbox } from "../../packages/gateway/src/collaboration/directory-outbox.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");

describe("CollaborationDirectoryOutbox", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedScopeAndOutbox(fixture);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("never sends its service token over remote cleartext HTTP", async () => {
    const fetchImpl = vi.fn();
    expect(() => new CollaborationDirectoryOutbox({
      db: fixture.db,
      platformBaseUrl: "http://platform.internal",
      runtimeId: collaborationIds.runtime,
      serviceToken: "runtime-service-secret-0123456789abcdef",
      fetchImpl,
      startTimer: false,
    })).toThrow("Collaboration platform URL is unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();

    const loopback = new CollaborationDirectoryOutbox({
      db: fixture.db,
      platformBaseUrl: "http://localhost:8787",
      runtimeId: collaborationIds.runtime,
      serviceToken: "runtime-service-secret-0123456789abcdef",
      fetchImpl,
      startTimer: false,
    });
    await loopback.shutdown();
  });

  it("delivers bounded content-free directory metadata and marks it after success", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({ revision: 9 })
      .where("id", "=", collaborationIds.scope).execute();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const worker = new CollaborationDirectoryOutbox({
      db: fixture.db,
      platformBaseUrl: "https://platform.internal",
      runtimeId: collaborationIds.runtime,
      serviceToken: "runtime-service-secret-0123456789abcdef",
      fetchImpl,
      now: () => now,
      startTimer: false,
    });
    expect(await worker.runOnce()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://platform.internal/internal/collaboration/directory");
    expect(init).toMatchObject({ method: "PUT", redirect: "error" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer runtime-service-secret-0123456789abcdef");
    const payload = JSON.parse(init.body as string);
    expect(payload).toEqual({
      eventId: "60000000-0000-4000-8000-000000000001",
      scopeId: collaborationIds.scope,
      runtimeId: collaborationIds.runtime,
      // S05: read inside the claim transaction, so a lookup failure leaves the event retryable.
      ownerId: collaborationActors.owner,
      organizationId: "org_matrix_team",
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [{
        actorId: collaborationActors.editor,
        status: "invited",
        invitationId: collaborationIds.invitation,
      }],
    });
    expect(JSON.stringify(payload)).not.toMatch(/title|message|content|transcript/i);
    expect(await fixture.db.selectFrom("collaboration_directory_outbox")
      .select(["attempts", "delivered_at"]).executeTakeFirstOrThrow()).toMatchObject({ attempts: 1 });
    expect((await fixture.db.selectFrom("collaboration_directory_outbox")
      .select("delivered_at").executeTakeFirstOrThrow()).delivered_at).not.toBeNull();
    await worker.shutdown();
  });

  it("flags an active organization-wide grant as the organization audience without naming members", async () => {
    await fixture.db.insertInto("collaboration_grants").values({
      id: "70000000-0000-4000-8000-000000000001",
      scope_id: collaborationIds.scope,
      organization_id: "org_matrix_team",
      audience_kind: "organization",
      audience_actor_id: null,
      preset: "contributor",
      state: "active",
      policy_version: "v1",
      source_id: null,
      legacy_ceiling: null,
      expires_at: null,
      created_by: collaborationActors.owner,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      revoked_at: null,
    }).execute();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const worker = new CollaborationDirectoryOutbox({
      db: fixture.db,
      platformBaseUrl: "https://platform.internal",
      runtimeId: collaborationIds.runtime,
      serviceToken: "runtime-service-secret-0123456789abcdef",
      fetchImpl,
      now: () => now,
      startTimer: false,
    });
    expect(await worker.runOnce()).toBe(1);
    const payload = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string) as { audience?: string; organizationGrantId?: string; recipients: unknown[] };
    expect(payload.audience).toBe("organization");
    expect(payload.organizationGrantId).toBe("70000000-0000-4000-8000-000000000001");
    expect(payload.recipients).toHaveLength(1);
    await worker.shutdown();
  });

  it("omits expired and revoked organization grants at claim time", async () => {
    for (const [id, state, expiry] of [
      ["70000000-0000-4000-8000-000000000002", "active", "2026-09-07T11:59:59.000Z"],
      ["70000000-0000-4000-8000-000000000003", "revoked", null],
    ] as const) {
      await fixture.db.insertInto("collaboration_grants").values({
        id, scope_id: collaborationIds.scope, organization_id: "org_matrix_team",
        audience_kind: "organization", audience_actor_id: null, preset: "viewer", state,
        policy_version: "v1", source_id: null, legacy_ceiling: null, expires_at: expiry,
        created_by: collaborationActors.owner, created_at: now.toISOString(), updated_at: now.toISOString(), revoked_at: null,
      }).execute();
    }
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const worker = new CollaborationDirectoryOutbox({
      db: fixture.db, platformBaseUrl: "https://platform.internal", runtimeId: collaborationIds.runtime,
      serviceToken: "runtime-service-secret-0123456789abcdef", fetchImpl, now: () => now, startTimer: false,
    });
    expect(await worker.runOnce()).toBe(1);
    const payload = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string) as { audience?: string; organizationGrantId?: string };
    expect(payload.audience).toBeUndefined();
    expect(payload.organizationGrantId).toBeUndefined();
    await worker.shutdown();
  });

  it("backs off safely, caps attempts, and never marks a failed delivery", async () => {
    const fetchImpl = vi.fn(async () => new Response("provider database exploded", { status: 503 }));
    const worker = new CollaborationDirectoryOutbox({
      db: fixture.db,
      platformBaseUrl: "https://platform.internal",
      runtimeId: collaborationIds.runtime,
      serviceToken: "runtime-service-secret-0123456789abcdef",
      fetchImpl,
      now: () => now,
      startTimer: false,
    });
    expect(await worker.runOnce()).toBe(0);
    const failed = await fixture.db.selectFrom("collaboration_directory_outbox")
      .select(["attempts", "retry_after", "delivered_at"]).executeTakeFirstOrThrow();
    expect(Number(failed.attempts)).toBe(1);
    expect(new Date(failed.retry_after).getTime()).toBeGreaterThan(now.getTime());
    expect(failed.delivered_at).toBeNull();
    expect(await worker.runOnce()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await fixture.db.updateTable("collaboration_directory_outbox").set({ attempts: 20, retry_after: now.toISOString() })
      .execute();
    expect(await worker.runOnce()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await worker.shutdown();
  });

  it("holds a scope's later event while an earlier event is on its final attempt", async () => {
    // The earlier event is out on its last attempt (attempts at the limit, retry not yet due);
    // a later event of the same scope must wait until that attempt can no longer land.
    await fixture.db.updateTable("collaboration_directory_outbox")
      .set({ attempts: 20, retry_after: new Date(now.getTime() + 60_000).toISOString() })
      .where("event_id", "=", "60000000-0000-4000-8000-000000000001")
      .execute();
    await fixture.db.insertInto("collaboration_events").values({
      scope_id: collaborationIds.scope, scope_seq: 2, event_id: "60000000-0000-4000-8000-000000000003",
      resource_kind: "chat", resource_id: collaborationIds.chat, revision: 2, authority_generation: 1,
      event_type: "member.accepted", payload: JSON.stringify({}), created_at: now.toISOString(),
    }).execute();
    await fixture.db.insertInto("collaboration_directory_outbox").values({
      event_id: "60000000-0000-4000-8000-000000000003", scope_id: collaborationIds.scope,
      recipient_actor_ids: JSON.stringify([collaborationActors.editor]), authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1, resource_kind: "chat", discovery_state: "accepted",
      retry_after: now.toISOString(), delivered_at: null, created_at: now.toISOString(),
    }).execute();
    let clock = now.getTime();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const worker = new CollaborationDirectoryOutbox({
      db: fixture.db, platformBaseUrl: "https://platform.internal", runtimeId: collaborationIds.runtime,
      serviceToken: "runtime-service-secret-0123456789abcdef", fetchImpl, now: () => new Date(clock), startTimer: false,
    });
    try {
      expect(await worker.runOnce()).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
      // A slow batch can hold that attempt well past its retry time: the scope stays held.
      clock += 5 * 60_000;
      expect(await worker.runOnce()).toBe(0);
      // Only an attempt that could no longer be running (its worker died) stops holding the scope.
      clock += 15 * 60_000;
      expect(await worker.runOnce()).toBe(1);
    } finally {
      await worker.shutdown();
    }
  });

  it("releases a scope's later event as soon as the earlier event's final attempt fails", async () => {
    await fixture.db.updateTable("collaboration_directory_outbox").set({ attempts: 19 })
      .where("event_id", "=", "60000000-0000-4000-8000-000000000001").execute();
    await fixture.db.insertInto("collaboration_events").values({
      scope_id: collaborationIds.scope, scope_seq: 2, event_id: "60000000-0000-4000-8000-000000000004",
      resource_kind: "chat", resource_id: collaborationIds.chat, revision: 2, authority_generation: 1,
      event_type: "member.accepted", payload: JSON.stringify({}), created_at: now.toISOString(),
    }).execute();
    await fixture.db.insertInto("collaboration_directory_outbox").values({
      event_id: "60000000-0000-4000-8000-000000000004", scope_id: collaborationIds.scope,
      recipient_actor_ids: JSON.stringify([collaborationActors.editor]), authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1, resource_kind: "chat", discovery_state: "accepted",
      retry_after: now.toISOString(), delivered_at: null, created_at: now.toISOString(),
    }).execute();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => new Response(null, {
      status: String(init.body).includes("60000000-0000-4000-8000-000000000001") ? 503 : 204,
    }));
    const worker = new CollaborationDirectoryOutbox({
      db: fixture.db, platformBaseUrl: "https://platform.internal", runtimeId: collaborationIds.runtime,
      serviceToken: "runtime-service-secret-0123456789abcdef", fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now, startTimer: false,
    });
    try {
      expect(await worker.runOnce()).toBe(0);
      expect(await worker.runOnce()).toBe(1);
    } finally {
      await worker.shutdown();
    }
  });

  it("quarantines a malformed row without blocking the valid rows after it", async () => {
    await fixture.db.updateTable("collaboration_directory_outbox")
      .set({ recipient_actor_ids: JSON.stringify([""]) })
      .where("event_id", "=", "60000000-0000-4000-8000-000000000001")
      .execute();
    await fixture.db.insertInto("collaboration_events").values({
      scope_id: collaborationIds.scope,
      scope_seq: 2,
      event_id: "60000000-0000-4000-8000-000000000002",
      resource_kind: "chat",
      resource_id: collaborationIds.chat,
      revision: 2,
      authority_generation: 1,
      event_type: "member.accepted",
      payload: JSON.stringify({}),
      created_at: now.toISOString(),
    }).execute();
    await fixture.db.insertInto("collaboration_directory_outbox").values({
      event_id: "60000000-0000-4000-8000-000000000002",
      scope_id: collaborationIds.scope,
      recipient_actor_ids: JSON.stringify([collaborationActors.editor]),
      authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1,
      resource_kind: "chat",
      discovery_state: "accepted",
      retry_after: now.toISOString(),
      delivered_at: null,
      created_at: now.toISOString(),
    }).execute();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const worker = new CollaborationDirectoryOutbox({
      db: fixture.db,
      platformBaseUrl: "https://platform.internal",
      runtimeId: collaborationIds.runtime,
      serviceToken: "runtime-service-secret-0123456789abcdef",
      fetchImpl,
      now: () => now,
      startTimer: false,
    });

    // A scope delivers in order, so the valid later row waits for the cycle after the earlier
    // malformed row is quarantined; it is never blocked behind it.
    expect(await worker.runOnce()).toBe(0);
    expect(await worker.runOnce()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const rows = await fixture.db.selectFrom("collaboration_directory_outbox")
      .select(["event_id", "attempts", "delivered_at"])
      .orderBy("event_id")
      .execute();
    expect(rows[0]).toMatchObject({ attempts: 20, delivered_at: null });
    expect(rows[1]?.delivered_at).not.toBeNull();
    await worker.shutdown();
  });
});

async function seedScopeAndOutbox(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    kind: "chat",
    organization_id: "org_matrix_team",
    resource_id: collaborationIds.chat,
    parent_scope_id: null,
    membership_mode: "direct",
    lifecycle: "shared",
    revision: 1,
    auth_epoch: 1,
    authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1,
    execution_generation: null,
    execution_eligibility: null,
    deleted_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).execute();
  await fixture.db.insertInto("collaboration_directory_outbox").values({
    event_id: "60000000-0000-4000-8000-000000000001",
    scope_id: collaborationIds.scope,
    recipient_actor_ids: JSON.stringify([{
      actorId: collaborationActors.editor,
      invitationId: collaborationIds.invitation,
    }]),
    authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1,
    resource_kind: "chat",
    discovery_state: "invited",
    retry_after: now.toISOString(),
    delivered_at: null,
    created_at: now.toISOString(),
  }).execute();
  await fixture.db.insertInto("collaboration_events").values({
    scope_id: collaborationIds.scope,
    scope_seq: 1,
    event_id: "60000000-0000-4000-8000-000000000001",
    resource_kind: "chat",
    resource_id: collaborationIds.chat,
    revision: 1,
    authority_generation: 1,
    event_type: "invitation.created",
    payload: JSON.stringify({}),
    created_at: now.toISOString(),
  }).execute();
}
