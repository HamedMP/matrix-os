import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { MessagingKyselyRepository } from "../../../packages/gateway/src/messages/repository.js";

const ownerId = "user_a";
const roomId = "!room:matrixos.local";

describe("permission revocation abort behavior", () => {
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

  it("cancels queued work, requests running abort, and cancels unsent replies in the permission transaction", async () => {
    const granted = await repository.updatePermission({
      ownerId,
      roomId,
      baseRevision: 1,
      readEnabled: true,
      replyEnabled: true,
      automationEnabled: true,
      mentionOnly: false,
      grantedBy: ownerId,
    });
    await repository.enqueueHermesWork({
      ownerId,
      roomId,
      sourceEventId: "$event1:matrixos.local",
      kind: "draft_reply",
      status: "queued",
      permissionRevision: granted.revision,
    });
    await repository.enqueueHermesWork({
      ownerId,
      roomId,
      sourceEventId: "$event2:matrixos.local",
      kind: "automation",
      status: "running",
      permissionRevision: granted.revision,
    });
    const reply = await repository.createReply({
      ownerId,
      roomId,
      source: "hermes",
      status: "approval_required",
      body: "Draft",
      permissionRevision: granted.revision,
      clientTxnId: "txn_revoke",
    });

    const revoked = await repository.updatePermission({
      ownerId,
      roomId,
      baseRevision: granted.revision,
      readEnabled: false,
      replyEnabled: false,
      automationEnabled: false,
      mentionOnly: true,
      grantedBy: ownerId,
    });

    expect(revoked.revision).toBe(granted.revision + 1);
    const workItems = await repository.listWorkItems({ ownerId, roomId });
    expect(workItems).toHaveLength(2);
    expect(workItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "cancelled" }),
      expect.objectContaining({ status: "cancel_requested" }),
    ]));
    await expect(repository.getReply({ ownerId, replyId: reply.id })).resolves.toMatchObject({
      status: "cancelled",
      cancelReason: "permission_revoked",
    });
  });
  it("does not cancel replies that were already sent", async () => {
    const granted = await repository.updatePermission({
      ownerId,
      roomId,
      baseRevision: 1,
      readEnabled: true,
      replyEnabled: true,
      automationEnabled: false,
      mentionOnly: false,
      grantedBy: ownerId,
    });
    const sent = await repository.createReply({
      ownerId,
      roomId,
      source: "user",
      status: "sent",
      body: "Already sent",
      permissionRevision: granted.revision,
      clientTxnId: "txn_sent",
    });

    await expect(repository.cancelReply({
      ownerId,
      replyId: sent.id,
      reason: "user_cancelled",
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.getReply({ ownerId, replyId: sent.id })).resolves.toMatchObject({
      status: "sent",
    });
  });

});
