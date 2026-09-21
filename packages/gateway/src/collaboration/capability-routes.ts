/** Owner-hosted preset grants: direct proof, fresh organization membership and owner-DB transaction. */
import {
  CollaborationCreateGrantRequestSchema,
  CollaborationGrantSchema,
  CollaborationIdSchema,
  CollaborationPatchGrantRequestSchema,
  CollaborationReadinessSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import { z } from "zod/v4";
import { readDirectCredentials } from "./direct-routes.js";
import { CollaborationAuthorizationError } from "./authority-error.js";
import type { CollaborationCapabilityEvaluator } from "./capability-evaluator.js";
import { evaluateCollaborationReadiness } from "./readiness-evaluator.js";
import type { CollaborationCapabilityRepository, GrantRecord } from "./capability-repository.js";
import {
  authorize, deleteConditions, digest, digestDeleteConditions, handle, notifyScope, readJson, requireScope, verifyHttp,
  type CollaborationRouteOptions,
} from "./route-support.js";

const GRANTS_PATH = "/api/collaboration/scopes/:scopeId/grants";
const PRESET_POLICY_VERSION = "v1";

type CapabilityRouteOptions = Pick<
  CollaborationRouteOptions,
  "verifier" | "directSessions" | "onScopeCommitted" | "repository" | "readinessProbes"
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
  routes.post(`${GRANTS_PATH}/:grantId/accept`, async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const grantId = CollaborationIdSchema.parse(c.req.param("grantId"));
    const { value, bytes } = await readJson(c);
    z.object({}).strict().parse(value);
    const scope = await requireScope(options.repository, scopeId);
    const { grants, evaluator } = requireCapabilities(options);
    const grant = await grants.getGrant(grantId);
    if (!scope.organizationId || !grant || grant.scopeId !== scopeId
      || grant.organizationId !== scope.organizationId || grant.audience.kind !== "organization") {
      throw new CollaborationAuthorizationError("not_found", "Grant not found");
    }
    // A pending organization recipient has no ordinary scope access yet. The platform
    // signs the directory's exact grant pointer into an accept-only direct session;
    // no other capability route may authorize through that session.
    const credentials = readDirectCredentials(c);
    let actorId: string;
    if (credentials) {
      if (!options.directSessions) throw new CollaborationAuthorizationError("unavailable", "Direct sessions are unavailable");
      const session = await options.directSessions.authenticate({
        ...credentials, method: "POST", path: c.req.path,
        query: new URL(c.req.url).search.slice(1), body: bytes,
      });
      if (session.scopeId !== scopeId || session.organizationId !== scope.organizationId
        || session.pendingGrantId !== grantId) throw new CollaborationAuthorizationError("not_found", "Grant not found");
      actorId = session.actorId;
    } else {
      const proof = await verifyHttp(options.verifier, c, bytes);
      if (proof.scopeId !== scopeId || proof.ownerId !== scope.ownerId) {
        throw new CollaborationAuthorizationError("not_found", "Grant not found");
      }
      actorId = proof.actorId;
    }
    const result = await evaluator.acceptGrant({ grantId, actorId });
    await notifyScope(options, scopeId);
    return c.json(result);
  }));

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


  routes.post("/api/collaboration/scopes/:scopeId/policy/preflight", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > 0) {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length > 0) {
        throw new SyntaxError("Invalid readiness request");
      }
    }
    const context = await authorize(options, c, bytes, "read", scopeId);
    if (!options.readinessProbes) {
      throw new CollaborationAuthorizationError("unavailable", "Readiness probes are unavailable");
    }
    const scope = await requireScope(options.repository, scopeId);
    if (!scope.organizationId) throw new CollaborationAuthorizationError("unavailable", "Readiness organization unavailable");
    const readiness = await evaluateCollaborationReadiness({
      scopeId, ownerId: scope.ownerId, organizationId: scope.organizationId,
      resourceKind: context.resourceKind === "app" ? "app_instance" : context.resourceKind,
    }, options.readinessProbes);
    return c.json(CollaborationReadinessSchema.parse(readiness));
  }));

}
