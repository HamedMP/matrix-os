import { CollaborationDirectoryEventSchema } from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import { requireSecureCollaborationPlatformBaseUrl } from "./platform-base-url.js";

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
/**
 * How long a claimed final attempt holds back its scope's later events. A batch sends at most
 * BATCH_SIZE events one after another, each bounded by REQUEST_TIMEOUT_MS, so an attempt still
 * unsettled after this long cannot be running any more (its worker died).
 */
const FINAL_ATTEMPT_HOLD_MS = 15 * 60_000;
/** `retry_after` of an event that will never be sent again: it holds nothing back. */
const EXHAUSTED_AT = new Date(0).toISOString();

interface ClaimedDirectoryEvent {
  eventId: string;
  scopeId: string;
  ownerId: string;
  kind: "chat" | "terminal" | "project" | "file" | "folder" | "app";
  authorityGeneration: number;
  metadataRevision: number;
  /** `status` overrides the event's discovery state for one recipient (a pending member grant). */
  recipientEntries: Array<{ actorId: string; invitationId?: string; grantId?: string; status?: "invited" }>;
  discoveryState: "invited" | "accepted" | "revoked" | "deleted";
  /** S05: read inside the claim transaction so a lookup failure leaves the event unclaimed and retryable. */
  organizationId: string | null;
  /** S06: `organization` when an active organization-wide grant exists; read inside the same claim transaction. */
  audience: "organization" | null;
  organizationGrantId: string | null;
  attempt: number;
}

export class CollaborationDirectoryOutbox {
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<number>;
  private closing = false;

  constructor(private readonly options: {
    db: Kysely<OwnerCollaborationDatabase>;
    platformBaseUrl: string;
    runtimeId: string;
    serviceToken: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    startTimer?: boolean;
  }) {
    const baseUrl = requireSecureCollaborationPlatformBaseUrl(options.platformBaseUrl);
    if (Buffer.byteLength(options.serviceToken) < 32) {
      throw new Error("Collaboration directory service token is unavailable");
    }
    this.endpoint = `${baseUrl.origin}/internal/collaboration/directory`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    if (options.startTimer !== false) {
      this.timer = setInterval(() => {
        void this.runOnce().catch((error: unknown) => {
          console.warn("[collaboration-directory] delivery cycle failed", error instanceof Error ? error.name : "UnknownError");
        });
      }, POLL_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  async runOnce(): Promise<number> {
    if (this.closing) return 0;
    if (this.active) return this.active;
    const active = this.deliverBatch();
    this.active = active;
    try {
      return await active;
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active) await this.active;
  }

  private async deliverBatch(): Promise<number> {
    const claimed = await this.claimBatch();
    let delivered = 0;
    for (const event of claimed) {
      // S05/S06: both resolved inside the claim transaction; a failed lookup leaves the event unclaimed.
      const organizationId = event.organizationId;
      const audience = event.audience;
      const payload = CollaborationDirectoryEventSchema.parse({
        eventId: event.eventId,
        scopeId: event.scopeId,
        runtimeId: this.options.runtimeId,
        ownerId: event.ownerId,
        kind: event.kind,
        ...(organizationId ? { organizationId } : {}),
        ...(audience ? { audience } : {}),
        ...(event.organizationGrantId ? { organizationGrantId: event.organizationGrantId } : {}),
        authorityGeneration: event.authorityGeneration,
        metadataRevision: event.metadataRevision,
        recipients: event.recipientEntries.map((recipient) => ({
          ...recipient,
          status: recipient.status ?? (event.discoveryState === "deleted" ? "revoked" : event.discoveryState),
        })),
      });
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "PUT",
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.options.serviceToken}`,
            "content-type": "application/json",
            "x-matrix-runtime-id": this.options.runtimeId,
          },
          body: JSON.stringify(payload),
        });
        await response.body?.cancel();
        if (!response.ok) {
          console.warn("[collaboration-directory] platform rejected event", response.status);
          await this.settleFailedAttempt(event);
          continue;
        }
        const result = await this.options.db.updateTable("collaboration_directory_outbox").set({
          delivered_at: this.now().toISOString(),
        }).where("event_id", "=", event.eventId)
          .where("attempts", "=", event.attempt)
          .where("delivered_at", "is", null)
          .returning("event_id")
          .executeTakeFirst();
        if (result) delivered += 1;
      } catch (error: unknown) {
        console.warn("[collaboration-directory] platform unavailable", error instanceof Error ? error.name : "UnknownError");
        await this.settleFailedAttempt(event);
      }
    }
    return delivered;
  }

  /** A failed final attempt will never be retried: mark it so it stops holding back its scope. */
  private async settleFailedAttempt(event: ClaimedDirectoryEvent): Promise<void> {
    if (event.attempt < MAX_ATTEMPTS) return;
    try {
      await this.options.db.updateTable("collaboration_directory_outbox").set({ retry_after: EXHAUSTED_AT })
        .where("event_id", "=", event.eventId)
        .where("attempts", "=", event.attempt)
        .where("delivered_at", "is", null)
        .execute();
    } catch (error: unknown) {
      // Left unsettled, the event still stops holding its scope once FINAL_ATTEMPT_HOLD_MS passes.
      console.warn("[collaboration-directory] exhausted event not settled", error instanceof Error ? error.name : "UnknownError");
    }
  }

  private async claimBatch(): Promise<ClaimedDirectoryEvent[]> {
    const now = this.now();
    return this.options.db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom("collaboration_directory_outbox as outbox")
        .innerJoin("collaboration_scopes as scope", "scope.id", "outbox.scope_id")
        .innerJoin("collaboration_events as event", "event.event_id", "outbox.event_id")
        .select([
          "outbox.event_id",
          "outbox.scope_id",
          "outbox.recipient_actor_ids",
          "outbox.authority_generation",
          "outbox.resource_kind",
          "outbox.discovery_state",
          "outbox.attempts",
          "scope.owner_id",
          "scope.organization_id",
          "event.revision",
          (eb) => eb.selectFrom("collaboration_grants as grant").select("grant.id")
              .whereRef("grant.scope_id", "=", "outbox.scope_id")
              .whereRef("grant.organization_id", "=", "scope.organization_id")
              .where("grant.audience_kind", "=", "organization")
              .where("grant.state", "=", "active")
              .where((eb) => eb.or([
                eb("grant.expires_at", "is", null),
                eb("grant.expires_at", ">", now.toISOString()),
              ]))
              .limit(1).as("organization_grant_id"),
        ])
        .where("outbox.authority_runtime_id", "=", this.options.runtimeId)
        .where("outbox.delivered_at", "is", null)
        .where("outbox.retry_after", "<=", now.toISOString())
        .where("outbox.attempts", "<", MAX_ATTEMPTS)
        // The platform applies a scope's events by revision and drops an older one that arrives
        // late, so each scope delivers strictly in order: an event is claimable only once every
        // earlier event of its scope is delivered or will never be sent again (quarantined, or its
        // final attempt failed), so a final attempt still in flight is never overtaken, across
        // retries and workers.
        .where(({ not, exists, selectFrom }) => not(exists(
          selectFrom("collaboration_directory_outbox as earlier")
            .innerJoin("collaboration_events as earlier_event", "earlier_event.event_id", "earlier.event_id")
            .select("earlier.event_id")
            .whereRef("earlier.scope_id", "=", "outbox.scope_id")
            .whereRef("earlier.authority_runtime_id", "=", "outbox.authority_runtime_id")
            .where("earlier.delivered_at", "is", null)
            .where((eb) => eb.or([
              eb("earlier.attempts", "<", MAX_ATTEMPTS),
              // A final attempt that may still be in flight, however slow its batch.
              eb("earlier.retry_after", ">", new Date(now.getTime() - FINAL_ATTEMPT_HOLD_MS).toISOString()),
            ]))
            .whereRef("earlier_event.scope_seq", "<", "event.scope_seq"),
        )))
        .orderBy("outbox.created_at", "asc")
        .orderBy("event.scope_seq", "asc")
        .limit(BATCH_SIZE)
        .forUpdate("outbox")
        .skipLocked()
        .execute();
      const claimed: ClaimedDirectoryEvent[] = [];
      for (const row of rows) {
        const attempt = Number(row.attempts) + 1;
        const updated = await trx.updateTable("collaboration_directory_outbox").set({
          attempts: attempt,
          retry_after: new Date(now.getTime() + backoffMs(attempt)).toISOString(),
        }).where("event_id", "=", row.event_id)
          .where("attempts", "=", Number(row.attempts))
          .where("delivered_at", "is", null)
          .returning("event_id")
          .executeTakeFirst();
        if (!updated) continue;
        let recipientEntries: ClaimedDirectoryEvent["recipientEntries"];
        try {
          recipientEntries = parseRecipientEntries(row.recipient_actor_ids);
        } catch (error: unknown) {
          console.warn(
            "[collaboration-directory] quarantined malformed outbox event",
            error instanceof Error ? error.name : "UnknownError",
          );
          // Quarantined, never sent: it stops holding back the scope's later events at once.
          await trx.updateTable("collaboration_directory_outbox").set({
            attempts: MAX_ATTEMPTS,
            retry_after: EXHAUSTED_AT,
          }).where("event_id", "=", row.event_id)
            .where("attempts", "=", attempt)
            .where("delivered_at", "is", null)
            .execute();
          continue;
        }
        if (row.discovery_state === "invited" || row.discovery_state === "accepted") {
          recipientEntries = await withPendingMemberGrants(trx, row.scope_id, recipientEntries, row.discovery_state, now);
        }
        claimed.push({
          eventId: row.event_id,
          scopeId: row.scope_id,
          ownerId: row.owner_id,
          kind: row.resource_kind,
          authorityGeneration: Number(row.authority_generation),
          metadataRevision: Number(row.revision),
          recipientEntries,
          discoveryState: row.discovery_state,
          organizationId: row.organization_id ?? null,
          audience: row.organization_grant_id ? "organization" : null,
          organizationGrantId: row.organization_grant_id ?? null,
          attempt,
        });
      }
      return claimed;
    });
  }

}

function parseRecipientEntries(value: unknown): Array<{ actorId: string; invitationId?: string; grantId?: string }> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return CollaborationDirectoryEventSchema.shape.recipients
    .parse((Array.isArray(parsed) ? parsed : []).map((entry) => (
      typeof entry === "string" ? { actorId: entry, status: "accepted" } : { ...entry, status: "accepted" }
    )))
    .map(({ actorId, invitationId, grantId }) => ({
      actorId, ...(invitationId ? { invitationId } : {}), ...(grantId ? { grantId } : {}),
    }));
}

/**
 * The platform keeps one discovery row per actor and scope, so any event about an actor replaces
 * what it last said about them. A member grant the actor has not accepted yet must survive that
 * (an invitation, or its acceptance, for the same project): an actor who still holds a live
 * pending member grant is published as invited with that grant's pointer, exactly as when the
 * grant was created, and opening the share accepts it. Read inside the claim transaction, so the
 * pointer is current at delivery.
 */
async function withPendingMemberGrants(
  trx: Transaction<OwnerCollaborationDatabase>,
  scopeId: string,
  entries: ClaimedDirectoryEvent["recipientEntries"],
  discoveryState: "invited" | "accepted",
  now: Date,
): Promise<ClaimedDirectoryEvent["recipientEntries"]> {
  const candidates = entries.filter((entry) => !entry.grantId).map((entry) => entry.actorId);
  if (candidates.length === 0) return entries;
  const nowIso = now.toISOString();
  const pending = await trx.selectFrom("collaboration_grants as grant")
    .select(["grant.id", "grant.audience_actor_id"])
    .where("grant.scope_id", "=", scopeId)
    .where("grant.audience_kind", "=", "member")
    .where("grant.state", "=", "pending")
    .where("grant.audience_actor_id", "in", candidates)
    .where((eb) => eb.or([eb("grant.expires_at", "is", null), eb("grant.expires_at", ">", nowIso)]))
    .execute();
  if (pending.length === 0) return entries;
  const byActor = new Map(pending.map((grant) => [grant.audience_actor_id!, grant.id]));
  return entries.map((entry) => {
    const grantId = entry.grantId ? undefined : byActor.get(entry.actorId);
    if (!grantId) return entry;
    // An accepted event has settled the invitation it names: only the grant is left to open.
    const { invitationId, ...rest } = entry;
    return { ...(discoveryState === "invited" && invitationId ? { invitationId } : {}), ...rest, grantId, status: "invited" as const };
  });
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * (2 ** Math.min(attempt - 1, 6)));
}
