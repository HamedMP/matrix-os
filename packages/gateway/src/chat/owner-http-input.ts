import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";

// Process-private capability: JSON, headers and model arguments cannot construct this key.
const OWNER_HTTP_INPUT = Symbol("authenticated-owner-http-input");
export interface OwnerHttpInputProvenance {
  [OWNER_HTTP_INPUT]?: true;
}

function isAuthenticatedOwner(principal: RequestPrincipal, owner: ChatOwner): boolean {
  return owner.type === "personal" && principal.userId === owner.ownerId
    && (principal.source === "jwt" || principal.source === "platform-verified");
}

/** Only native create/queue HTTP routes call this after authentication and strict parsing.
 * This proves authenticated HTTP entry, not that a human physically typed the message. */
export function ownerHttpInputProvenance(principal: RequestPrincipal, owner: ChatOwner): OwnerHttpInputProvenance {
  return isAuthenticatedOwner(principal, owner) ? { [OWNER_HTTP_INPUT]: true } : {};
}

/** Preserve the private key across admission without trusting public context/source strings. */
export function admittedOwnerHttpInput(principal: RequestPrincipal, owner: ChatOwner,
  provenance?: OwnerHttpInputProvenance): OwnerHttpInputProvenance {
  return isAuthenticatedOwner(principal, owner) && provenance?.[OWNER_HTTP_INPUT] === true
    ? { [OWNER_HTTP_INPUT]: true } : {};
}

/** Called inside original input transactions; replays never update existing rows. */
export function hasOwnerHttpInput(owner: ChatOwner, provenance: OwnerHttpInputProvenance,
  actorId: string | undefined): boolean {
  return owner.type === "personal" && actorId === owner.ownerId && provenance[OWNER_HTTP_INPUT] === true;
}

/** Queue promotion reads the durable column, not client-editable context_snapshot. */
export function promotedOwnerHttpInput(owner: ChatOwner, row: {
  owner_http_input: boolean; collaboration_scope_id: string | null; requesting_actor_id: string | null;
}): boolean {
  return owner.type === "personal" && row.owner_http_input === true && row.collaboration_scope_id === null
    && (row.requesting_actor_id === null || row.requesting_actor_id === owner.ownerId);
}
