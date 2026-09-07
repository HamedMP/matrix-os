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
      ownerId: collaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [{ actorId: collaborationActors.editor, status: "invited" }],
    });
    expect(JSON.stringify(payload)).not.toMatch(/title|message|content|transcript/i);
    expect(await fixture.db.selectFrom("collaboration_directory_outbox")
      .select(["attempts", "delivered_at"]).executeTakeFirstOrThrow()).toMatchObject({ attempts: 1 });
    expect((await fixture.db.selectFrom("collaboration_directory_outbox")
      .select("delivered_at").executeTakeFirstOrThrow()).delivered_at).not.toBeNull();
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
});

async function seedScopeAndOutbox(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    kind: "chat",
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
    recipient_actor_ids: JSON.stringify([collaborationActors.editor]),
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
