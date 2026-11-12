/**
 * Call-time org policy for Matrix Core MCP (spec 2691, "Org scope").
 *
 * Effective permission is `org policy ∩ user policy ∩ run scope`. The user
 * policy and run scope stay in the broker and Core tool service; this module
 * supplies the org term, read fresh from Postgres on every call, so a block
 * written by an admin denies the next call (never one already in flight).
 *
 * Org context: every organization in which the actor holds an active
 * membership in the platform projection. A member of several organizations
 * is governed by all of them; any one block denies.
 *
 * Usage attribution (`org_id` on the usage row), deterministic and minimal:
 * 1. the first organization (by id) whose policy denied the call; else
 * 2. the first organization (by id) that governs this server (has a
 *    definition or a member block for it); else
 * 3. the actor's only organization, when there is exactly one; else
 * 4. no organization: personal use of an ungoverned server by a member of
 *    several organizations is not attributed to any of them.
 */
import { orgMcpServerDefIdsForUrl, type OrgMcpToolPolicy } from "@matrix-os/contracts";
import { ClerkActorIdSchema } from "../organizations/roles.js";
import type { OrgMcpPolicyRow, OrgMcpRepository } from "./database.js";

export interface OrgMcpDecision { orgId: string | null; allowed: boolean }

function toolPolicy(definition: OrgMcpPolicyRow["definitions"][number], toolName: string): OrgMcpToolPolicy {
  return Object.hasOwn(definition.toolOverrides, toolName) ? definition.toolOverrides[toolName]! : definition.defaultToolPolicy;
}

function denies(row: OrgMcpPolicyRow, toolName: string): boolean {
  return row.memberBlocked || row.definitions.some(definition => definition.mode === "block" || toolPolicy(definition, toolName) === "blocked");
}

export function decideOrgMcpPolicy(rows: readonly OrgMcpPolicyRow[], toolName: string): OrgMcpDecision {
  const denying = rows.find(row => denies(row, toolName));
  if (denying) return { orgId: denying.organizationId, allowed: false };
  const governing = rows.find(row => row.memberBlocked || row.definitions.length > 0);
  if (governing) return { orgId: governing.organizationId, allowed: true };
  return { orgId: rows.length === 1 ? rows[0]!.organizationId : null, allowed: true };
}

export function createOrgMcpPolicy(repository: Pick<OrgMcpRepository, "policyRowsForActor">) {
  return {
    /** Throws on store failure; the Core tool service fails the call closed. */
    async evaluate(input: { actorId: string; serverUrl: string; toolName: string }): Promise<OrgMcpDecision> {
      // Non-Clerk actors (legacy machine-only callers) have no org memberships.
      if (!ClerkActorIdSchema.safeParse(input.actorId).success) return { orgId: null, allowed: true };
      const { serverDefIds } = orgMcpServerDefIdsForUrl(input.serverUrl);
      return decideOrgMcpPolicy(await repository.policyRowsForActor(input.actorId, serverDefIds), input.toolName);
    },
  };
}

export type OrgMcpPolicy = ReturnType<typeof createOrgMcpPolicy>;
