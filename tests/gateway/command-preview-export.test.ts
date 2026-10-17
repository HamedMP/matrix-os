import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { sealToolPreview } from "../../packages/gateway/src/coding-agents/protected-tool-output.mjs";
import { createOwnerToolOutputProjection } from "../../packages/gateway/src/chat/owner-tool-output.js";

let repository: ChatRepository;
const owner = { type: "personal" as const, ownerId: "user_export" };
const key = Buffer.alloc(32, 7);
const command = "cat /home/matrix/home/projects/demo/README.md\nprintf done";
beforeEach(async () => {
  const pg = await createTestPGlite();
  repository = new ChatRepository(pg.dialect);
  await repository.bootstrap();
});
afterEach(async () => repository.kysely.destroy());

it("keeps commands encrypted in persistence and out of export copies", async () => {
  const { snapshot } = createCanonicalChatFixture("accepted");
  const chatId = snapshot.chat.id;
  await repository.create(owner, { id: chatId, clientRequestId: "req_command_export", title: "Export test" });
  const message = snapshot.messages[0]!;
  const turn = snapshot.turns[0]!;
  const run = snapshot.runs[0]!;
  await repository.admitTurn(owner, { chatId, baseRevision: 0, message, turn, run });
  const protectedPreview = sealToolPreview(key, "command_export", command);
  await repository.appendRunActivities(owner, chatId, run.id, [{
    id: "evt_command_export", chatId, runId: run.id, occurredAt: run.createdAt,
    type: "agent.activity", activityId: "command_export", kind: "command", label: "Run command", status: "completed", protectedPreview,
  }]);
  const persisted = await repository.getDetailPage(owner, chatId, { limit: 20 });
  expect(JSON.stringify(persisted)).toContain("protectedPreview");
  expect(JSON.stringify(persisted)).not.toContain("/home/matrix/home");
  const projected = createOwnerToolOutputProjection(key, [owner.ownerId])(owner, persisted!);
  expect(JSON.stringify(projected)).toContain("/home/matrix/home");
  const exported = await repository.exportChat(owner, chatId);
  expect(JSON.stringify(exported)).not.toContain("protectedPreview");
  expect(JSON.stringify(exported)).not.toContain("/home/matrix/home");
  expect(await repository.exportChat({ type: "personal", ownerId: "other" }, chatId)).toBeNull();
});
