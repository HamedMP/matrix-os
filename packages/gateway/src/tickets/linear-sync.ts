import type { TicketRepository } from "./internal-repository.js";
import type { ExternalTicketInput, TicketSyncSummary } from "./contracts.js";

export interface LinearTicketLike {
  identifier: string;
  externalId: string | null;
  title: string;
  status: string;
  priority: "low" | "medium" | "high" | "urgent";
  assigneeIds: string[];
  labels: string[];
}

function normalizeLinearTicket(ticket: LinearTicketLike): ExternalTicketInput {
  return {
    sourceKind: "linear",
    sourceId: ticket.externalId ?? ticket.identifier,
    identifier: ticket.identifier,
    title: ticket.title,
    description: "",
    status: ticket.status,
    priority: ticket.priority,
    assigneeIds: ticket.assigneeIds,
    labelIds: ticket.labels,
    dependencyIds: [],
    artifactIds: [],
  };
}

export async function syncLinearTickets(
  repository: TicketRepository,
  input: {
    ownerId: string;
    projectSlug: string;
    sourceId: string;
    tickets: LinearTicketLike[];
    truncated: boolean;
  },
): Promise<TicketSyncSummary> {
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const ticket of input.tickets) {
    const normalized = normalizeLinearTicket(ticket);
    const before = await repository.findBySource(input.ownerId, input.projectSlug, "linear", normalized.sourceId);
    const after = await repository.upsertExternalTicket(input.ownerId, input.projectSlug, normalized);
    if (!before) {
      created += 1;
    } else if (after.revision === before.revision) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }

  return { created, updated, unchanged, truncated: input.truncated };
}
