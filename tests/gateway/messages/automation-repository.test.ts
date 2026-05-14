import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import type { Kysely } from "kysely";
import { MessagingKyselyRepository, type MessagingDatabase } from "../../../packages/gateway/src/messages/repository.js";

const ownerId = "user_a";
const roomId = "!room:matrixos.local";

describe("messaging automation repository behavior", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: MessagingKyselyRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new MessagingKyselyRepository(pglite.dialect);
    await repository.bootstrap();
    const setup = await repository.createSetupSession({ ownerId, networkSlug: "whatsapp" });
    const account = await repository.completeSetupSession({
      ownerId,
      setupId: setup.id,
      externalAccountId: "wa_1",
      displayName: "WhatsApp",
    });
    await repository.upsertConversation({
      ownerId,
      roomId,
      networkSlug: "whatsapp",
      accountId: account.id,
      displayName: "Family",
    });
  });

  afterEach(async () => {
    await repository.destroy();
  });

  it("keeps Hermes delivery authoritative when automation is also enabled", async () => {
    await repository.updatePermission({
      ownerId,
      roomId,
      baseRevision: 1,
      readEnabled: true,
      replyEnabled: false,
      automationEnabled: true,
      mentionOnly: false,
      grantedBy: ownerId,
    });

    await expect(repository.ingestBridgeEvent({
      ownerId,
      networkSlug: "whatsapp",
      accountId: "acct_0123456789abcdef0123456789abcdef",
      roomId,
      eventId: "$event1:matrixos.local",
      content: { kind: "text", body: "deadline tomorrow" },
      occurredAt: "2026-05-13T00:00:00.000Z",
    })).resolves.toMatchObject({ accepted: true, effect: "sent_to_hermes" });
  });

  it("rejects deleting an already disabled automation rule", async () => {
    const rule = await repository.createAutomationRule({
      ownerId,
      name: "Deadlines",
      scope: "room",
      roomId,
      trigger: { type: "text_contains", value: "deadline" },
      action: { type: "create_task", titleTemplate: "Follow up: {body}" },
    });

    await expect(repository.deleteAutomationRule({ ownerId, ruleId: rule.id })).resolves.toEqual({
      ruleId: rule.id,
      status: "disabled",
    });
    await expect(repository.deleteAutomationRule({ ownerId, ruleId: rule.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("records automation creation audit event in the same repository operation", async () => {
    const rule = await repository.createAutomationRule({
      ownerId,
      name: "Deadlines",
      scope: "room",
      roomId,
      trigger: { type: "text_contains", value: "deadline" },
      action: { type: "create_task", titleTemplate: "Follow up: {body}" },
    });

    const db = (repository as unknown as { kysely: Kysely<MessagingDatabase> }).kysely;
    const auditRow = await db
      .selectFrom("messaging_audit_events")
      .select(["type", "owner_id", "room_id", "safe_summary", "metadata"])
      .where("owner_id", "=", ownerId)
      .where("type", "=", "automation_rule_created")
      .executeTakeFirstOrThrow();

    expect(auditRow).toMatchObject({
      type: "automation_rule_created",
      owner_id: ownerId,
      room_id: roomId,
      safe_summary: "Messaging automation rule created",
    });
    expect(auditRow.metadata).toMatchObject({ ruleId: rule.id });
  });

  it("includes all_permitted rules when listing rules for a room dispatch", async () => {
    const roomRule = await repository.createAutomationRule({
      ownerId,
      name: "Room deadlines",
      scope: "room",
      roomId,
      trigger: { type: "text_contains", value: "deadline" },
      action: { type: "draft_reply", bodyTemplate: "I saw: {body}" },
    });
    const allPermittedRule = await repository.createAutomationRule({
      ownerId,
      name: "All deadlines",
      scope: "all_permitted",
      trigger: { type: "text_contains", value: "deadline" },
      action: { type: "create_task", titleTemplate: "Follow up: {body}" },
    });

    await expect(repository.listAutomationRules({ ownerId }, { roomId })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: roomRule.id }),
        expect.objectContaining({ id: allPermittedRule.id }),
      ]),
    });
  });
});
