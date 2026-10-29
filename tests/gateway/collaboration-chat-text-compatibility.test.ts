import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod/v4";
import { CanonicalChatMessagePartSchema, CanonicalChatMessageSchema, CollaborationSharedChatMessageSchema, type CanonicalChatMessage } from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationChatAdapter } from "../../packages/gateway/src/collaboration/chat-adapter.js";
import { registerChatRoutes } from "../../packages/gateway/src/collaboration/chat-routes.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import type { CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/route-support.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import { allowAllOrganizationPrecondition, collaborationActors, collaborationIds, createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

// Before PR 2901, shared messages used this existing strict, nonblank part
// contract. Keep its metadata validation while exercising the released text
// restriction, without depending on an ignored local frozen-source artifact.
const LegacyMessages = z.object({ messages: z.array(CollaborationSharedChatMessageSchema.safeExtend({
  parts: z.array(CanonicalChatMessagePartSchema).min(1).max(64),
})).max(100) }).strict();
const now = new Date("2026-09-07T12:00:00.000Z");
const key = "0123456789abcdef0123456789abcdef";
const path = `/api/collaboration/scopes/${collaborationIds.scope}/chat/messages`;
let fixture: CollaborationTestDatabase;
let app: Hono;
let signer: CollaborationProofSigner;
let nonce = 0;

beforeAll(async () => {
  fixture = await createCollaborationTestDatabase();
  await bootstrapChatDatabase(fixture.db);
  await bootstrapCollaborationDatabase(fixture.db);
  await fixture.db.insertInto("chats").values({
    id: collaborationIds.chat, owner_type: "personal", owner_id: collaborationActors.owner,
    create_request_id: "req_shared_legacy_text", project_id: null, title: "Shared text compatibility",
    lifecycle: "active", attention: "none", revision: 1,
    collaboration: JSON.stringify({ scopeId: collaborationIds.scope, mode: "discussion_only", executionFenced: true }),
    user_state: null, shell_state: null, fork_provenance: null, last_message_preview: null, current_selection: null,
    bound_driver_kind: null, bound_instance_id: null, bound_at_turn_id: null, created_at: now, updated_at: now,
  }).execute();
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope, owner_type: "personal", owner_id: collaborationActors.owner,
    kind: "chat", organization_id: "org_matrix_team", resource_id: collaborationIds.chat,
    parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", revision: 1, auth_epoch: 1,
    authority_runtime_id: collaborationIds.runtime, authority_generation: 1,
    execution_generation: null, execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
  }).execute();
  await fixture.db.insertInto("collaboration_members").values([collaborationActors.owner, collaborationActors.viewer].map(actorId => ({
    scope_id: collaborationIds.scope, actor_id: actorId, role: actorId === collaborationActors.owner ? "owner" as const : "viewer" as const,
    status: "accepted" as const, invitation_id: null, invited_by: collaborationActors.owner, accepted_at: now,
    expires_at: null, revision: 1, joined_at: now, updated_at: now,
  }))).execute();
  const repository = new CollaborationRepository(fixture.db, {now: () => now});
  const authority = new CollaborationAuthority(repository, {now: () => now, organizationPrecondition: allowAllOrganizationPrecondition});
  const chatAdapter = new CollaborationChatAdapter({db: fixture.db, authority, now: () => now,
    resolveParticipant: async actorId => ({actorId, displayName: "Shared participant"})});
  signer = new CollaborationProofSigner({activeKeyId: "fixture", keys: {fixture: key}, now: () => now,
    createNonce: () => (++nonce).toString(16).padStart(32, "0")});
  app = new Hono();
  // Only this route module is mounted; its exercised dependencies are real.
  registerChatRoutes(app, {chatAdapter, verifier: new CollaborationActorProofVerifier({
    runtimeId: collaborationIds.runtime, keys: {fixture: key}, now: () => now, authority,
  })} as CollaborationRouteOptions);
});
beforeEach(async () => { await fixture.db.deleteFrom("chat_messages").execute(); });
afterAll(async () => { await fixture.destroy(); });

async function seed(parts: CanonicalChatMessage["parts"], seq = 1, role: "assistant" | "user" = "assistant") {
  await fixture.db.insertInto("chat_messages").values({id: `msg_legacy_shared_${seq}`, chat_id: collaborationIds.chat,
    seq, role, state: "committed", purpose: role === "assistant" ? "assistant" : "discussion",
    actor_id: role === "user" ? collaborationActors.owner : null, turn_id: null, run_id: null,
    parts: JSON.stringify(parts), byte_count: Buffer.byteLength(JSON.stringify(parts)), search_text: "fixture", created_at: now,
  }).execute();
}
function read(query = "after=0&limit=50", actorId: string = collaborationActors.viewer) {
  const proof = signer.signHttp({actorId, ownerId: collaborationActors.owner, runtimeId: collaborationIds.runtime,
    scopeId: collaborationIds.scope, method: "GET", path, query, body: new Uint8Array()});
  return app.request(`${path}?${query}`, {headers: {"x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url")}});
}
const text = (value: string) => ({type: "text" as const, text: value});
it.each([
  ["blank-only", [text("\n\n\n")], false],
  ["nonblank part boundary", [text("x".repeat(32000)), text("\n\n\n")], true],
  ["sparse nonblank beyond one part", [text("x" + " ".repeat(31999)), text(" ".repeat(32000)), text(" ")], false],
  ["tool boundary", [text("before"), text("\n\n"), {type: "tool_result", toolCallId: "tool_fixture", outcome: "success", text: "tool result", truncated: false}, text("after")], true],
] as const)("serves legacy-compatible shared text without changing owner rows: %s", async (_scenario, parts, exact) => {
  await seed([...parts]);
  const before = await fixture.db.selectFrom("chat_messages").selectAll().execute();
  const response = await read(); expect(response.status).toBe(200);
  const wire = await response.json(); const parsed = LegacyMessages.parse(wire);
  expect(parsed.messages).toHaveLength(1);
  expect(parsed.messages[0]).toMatchObject({id: "msg_legacy_shared_1", sequence: "1", chatId: collaborationIds.chat,
    role: "assistant", state: "committed", purpose: "assistant", actor: {actorId: "matrix_ai", displayName: "Matrix AI"}, createdAt: now.toISOString()});
  if (exact) expect(parsed.messages[0]!.parts.flatMap(part => part.type === "text" ? [part.text] : []).join(""))
    .toBe(parts.flatMap(part => part.type === "text" ? [part.text] : []).join(""));
  else expect(parsed.messages[0]!.parts).toContainEqual({type: "status", tone: "info", label: "This response cannot be displayed in this version of Matrix OS."});
  for (const part of parts) if (part.type !== "text") expect(parsed.messages[0]!.parts).toContainEqual(part);
  expect(await fixture.db.selectFrom("chat_messages").selectAll().execute()).toEqual(before);
});

it("preserves sequence pagination and human attribution after a blank assistant message", async () => {
  await seed([text("\n\n")]); await seed([text("Human discussion")], 2, "user");
  const first = LegacyMessages.parse(await (await read("after=0&limit=1")).json());
  expect(first.messages.map(message => message.sequence)).toEqual(["1"]);
  const second = LegacyMessages.parse(await (await read(`after=${first.messages[0]!.sequence}&limit=1`)).json());
  expect(second.messages).toMatchObject([{id: "msg_legacy_shared_2", sequence: "2", role: "user",
    actor: {actorId: collaborationActors.owner, displayName: "Shared participant"}, parts: [text("Human discussion")]}]);
});

it("retains representable shared text when actor metadata exceeds the canonical encoded cap", async () => {
  const parts = [...Array.from({length: 4}, () => text("x".repeat(32000))), text("y"), text("\n\n")];
  const canonical = {id: "msg_legacy_shared_1", chatId: collaborationIds.chat, seq: 1, role: "assistant" as const,
    state: "committed" as const, purpose: "assistant" as const, parts, createdAt: now.toISOString()};
  // Fill one valid canonical row to its existing cap. Shared actor attribution
  // adds metadata, but the released shared DTO has no whole-message byte cap.
  parts[4] = text("y".repeat(1 + 128 * 1024 - Buffer.byteLength(JSON.stringify(canonical))));
  expect(Buffer.byteLength(JSON.stringify(CanonicalChatMessageSchema.parse(canonical)))).toBe(128 * 1024);
  await seed(parts);
  const before = await fixture.db.selectFrom("chat_messages").selectAll().execute();
  const response = await read(); expect(response.status).toBe(200);
  const wire = await response.json();
  const expectedText = parts.map(part => part.text).join("");
  const representable = {...wire.messages[0], parts: expectedText.match(/[\s\S]{1,32000}/g)!.map(text)};
  expect(Buffer.byteLength(JSON.stringify(representable))).toBeGreaterThan(128 * 1024);
  expect(LegacyMessages.safeParse({messages: [representable]}).success).toBe(true);
  const projected = LegacyMessages.parse(wire).messages[0]!;
  expect(projected.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("")).toBe(expectedText);
  expect(await fixture.db.selectFrom("chat_messages").selectAll().execute()).toEqual(before);
});

it("keeps unknown query and unauthorized readers rejected", async () => {
  await seed([text("\n\n")]);
  expect((await read("after=0&limit=1&assistantTextVersion=1")).status).toBe(400);
  expect((await read("after=0&limit=1", collaborationActors.outsider)).status).toBe(404);
});
