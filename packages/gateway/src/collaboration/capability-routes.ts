/** Owner-hosted preset grants: direct proof, fresh organization membership and owner-DB transaction. */
import {
  CollaborationCreateGrantRequestSchema,
  CollaborationGrantSchema,
  CollaborationIdSchema,
  CollaborationPatchGrantRequestSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import { CollaborationAuthorizationError } from "./authority-error.js";
import type { CollaborationCapabilityEvaluator } from "./capability-evaluator.js";
import type { CollaborationCapabilityRepository, GrantRecord } from "./capability-repository.js";
import {
  authorize, deleteConditions, digest, digestDeleteConditions, handle, notifyScope, readJson,
  type CollaborationRouteOptions,
} from "./route-support.js";

const GRANTS_PATH = "/api/collaboration/scopes/:scopeId/grants";
const PRESET_POLICY_VERSION = "v1";

type CapabilityRouteOptions = Pick<
  CollaborationRouteOptions,
  "verifier" | "directSessions" | "onScopeCommitted"
> & {
  capabilities?: CollaborationCapabilityRepository;
  capabilityEvaluator?: CollaborationCapabilityEvaluator;
};

function requireCapabilities(options: CapabilityRouteOptions) {
  if (!options.capabilities || !options.capabilityEvaluator) {
    throw new CollaborationAuthorizationError("unavailable", "Capability grants are unavailable");
  }
  return { grants: options.capabilities, evaluator: options.capabilityEvaluator };
}

function projectGrant(grant: GrantRecord) {
  return CollaborationGrantSchema.parse({
    id: grant.grantId,
    scopeId: grant.scopeId,
    organizationId: grant.organizationId,
    audience: grant.audience,
    preset: grant.preset,
    state: grant.state,
    policyVersion: grant.policyVersion,
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    revision: String(grant.grantRevision),
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  });
}

export function registerCapabilityRoutes(routes: Hono, options: CapabilityRouteOptions): void {
  routes.get(GRANTS_PATH, async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    await authorize(options, c, new Uint8Array(), "read", scopeId);
    const { grants } = requireCapabilities(options);
    return c.json((await grants.listGrants(scopeId)).map(projectGrant));
  }));

  routes.post(GRANTS_PATH, async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    const input = CollaborationCreateGrantRequestSchema.parse(value);
    const { grants, evaluator } = requireCapabilities(options);
    const result = await evaluator.createGrant({
      scopeId,
      actorId: context.actorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digest(bytes),
      audience: input.audience,
      preset: input.preset,
      policyVersion: PRESET_POLICY_VERSION,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    const grant = await grants.getGrant(result.grantId);
    if (!grant) throw new CollaborationAuthorizationError("unavailable", "Committed grant is unavailable");
    await notifyScope(options, scopeId);
    return c.json(projectGrant(grant), 201);
  }));

  routes.patch(`${GRANTS_PATH}/:grantId`, async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const grantId = CollaborationIdSchema.parse(c.req.param("grantId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    const input = CollaborationPatchGrantRequestSchema.parse(value);
    const { grants, evaluator } = requireCapabilities(options);
    await evaluator.patchGrantPreset({
      scopeId, grantId, actorId: context.actorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      expectedGrantRevision: Number(input.expectedGrantRevision),
      payloadHash: digest(bytes), preset: input.preset,
    });
    const grant = await grants.getGrant(grantId);
    if (!grant) throw new CollaborationAuthorizationError("unavailable", "Committed grant is unavailable");
    await notifyScope(options, scopeId);
    return c.json(projectGrant(grant));
  }));

  routes.delete(`${GRANTS_PATH}/:grantId`, async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const grantId = CollaborationIdSchema.parse(c.req.param("grantId"));
    const input = deleteConditions(c);
    const context = await authorize(options, c, new Uint8Array(), "manage_members", scopeId);
    const { grants, evaluator } = requireCapabilities(options);
    await evaluator.revokeGrant({
      scopeId, grantId, actorId: context.actorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      expectedGrantRevision: Number(input.expectedMemberRevision),
      payloadHash: digestDeleteConditions(input),
    });
    const grant = await grants.getGrant(grantId);
    if (!grant) throw new CollaborationAuthorizationError("unavailable", "Committed grant is unavailable");
    await notifyScope(options, scopeId);
    return c.json(projectGrant(grant));
  }));

}
