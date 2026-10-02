import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { SlackDatabase } from "./database.js";
import type { SlackChannelBinding, SlackEmployeeLink, SlackInstallation, SlackReplyDestination } from "./types.js";

export class SlackRepositoryError extends Error {
  constructor(public readonly code: "conflict" | "expired" | "forbidden" | "capacity") { super("Slack request unavailable"); this.name = "SlackRepositoryError"; }
}
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const STATE_LIFETIME_MS = 10 * 60_000;
export type SlackReceiptKey = { appId: string; teamId: string; eventId: string };
export type SlackReceiptClaim = { outcome: "claimed"; leaseToken: string } | { outcome: "completed" } | { outcome: "busy" } | { outcome: "conflict" };
function installation(row: SlackDatabase["slack_installations"]): SlackInstallation {
  return { appId: row.app_id, teamId: row.team_id, organizationId: row.organization_id, installedBy: row.installed_by,
    botUserId: row.bot_user_id, encryptedBotToken: row.encrypted_bot_token, generation: row.generation, state: row.state };
}

export class SlackRepository {
  private readonly now: () => Date;
  constructor(private readonly db: Kysely<SlackDatabase>, options: { now?: () => Date } = {}) { this.now = options.now ?? (() => new Date()); }

  async getInstallation(appId: string, teamId: string): Promise<SlackInstallation | null> {
    const row = await this.db.selectFrom("slack_installations").selectAll().where("app_id", "=", appId).where("team_id", "=", teamId).executeTakeFirst();
    return row ? installation(row) : null;
  }
  async saveInstallation(input: Omit<SlackInstallation, "generation" | "state">, options: { oauthStateHash?: string } = {}): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`slack-install:${input.appId}`}))`.execute(trx);
      if (options.oauthStateHash !== undefined) {
        // The consumed state remains a durable installation permit until this transaction closes it.
        // Uninstall removes the same permit under this lock, including callbacks waiting on Slack.
        const permit = await trx.deleteFrom("slack_oauth_states").where("hash", "=", options.oauthStateHash)
          .where("app_id", "=", input.appId).where("organization_id", "=", input.organizationId).where("actor_id", "=", input.installedBy)
          .where("consumed_at", "is not", null).where("expires_at", ">", this.now()).returning("hash").executeTakeFirst();
        if (!permit) throw new SlackRepositoryError("conflict");
      }
      const saved = await trx.insertInto("slack_installations").values({ app_id: input.appId, team_id: input.teamId,
        organization_id: input.organizationId, installed_by: input.installedBy, bot_user_id: input.botUserId,
        encrypted_bot_token: input.encryptedBotToken, generation: 1, state: "active", updated_at: this.now() })
        .onConflict((oc) => oc.columns(["app_id", "team_id"]).doUpdateSet({ bot_user_id: input.botUserId,
          encrypted_bot_token: input.encryptedBotToken, installed_by: input.installedBy, state: "active", updated_at: this.now(),
          generation: sql<number>`slack_installations.generation + 1` }).where("slack_installations.organization_id", "=", input.organizationId))
        .returning("team_id").executeTakeFirst();
      if (!saved) throw new SlackRepositoryError("conflict");
    });
  }
  async revokeInstallation(appId: string, teamId: string, options: { source?: "webhook" | "administrator" } = {}): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`slack-install:${appId}`}))`.execute(trx);
      const installed = await trx.selectFrom("slack_installations").select(["organization_id", "state"]).where("app_id", "=", appId).where("team_id", "=", teamId).executeTakeFirst();
      if (!installed) {
        // Without a recorded team/org, cancellation conservatively closes every pending app permit.
        await trx.deleteFrom("slack_oauth_states").where("app_id", "=", appId).execute();
        return;
      }
      // Duplicate provider revocations must not cancel a new reinstall attempt.
      // An explicit authorized administrator removal must cancel it, even after uninstall.
      if (installed.state === "revoked" && options.source !== "administrator") return;
      await trx.updateTable("slack_installations").set({ state: "revoked", encrypted_bot_token: "", generation: sql<number>`generation + 1`, updated_at: this.now() })
        .where("app_id", "=", appId).where("team_id", "=", teamId).where("state", "=", "active").execute();
      for (const table of ["slack_employee_links", "slack_channel_bindings", "slack_link_challenges"] as const) {
        await trx.deleteFrom(table).where("app_id", "=", appId).where("team_id", "=", teamId).execute();
      }
      // A native OAuth start has no team identity until exchange, so revoke app/org permits conservatively.
      await trx.deleteFrom("slack_oauth_states").where("app_id", "=", appId).where("organization_id", "=", installed.organization_id).execute();
    });
  }
  async createOAuthState(input: { hash: string; appId: string; actorId: string; organizationId: string }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`slack-oauth:${input.actorId}`}))`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`slack-install:${input.appId}`}))`.execute(trx);
      const count = await trx.selectFrom("slack_oauth_states").select((eb) => eb.fn.countAll<number>().as("count"))
        .where("actor_id", "=", input.actorId).where("expires_at", ">", this.now()).where("consumed_at", "is", null).executeTakeFirstOrThrow();
      if (Number(count.count) >= 20) throw new SlackRepositoryError("capacity");
      await trx.insertInto("slack_oauth_states").values({ hash: input.hash, app_id: input.appId, actor_id: input.actorId, organization_id: input.organizationId,
        expires_at: new Date(this.now().getTime() + STATE_LIFETIME_MS), consumed_at: null }).execute();
    });
  }
  async getOAuthState(hash: string): Promise<{ appId: string; actorId: string; organizationId: string } | null> {
    const row = await this.db.selectFrom("slack_oauth_states").selectAll().where("hash", "=", hash)
      .where("app_id", "!=", "").where("expires_at", ">", this.now()).where("consumed_at", "is", null).executeTakeFirst();
    return row ? { appId: row.app_id, actorId: row.actor_id, organizationId: row.organization_id } : null;
  }
  async consumeOAuthState(hash: string, actorId: string): Promise<void> {
    const row = await this.db.updateTable("slack_oauth_states").set({ consumed_at: this.now() }).where("hash", "=", hash)
      .where("actor_id", "=", actorId).where("expires_at", ">", this.now()).where("consumed_at", "is", null).returning("hash").executeTakeFirst();
    if (!row) throw new SlackRepositoryError("conflict");
  }
  async createChallenge(input: { hash: string; appId: string; teamId: string; slackUserId: string }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const installed = await trx.selectFrom("slack_installations").selectAll().where("app_id", "=", input.appId).where("team_id", "=", input.teamId).forUpdate().executeTakeFirst();
      if (!installed || installed.state !== "active") throw new SlackRepositoryError("forbidden");
      const existing = await trx.selectFrom("slack_link_challenges").selectAll().where("hash", "=", input.hash).executeTakeFirst();
      if (existing) {
        if (existing.app_id !== input.appId || existing.team_id !== input.teamId || existing.slack_user_id !== input.slackUserId) throw new SlackRepositoryError("conflict");
        if (existing.consumed_at || new Date(existing.expires_at).getTime() <= this.now().getTime()) throw new SlackRepositoryError("expired");
        return;
      }
      const count = await trx.selectFrom("slack_link_challenges").select((eb) => eb.fn.countAll<number>().as("count"))
        .where("app_id", "=", input.appId).where("team_id", "=", input.teamId).where("slack_user_id", "=", input.slackUserId)
        .where("expires_at", ">", this.now()).where("consumed_at", "is", null).executeTakeFirstOrThrow();
      if (Number(count.count) >= 10) throw new SlackRepositoryError("capacity");
      await trx.insertInto("slack_link_challenges").values({ hash: input.hash, app_id: input.appId, team_id: input.teamId,
        slack_user_id: input.slackUserId, expires_at: new Date(this.now().getTime() + STATE_LIFETIME_MS), consumed_at: null }).execute();
    });
  }
  async getChallenge(hash: string): Promise<{ appId: string; teamId: string; slackUserId: string } | null> {
    const row = await this.db.selectFrom("slack_link_challenges").selectAll().where("hash", "=", hash)
      .where("expires_at", ">", this.now()).where("consumed_at", "is", null).executeTakeFirst();
    return row ? { appId: row.app_id, teamId: row.team_id, slackUserId: row.slack_user_id } : null;
  }
  async completeLink(input: { hash: string; actorId: string; organizationId: string }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const preview = await trx.selectFrom("slack_link_challenges").selectAll().where("hash", "=", input.hash).executeTakeFirst();
      if (!preview) throw new SlackRepositoryError("conflict");
      // Match installation-first lock ordering in challenge creation and uninstall.
      const installed = await trx.selectFrom("slack_installations").selectAll().where("app_id", "=", preview.app_id).where("team_id", "=", preview.team_id).forUpdate().executeTakeFirst();
      if (!installed || installed.state !== "active" || installed.organization_id !== input.organizationId) throw new SlackRepositoryError("forbidden");
      const challenge = await trx.selectFrom("slack_link_challenges").selectAll().where("hash", "=", input.hash).forUpdate().executeTakeFirst();
      if (!challenge || challenge.consumed_at || new Date(challenge.expires_at).getTime() <= this.now().getTime()) throw new SlackRepositoryError("conflict");
      const current = await trx.selectFrom("slack_employee_links").selectAll().where("app_id", "=", challenge.app_id).where("team_id", "=", challenge.team_id)
        .where((eb) => eb.or([eb("slack_user_id", "=", challenge.slack_user_id), eb("actor_id", "=", input.actorId)])).execute();
      if (current.some((row) => row.actor_id !== input.actorId || row.slack_user_id !== challenge.slack_user_id)) throw new SlackRepositoryError("conflict");
      await trx.insertInto("slack_employee_links").values({ app_id: challenge.app_id, team_id: challenge.team_id,
        slack_user_id: challenge.slack_user_id, actor_id: input.actorId, organization_id: input.organizationId, created_at: this.now() })
        .onConflict((oc) => oc.columns(["app_id", "team_id", "slack_user_id"]).doNothing()).execute();
      await trx.updateTable("slack_link_challenges").set({ consumed_at: this.now() }).where("hash", "=", input.hash).execute();
    });
  }
  async getLink(appId: string, teamId: string, slackUserId: string): Promise<SlackEmployeeLink | null> {
    const row = await this.db.selectFrom("slack_employee_links").selectAll().where("app_id", "=", appId).where("team_id", "=", teamId).where("slack_user_id", "=", slackUserId).executeTakeFirst();
    return row ? { appId, teamId, slackUserId, actorId: row.actor_id, organizationId: row.organization_id } : null;
  }
  async removeLink(appId: string, teamId: string, actorId: string): Promise<void> {
    await this.db.deleteFrom("slack_employee_links").where("app_id", "=", appId).where("team_id", "=", teamId).where("actor_id", "=", actorId).execute();
  }
  async saveChannelBinding(input: SlackChannelBinding, options: { expectedInstallationGeneration?: number } = {}): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const installed = await trx.selectFrom("slack_installations").selectAll().where("app_id", "=", input.appId).where("team_id", "=", input.teamId).forUpdate().executeTakeFirst();
      if (!installed || installed.state !== "active" || installed.organization_id !== input.organizationId
        || (options.expectedInstallationGeneration !== undefined && installed.generation !== options.expectedInstallationGeneration)) throw new SlackRepositoryError("forbidden");
      await trx.insertInto("slack_channel_bindings").values({ app_id: input.appId, team_id: input.teamId, channel_id: input.channelId,
        organization_id: input.organizationId, scope_id: input.scopeId, approved_output: input.approvedOutput, configured_by: input.configuredBy, updated_at: this.now() })
        .onConflict((oc) => oc.columns(["app_id", "team_id", "channel_id"]).doUpdateSet({ scope_id: input.scopeId,
          approved_output: input.approvedOutput, configured_by: input.configuredBy, updated_at: this.now() })).execute();
    });
  }
  async getChannelBinding(appId: string, teamId: string, channelId: string): Promise<SlackChannelBinding | null> {
    const row = await this.db.selectFrom("slack_channel_bindings").selectAll().where("app_id", "=", appId).where("team_id", "=", teamId).where("channel_id", "=", channelId).executeTakeFirst();
    return row ? { appId, teamId, channelId, organizationId: row.organization_id, scopeId: row.scope_id, approvedOutput: row.approved_output, configuredBy: row.configured_by } : null;
  }
  async claimEvent(key: SlackReceiptKey, digest: string): Promise<SlackReceiptClaim> {
    return this.db.transaction().execute(async (trx) => {
      const now = this.now();
      const leaseToken = randomUUID();
      await trx.insertInto("slack_event_receipts").values({ app_id: key.appId, team_id: key.teamId, event_id: key.eventId,
        digest, destination_owner_id: null, actor_id: null, slack_user_id: null, organization_id: null, channel_id: null, thread_ts: null, event_ts: null, scope_id: null, installation_generation: null, state: "pending", lease_token: leaseToken, lease_until: now, expires_at: new Date(now.getTime() + RECEIPT_RETENTION_MS) })
        .onConflict((oc) => oc.columns(["app_id", "team_id", "event_id"]).doNothing()).execute();
      const row = await trx.selectFrom("slack_event_receipts").selectAll().where("app_id", "=", key.appId).where("team_id", "=", key.teamId)
        .where("event_id", "=", key.eventId).forUpdate().executeTakeFirstOrThrow();
      if (row.digest !== digest) return { outcome: "conflict" };
      if (row.state === "completed") return { outcome: "completed" };
      if (new Date(row.lease_until).getTime() > now.getTime()) return { outcome: "busy" };
      await trx.updateTable("slack_event_receipts").set({ lease_token: leaseToken, lease_until: new Date(now.getTime() + 5_000) })
        .where("app_id", "=", key.appId).where("team_id", "=", key.teamId).where("event_id", "=", key.eventId).execute();
      return { outcome: "claimed", leaseToken };
    });
  }
  async settleEvent(key: SlackReceiptKey, leaseToken: string, completed: boolean): Promise<void> {
    await this.db.updateTable("slack_event_receipts").set({ state: completed ? "completed" : "pending", lease_until: this.now() })
      .where("app_id", "=", key.appId).where("team_id", "=", key.teamId).where("event_id", "=", key.eventId).where("lease_token", "=", leaseToken).execute();
  }
  async recordDestination(key: SlackReceiptKey, leaseToken: string, destination: Omit<SlackReplyDestination, "appId" | "teamId" | "eventId">): Promise<void> {
    const row = await this.db.updateTable("slack_event_receipts").set({ destination_owner_id: destination.ownerId,
      actor_id: destination.actorId, slack_user_id: destination.slackUserId, organization_id: destination.organizationId,
      channel_id: destination.channelId, thread_ts: destination.threadTs, event_ts: destination.eventTs ?? null, scope_id: destination.scopeId,
      installation_generation: destination.installationGeneration }).where("app_id", "=", key.appId).where("team_id", "=", key.teamId)
      .where("event_id", "=", key.eventId).where("lease_token", "=", leaseToken).where("state", "=", "pending").returning("event_id").executeTakeFirst();
    if (!row) throw new SlackRepositoryError("conflict");
  }
  async getReplyDestination(key: SlackReceiptKey): Promise<SlackReplyDestination | null> {
    const row = await this.db.selectFrom("slack_event_receipts").selectAll().where("app_id", "=", key.appId).where("team_id", "=", key.teamId)
      .where("event_id", "=", key.eventId).where("state", "=", "completed").where("expires_at", ">", this.now()).executeTakeFirst();
    if (!row?.destination_owner_id || !row.actor_id || !row.slack_user_id || !row.organization_id || !row.channel_id || !row.thread_ts || !row.installation_generation) return null;
    return { ...key, ownerId: row.destination_owner_id, actorId: row.actor_id, slackUserId: row.slack_user_id, organizationId: row.organization_id,
      channelId: row.channel_id, threadTs: row.thread_ts, ...(row.event_ts ? { eventTs: row.event_ts } : {}), scopeId: row.scope_id, installationGeneration: row.installation_generation };
  }
  async claimReply(key: SlackReceiptKey, digest: string): Promise<"claimed" | "sent" | "conflict" | "unknown"> {
    return this.db.transaction().execute(async (trx) => {
      const receipt = await trx.selectFrom("slack_event_receipts").selectAll().where("app_id", "=", key.appId).where("team_id", "=", key.teamId)
        .where("event_id", "=", key.eventId).forUpdate().executeTakeFirst();
      if (!receipt || receipt.state !== "completed" || new Date(receipt.expires_at).getTime() <= this.now().getTime()) throw new SlackRepositoryError("forbidden");
      const inserted = await trx.insertInto("slack_reply_intents").values({ app_id: key.appId, team_id: key.teamId, event_id: key.eventId,
        digest, state: "prepared", delivery_ts: null, expires_at: new Date(this.now().getTime() + RECEIPT_RETENTION_MS) })
        .onConflict((oc) => oc.columns(["app_id", "team_id", "event_id"]).doNothing()).returning("event_id").executeTakeFirst();
      if (inserted) return "claimed";
      const existing = await trx.selectFrom("slack_reply_intents").selectAll().where("app_id", "=", key.appId).where("team_id", "=", key.teamId).where("event_id", "=", key.eventId).executeTakeFirstOrThrow();
      if (existing.digest !== digest) return "conflict";
      return existing.state === "sent" ? "sent" : "unknown";
    });
  }
  async getSentReply(key: SlackReceiptKey): Promise<string | null> {
    const row = await this.db.selectFrom("slack_reply_intents").select("delivery_ts").where("app_id", "=", key.appId)
      .where("team_id", "=", key.teamId).where("event_id", "=", key.eventId).where("state", "=", "sent").executeTakeFirst();
    return row?.delivery_ts ?? null;
  }
  async settleReply(key: SlackReceiptKey, ts: string | null): Promise<void> {
    await this.db.updateTable("slack_reply_intents").set({ state: ts ? "sent" : "unknown", delivery_ts: ts })
      .where("app_id", "=", key.appId).where("team_id", "=", key.teamId).where("event_id", "=", key.eventId).where("state", "=", "prepared").execute();
  }
  /** The fixed bot/channel/event-ts/eyes identity is idempotent upstream, so prepared/unknown may retry under fresh authority. */
  async prepareReaction(key: SlackReceiptKey): Promise<"prepared" | "sent"> {
    const row = await this.db.insertInto("slack_reaction_intents").values({ app_id: key.appId, team_id: key.teamId, event_id: key.eventId, state: "prepared" })
      .onConflict((oc) => oc.columns(["app_id", "team_id", "event_id"]).doUpdateSet({ state: "prepared" }).where("slack_reaction_intents.state", "!=", "sent"))
      .returning("state").executeTakeFirst();
    return row ? "prepared" : "sent";
  }
  async settleReaction(key: SlackReceiptKey, sent: boolean): Promise<void> {
    await this.db.updateTable("slack_reaction_intents").set({ state: sent ? "sent" : "unknown" }).where("app_id", "=", key.appId)
      .where("team_id", "=", key.teamId).where("event_id", "=", key.eventId).where("state", "!=", "sent").execute();
  }
  /** Bounded recurring sweep: never buffer deleted records/content in memory. */
  async cleanup(): Promise<void> {
    for (const table of ["slack_oauth_states", "slack_link_challenges", "slack_event_receipts"] as const) {
      await sql`DELETE FROM ${sql.table(table)} WHERE ctid IN (SELECT ctid FROM ${sql.table(table)} WHERE expires_at < ${this.now()} LIMIT 1000)`.execute(this.db);
    }
  }
}
