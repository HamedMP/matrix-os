import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import {
  MessagingKyselyRepository,
  type MessagingDatabase,
} from "../../../packages/gateway/src/messages/repository.js";
import { linkTestAccount } from "./helpers.js";

const ownerId = "user_a";
const otherOwnerId = "user_b";

describe("MessagingKyselyRepository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: MessagingKyselyRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new MessagingKyselyRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.destroy();
  });

  it("bootstraps messaging tables idempotently and lists supported networks", async () => {
    await repository.bootstrap();

    await expect(repository.listNetworks()).resolves.toMatchObject([
      { slug: "telegram", enabled: true },
      { slug: "whatsapp", enabled: true },
      { slug: "linkedin", enabled: true },
    ]);
  });

  it("lists linked accounts only for their owner", async () => {
    const account = await linkTestAccount(repository, { ownerId, loginId: "wa_1", displayName: "Personal WhatsApp" });

    await expect(repository.listAccounts({ ownerId })).resolves.toEqual([
      expect.objectContaining({ id: account.id, ownerId, networkSlug: "whatsapp", externalAccountId: "wa_1", status: "connected" }),
    ]);
    await expect(repository.listAccounts({ ownerId: otherOwnerId })).resolves.toHaveLength(0);
    await expect(repository.getAccount({ ownerId: otherOwnerId }, account.id)).resolves.toBeNull();
  });
  it("deduplicates legacy NULL external account rows before creating the singleton index", async () => {
    const legacyPglite = await KyselyPGlite.create();
    const legacyKysely = new Kysely<MessagingDatabase>({ dialect: legacyPglite.dialect });
    try {
      await sql`
        CREATE TABLE messaging_accounts (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          network_slug TEXT NOT NULL CHECK (network_slug IN ('telegram', 'whatsapp')),
          external_account_id TEXT,
          display_name TEXT,
          status TEXT NOT NULL CHECK (status IN ('setup_required', 'connecting', 'connected', 'disconnected', 'error')),
          status_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.execute(legacyKysely);
      await legacyKysely
        .insertInto("messaging_accounts")
        .values([
          {
            id: "acct_legacy_old",
            owner_id: ownerId,
            network_slug: "whatsapp",
            external_account_id: null,
            display_name: "Old WhatsApp Device",
            status: "connected",
            status_reason: null,
            created_at: "2026-05-13T00:00:00.000Z",
            updated_at: "2026-05-13T00:00:00.000Z",
          },
          {
            id: "acct_legacy_new",
            owner_id: ownerId,
            network_slug: "whatsapp",
            external_account_id: null,
            display_name: "Current WhatsApp Device",
            status: "connected",
            status_reason: null,
            created_at: "2026-05-14T00:00:00.000Z",
            updated_at: "2026-05-14T00:00:00.000Z",
          },
        ])
        .execute();

      const legacyRepository = new MessagingKyselyRepository(legacyKysely);
      await legacyRepository.bootstrap();

      await expect(legacyKysely
        .selectFrom("messaging_accounts")
        .select(["id", "display_name"])
        .where("owner_id", "=", ownerId)
        .where("network_slug", "=", "whatsapp")
        .where("external_account_id", "is", null)
        .execute()).resolves.toEqual([
        { id: "acct_legacy_new", display_name: "Current WhatsApp Device" },
      ]);
    } finally {
      await legacyKysely.destroy();
    }
  });

  it("upserts conversations and bridge-local mappings by canonical external thread", async () => {
    const account = await linkTestAccount(repository, { ownerId, loginId: "wa_1", displayName: "Personal WhatsApp" });

    const conversation = await repository.upsertConversation({
      ownerId,
      roomId: "!room:matrixos.local",
      networkSlug: "whatsapp",
      accountId: account.id,
      displayName: "Family",
      lastEventAt: "2026-05-13T00:00:00.000Z",
    });
    const mapping = await repository.upsertConversationMapping({
      ownerId,
      networkSlug: "whatsapp",
      accountId: account.id,
      roomId: conversation.roomId,
      externalThreadId: "wa_thread_1",
      authoritative: true,
    });
    const duplicate = await repository.upsertConversationMapping({
      ownerId,
      networkSlug: "whatsapp",
      accountId: account.id,
      roomId: conversation.roomId,
      externalThreadId: "wa_thread_1",
      authoritative: true,
    });

    expect(duplicate.id).toBe(mapping.id);
    await expect(repository.getMappingByExternalThread({
      ownerId,
      networkSlug: "whatsapp",
      accountId: account.id,
      externalThreadId: "wa_thread_1",
    })).resolves.toMatchObject({ id: mapping.id, roomId: conversation.roomId });
    await expect(repository.listConversations({ ownerId })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: conversation.id, displayName: "Family" })],
    });
  });

  it("lists both draft and approval-required replies", async () => {
    const roomId = "!room:matrixos.local";
    await repository.createReply({
      ownerId,
      roomId,
      source: "hermes",
      status: "draft",
      body: "Draft body",
      permissionRevision: 1,
      clientTxnId: "txn_draft",
    });
    await repository.createReply({
      ownerId,
      roomId,
      source: "hermes",
      status: "approval_required",
      body: "Approval body",
      permissionRevision: 1,
      clientTxnId: "txn_approval",
    });

    await expect(repository.listDrafts({ ownerId })).resolves.toMatchObject({
      items: [
        expect.objectContaining({ status: "approval_required" }),
        expect.objectContaining({ status: "draft" }),
      ],
    });
  });

  it("moves approved replies to sending without fabricating a Matrix event id", async () => {
    const roomId = "!room:matrixos.local";
    const account = await linkTestAccount(repository, { ownerId, loginId: "wa_reply", displayName: "Personal WhatsApp" });
    await repository.upsertConversation({
      ownerId,
      roomId,
      networkSlug: "whatsapp",
      accountId: account.id,
      displayName: "Family",
    });
    const permission = await repository.updatePermission({
      ownerId,
      roomId,
      baseRevision: 1,
      readEnabled: true,
      replyEnabled: true,
      automationEnabled: false,
      mentionOnly: false,
      grantedBy: ownerId,
    });
    const reply = await repository.createReply({
      ownerId,
      roomId,
      source: "hermes",
      status: "approval_required",
      body: "Approved body",
      permissionRevision: permission.revision,
      clientTxnId: "txn_approved",
    });

    await expect(repository.approveReply({
      ownerId,
      replyId: reply.id,
      baseStatus: "approval_required",
    })).resolves.toMatchObject({
      replyId: reply.id,
      status: "sending",
      matrixEventId: undefined,
    });
  });

});
