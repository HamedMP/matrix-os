/**
 * Idempotent application of verified Clerk organization events (S03 / T016).
 *
 * One transaction covers the inbox dedupe row, the organization upsert and
 * the membership change, so a redelivered event is a no-op and a same-id
 * event with a different payload is refused as a conflict. Ended memberships
 * are returned so the control authority can fence them; the webhook alone
 * never produces fresh positive authority (the projection requires upstream
 * verification for that).
 */
import { createHash } from "node:crypto";
import type { OrganizationInboxOutcome } from "./database.js";
import type { EndedMembership, PlatformOrganizationRepository } from "./repository.js";
import type { ClerkOrganizationSourceEvent } from "./roles.js";

export type OrganizationEventOutcome = OrganizationInboxOutcome | "conflict";

export interface OrganizationEventResult {
  outcome: OrganizationEventOutcome;
  membershipEpoch?: number;
  endedMemberships: EndedMembership[];
}

export function hashOrganizationEvent(event: ClerkOrganizationSourceEvent): string {
  return createHash("sha256").update(JSON.stringify({
    type: event.type,
    organization: { ...event.organization, sourceUpdatedAt: event.organization.sourceUpdatedAt.toISOString() },
    membership: event.membership ? { ...event.membership, sourceUpdatedAt: event.membership.sourceUpdatedAt.toISOString() } : null,
  })).digest("hex");
}

export async function applyClerkOrganizationEvent(
  repository: PlatformOrganizationRepository,
  event: ClerkOrganizationSourceEvent,
  options: { payloadHash?: string } = {},
): Promise<OrganizationEventResult> {
  const payloadHash = options.payloadHash ?? hashOrganizationEvent(event);
  return repository.transaction(async (repo) => {
    const inbox = await repo.recordInboxEvent({ eventId: event.eventId, eventType: event.type, payloadHash });
    if (inbox !== "new") return { outcome: inbox, endedMemberships: [] };
    const result = await applyEvent(repo, event);
    await repo.markInboxOutcome(event.eventId, result.outcome === "conflict" ? "failed" : result.outcome);
    return result;
  });
}

async function applyEvent(repo: PlatformOrganizationRepository, event: ClerkOrganizationSourceEvent): Promise<OrganizationEventResult> {
  const organization = await repo.applyOrganization(event.organization);
  if (event.type === "organization.deleted") {
    const ended = await repo.tombstoneAllMemberships(organization.organizationId, event.organization.sourceUpdatedAt);
    const current = await repo.getOrganization(organization.organizationId);
    return { outcome: "applied", membershipEpoch: current?.membershipEpoch, endedMemberships: ended };
  }
  if (!event.membership) {
    const applied = organization.sourceUpdatedAt.getTime() === event.organization.sourceUpdatedAt.getTime();
    return { outcome: applied ? "applied" : "stale", membershipEpoch: organization.membershipEpoch, endedMemberships: [] };
  }
  const result = await repo.applyMembership({
    ...event.membership,
    organizationId: organization.organizationId,
    state: event.type === "organizationMembership.deleted" ? "removed" : "active",
  });
  return {
    outcome: result.outcome,
    membershipEpoch: result.membershipEpoch,
    endedMemberships: result.ended ? [{ organizationId: organization.organizationId, actorId: event.membership.actorId }] : [],
  };
}
