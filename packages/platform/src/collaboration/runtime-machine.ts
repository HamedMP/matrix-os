import type { UserMachineRecord } from "../db.js";

type CollaborationMachine = Pick<UserMachineRecord, "handle" | "status" | "clerkUserId" | "provisioningClass" | "publicIPv4">;

/**
 * A Private Preview must stay reachable by its owner alone (spec 537), so it
 * never joins collaboration. PR code controls its gateway, so this platform
 * check is the boundary rather than any runtime-side flag.
 */
function isCollaborationEligible(machine: CollaborationMachine | undefined, ownerId: string): machine is CollaborationMachine {
  return Boolean(machine
    && machine.status === "running"
    && machine.clerkUserId === ownerId
    && machine.provisioningClass !== "private-preview");
}

/** The relay handle for a registering runtime, or null when it may not collaborate. */
export function collaborationRelayHandle(machine: CollaborationMachine | undefined, ownerId: string): string | null {
  return isCollaborationEligible(machine, ownerId) ? machine.handle : null;
}

/** The direct origin for a collaboration connection, or null when unavailable. */
export function collaborationRuntimeOrigin(machine: CollaborationMachine | undefined, ownerId: string): string | null {
  return isCollaborationEligible(machine, ownerId) && machine.publicIPv4 ? `https://${machine.publicIPv4}:443` : null;
}
