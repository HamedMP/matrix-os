import { CollaborationDirectoryEventSchema } from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import { requireSecureCollaborationPlatformBaseUrl } from "./platform-base-url.js";

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

interface ClaimedDirectoryEvent {
  eventId: string;
  scopeId: string;
  ownerId: string;
  kind: "chat" | "terminal" | "project";
  authorityGeneration: number;
  metadataRevision: number;
  recipientActorIds: string[];
  discoveryState: "invited" | "accepted" | "revoked" | "deleted";
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
      const payload = CollaborationDirectoryEventSchema.parse({
        eventId: event.eventId,
        scopeId: event.scopeId,
        runtimeId: this.options.runtimeId,
        ownerId: event.ownerId,
        kind: event.kind,
        authorityGeneration: event.authorityGeneration,
        metadataRevision: event.metadataRevision,
        recipients: event.recipientActorIds.map((actorId) => ({
          actorId,
          status: event.discoveryState === "deleted" ? "revoked" : event.discoveryState,
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
      }
    }
    return delivered;
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
          "event.revision",
        ])
        .where("outbox.authority_runtime_id", "=", this.options.runtimeId)
        .where("outbox.delivered_at", "is", null)
        .where("outbox.retry_after", "<=", now.toISOString())
        .where("outbox.attempts", "<", MAX_ATTEMPTS)
        .orderBy("outbox.created_at", "asc")
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
        let recipientActorIds: string[];
        try {
          recipientActorIds = parseActorIds(row.recipient_actor_ids);
        } catch (error: unknown) {
          console.warn(
            "[collaboration-directory] quarantined malformed outbox event",
            error instanceof Error ? error.name : "UnknownError",
          );
          await trx.updateTable("collaboration_directory_outbox").set({
            attempts: MAX_ATTEMPTS,
          }).where("event_id", "=", row.event_id)
            .where("attempts", "=", attempt)
            .where("delivered_at", "is", null)
            .execute();
          continue;
        }
        claimed.push({
          eventId: row.event_id,
          scopeId: row.scope_id,
          ownerId: row.owner_id,
          kind: row.resource_kind,
          authorityGeneration: Number(row.authority_generation),
          metadataRevision: Number(row.revision),
          recipientActorIds,
          discoveryState: row.discovery_state,
          attempt,
        });
      }
      return claimed;
    });
  }
}

function parseActorIds(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return CollaborationDirectoryEventSchema.shape.recipients
    .parse((Array.isArray(parsed) ? parsed : []).map((actorId) => ({ actorId, status: "accepted" })))
    .map(({ actorId }) => actorId);
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * (2 ** Math.min(attempt - 1, 6)));
}
