import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type {
  CreateInternalTicketInput,
  ExternalTicketInput,
  TicketListPage,
  TicketListQuery,
  TicketSourceKind,
  TrackedTicket,
  UpdateTicketInput,
} from "./contracts.js";

export interface TicketRepository {
  bootstrap(): Promise<void>;
  createInternalTicket(ownerId: string, projectSlug: string, input: CreateInternalTicketInput): Promise<TrackedTicket>;
  upsertExternalTicket(ownerId: string, projectSlug: string, input: ExternalTicketInput): Promise<TrackedTicket>;
  findBySource(ownerId: string, projectSlug: string, sourceKind: TicketSourceKind, sourceId: string): Promise<TrackedTicket | null>;
  listTickets(ownerId: string, projectSlug: string, query: TicketListQuery): Promise<TicketListPage>;
  updateTicket(ownerId: string, projectSlug: string, ticketId: string, input: UpdateTicketInput): Promise<TrackedTicket | null>;
}

function rowJson<T>(row: Record<string, unknown>, key: string): T {
  const value = row[key];
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function ticketFromRow(row: Record<string, unknown>): TrackedTicket {
  return rowJson<TrackedTicket>(row, "ticket");
}

function ticketId(): string {
  return `ticket_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function ticketsEqual(a: TrackedTicket, b: Omit<TrackedTicket, "id" | "revision" | "createdAt" | "updatedAt" | "archivedAt" | "deletedAt">): boolean {
  return a.title === b.title &&
    a.description === b.description &&
    a.status === b.status &&
    a.priority === b.priority &&
    a.sourceUrl === b.sourceUrl &&
    JSON.stringify(a.assigneeIds) === JSON.stringify(b.assigneeIds) &&
    JSON.stringify(a.labelIds) === JSON.stringify(b.labelIds) &&
    JSON.stringify(a.dependencyIds) === JSON.stringify(b.dependencyIds) &&
    JSON.stringify(a.artifactIds) === JSON.stringify(b.artifactIds);
}

export class KyselyTicketRepository implements TicketRepository {
  constructor(
    private readonly db: Kysely<any>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS tracked_tickets (
        id text PRIMARY KEY,
        owner_id text NOT NULL,
        project_slug text NOT NULL,
        source_kind text NOT NULL,
        source_id text NOT NULL,
        status text NOT NULL,
        revision integer NOT NULL,
        ticket jsonb NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        archived_at timestamptz,
        deleted_at timestamptz
      )
    `.execute(this.db);
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_tickets_source_identity
      ON tracked_tickets (owner_id, project_slug, source_kind, source_id)
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_tracked_tickets_project_status
      ON tracked_tickets (owner_id, project_slug, status, updated_at DESC)
    `.execute(this.db);
  }

  async createInternalTicket(ownerId: string, projectSlug: string, input: CreateInternalTicketInput): Promise<TrackedTicket> {
    return this.db.transaction().execute(async (trx) => {
      const countRow = await trx
        .selectFrom("tracked_tickets")
        .select(({ fn }) => fn.count<number>("id").as("count"))
        .where("owner_id", "=", ownerId)
        .where("project_slug", "=", projectSlug)
        .where("source_kind", "=", "matrix")
        .executeTakeFirst();
      const timestamp = this.now();
      const id = ticketId();
      const ticket: TrackedTicket = {
        id,
        projectSlug,
        sourceKind: "matrix",
        sourceId: id,
        identifier: `MAT-${Number(countRow?.count ?? 0) + 1}`,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assigneeIds: input.assigneeIds,
        labelIds: input.labelIds,
        dependencyIds: input.dependencyIds,
        artifactIds: input.artifactIds,
        syncStatus: "local",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        deletedAt: null,
      };
      await trx.insertInto("tracked_tickets").values({
        id,
        owner_id: ownerId,
        project_slug: projectSlug,
        source_kind: "matrix",
        source_id: id,
        status: ticket.status,
        revision: ticket.revision,
        ticket: JSON.stringify(ticket),
      }).execute();
      return ticket;
    });
  }

  async findBySource(ownerId: string, projectSlug: string, sourceKind: TicketSourceKind, sourceId: string): Promise<TrackedTicket | null> {
    const row = await this.db
      .selectFrom("tracked_tickets")
      .select(["ticket"])
      .where("owner_id", "=", ownerId)
      .where("project_slug", "=", projectSlug)
      .where("source_kind", "=", sourceKind)
      .where("source_id", "=", sourceId)
      .where("deleted_at", "is", null)
      .executeTakeFirst() as Record<string, unknown> | undefined;
    return row ? ticketFromRow(row) : null;
  }

  async upsertExternalTicket(ownerId: string, projectSlug: string, input: ExternalTicketInput): Promise<TrackedTicket> {
    const existing = await this.findBySource(ownerId, projectSlug, input.sourceKind, input.sourceId);
    const timestamp = this.now();
    if (existing) {
      const comparable = {
        projectSlug,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        sourceUrl: input.sourceUrl,
        identifier: input.identifier,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assigneeIds: input.assigneeIds,
        labelIds: input.labelIds,
        dependencyIds: input.dependencyIds,
        artifactIds: input.artifactIds,
        syncStatus: "synced" as const,
      };
      if (ticketsEqual(existing, comparable) && existing.identifier === input.identifier && existing.syncStatus === "synced") {
        return existing;
      }
      const ticket: TrackedTicket = {
        ...existing,
        ...comparable,
        revision: existing.revision + 1,
        updatedAt: timestamp,
      };
      const row = await this.db
        .updateTable("tracked_tickets")
        .set({
          status: ticket.status,
          revision: ticket.revision,
          ticket: JSON.stringify(ticket),
          updated_at: sql`now()`,
        })
        .where("id", "=", existing.id)
        .where("revision", "=", existing.revision)
        .where("deleted_at", "is", null)
        .returning(["ticket"])
        .executeTakeFirst() as Record<string, unknown> | undefined;
      return row ? ticketFromRow(row) : ticket;
    }

    const id = ticketId();
    const ticket: TrackedTicket = {
      id,
      projectSlug,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      identifier: input.identifier,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      assigneeIds: input.assigneeIds,
      labelIds: input.labelIds,
      dependencyIds: input.dependencyIds,
      artifactIds: input.artifactIds,
      syncStatus: "synced",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      deletedAt: null,
    };
    await this.db.insertInto("tracked_tickets").values({
      id,
      owner_id: ownerId,
      project_slug: projectSlug,
      source_kind: input.sourceKind,
      source_id: input.sourceId,
      status: ticket.status,
      revision: ticket.revision,
      ticket: JSON.stringify(ticket),
    }).onConflict((oc) => oc
      .columns(["owner_id", "project_slug", "source_kind", "source_id"])
      .doNothing()
    ).execute();
    return await this.findBySource(ownerId, projectSlug, input.sourceKind, input.sourceId) ?? ticket;
  }

  async listTickets(ownerId: string, projectSlug: string, query: TicketListQuery): Promise<TicketListPage> {
    let builder = this.db
      .selectFrom("tracked_tickets")
      .select(["ticket", "updated_at"])
      .where("owner_id", "=", ownerId)
      .where("project_slug", "=", projectSlug)
      .where("deleted_at", "is", null);
    if (!query.includeArchived) builder = builder.where("archived_at", "is", null);
    if (query.source !== "all") builder = builder.where("source_kind", "=", query.source);
    if (query.status) builder = builder.where("status", "=", query.status);
    const rows = await builder
      .orderBy("updated_at", "desc")
      .limit(query.limit)
      .execute() as Record<string, unknown>[];
    const tickets = rows.map(ticketFromRow)
      .filter((ticket) => !query.assigneeId || ticket.assigneeIds.includes(query.assigneeId));
    return { tickets, nextCursor: null };
  }

  async updateTicket(ownerId: string, projectSlug: string, ticketIdValue: string, input: UpdateTicketInput): Promise<TrackedTicket | null> {
    const existingRow = await this.db
      .selectFrom("tracked_tickets")
      .select(["ticket"])
      .where("owner_id", "=", ownerId)
      .where("project_slug", "=", projectSlug)
      .where("id", "=", ticketIdValue)
      .where("deleted_at", "is", null)
      .executeTakeFirst() as Record<string, unknown> | undefined;
    if (!existingRow) return null;
    const existing = ticketFromRow(existingRow);
    const timestamp = this.now();
    const ticket: TrackedTicket = {
      ...existing,
      ...input.patch,
      revision: existing.revision + 1,
      syncStatus: existing.sourceKind === "linear" ? "pending" : existing.syncStatus,
      updatedAt: timestamp,
    };
    const row = await this.db
      .updateTable("tracked_tickets")
      .set({
        status: ticket.status,
        revision: ticket.revision,
        ticket: JSON.stringify(ticket),
        updated_at: sql`now()`,
      })
      .where("owner_id", "=", ownerId)
      .where("project_slug", "=", projectSlug)
      .where("id", "=", ticketIdValue)
      .where("revision", "=", input.baseRevision)
      .where("deleted_at", "is", null)
      .returning(["ticket"])
      .executeTakeFirst() as Record<string, unknown> | undefined;
    return row ? ticketFromRow(row) : null;
  }
}
