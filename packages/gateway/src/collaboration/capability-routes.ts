/** Owner-hosted preset grants: direct proof, fresh organization membership and owner-DB transaction. */
import {
  CollaborationCreateGrantRequestSchema,
  CollaborationGrantSchema,
  CollaborationIdSchema,
  CollaborationPatchGrantRequestSchema,
  CollaborationProjectAccessPresentationSchema,
  CollaborationReadinessSchema,
  type CollaborationProjectAccessPresentation,
} from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod/v4";
import { readDirectCredentials } from "./direct-routes.js";
import { DirectAuthError } from "./direct-auth.js";
import { CollaborationAuthorizationError } from "./authority-error.js";
import type { CollaborationCapabilityEvaluator } from "./capability-evaluator.js";
import { evaluateCollaborationReadiness } from "./readiness-evaluator.js";
import {
  MAX_LISTED_PARTICIPANTS,
  type CollaborationCapabilityRepository,
  type GrantRecord,
} from "./capability-repository.js";
import {
  authenticateOwnerProject, authorize, deleteConditions, digest, digestDeleteConditions, handle, notifyScope, readJson,
  requireScope, verifyHttp, type CollaborationRouteOptions,
} from "./route-support.js";
import type { CollaborationAction } from "./authority.js";
import { PRESET_POLICY_VERSION } from "./repository-shared.js";

const GRANTS_PATH = "/api/collaboration/scopes/:scopeId/grants";
const OWNER_RUNTIME_HEADER = "x-matrix-collaboration-owner-runtime";
const ACCESS_PRESENTATION_CONCURRENCY = 8;

type CapabilityRouteOptions = Pick<
  CollaborationRouteOptions,
  "verifier" | "directSessions" | "onScopeCommitted" | "repository" | "readinessProbes" | "ownerRuntimeSessions" | "runtimeId"
  | "resolveParticipant"
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

/**
 * The actor managing a scope's grants. A private project has no scope access yet, so its owner
 * chooses who gets access before sharing through the exact owner setup session; the grants it
 * makes stay unpublished until the project is shared. Every other caller needs scope access.
 */
async function grantManager(
  options: CapabilityRouteOptions, c: Context, bytes: Uint8Array, action: CollaborationAction, scopeId: string,
): Promise<string> {
  if (c.req.header(OWNER_RUNTIME_HEADER) === "1") return (await authenticateOwnerProject(options, c, bytes, scopeId)).ownerId;
  return (await authorize(options, c, bytes, action, scopeId)).actorId;
}

export function registerCapabilityRoutes(routes: Hono, options: CapabilityRouteOptions): void {
  routes.get("/api/collaboration/scopes/:scopeId/project/access", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    await grantManager(options, c, new Uint8Array(), "manage_members", scopeId);
    const scope = await requireScope(options.repository, scopeId);
    if (scope.kind !== "project") throw new CollaborationAuthorizationError("not_found", "Project scope not found");
    const { grants, evaluator } = requireCapabilities(options);
    const now = Date.now();
    const live = (await grants.listGrants(scopeId)).filter((grant) =>
      (grant.state === "active" || grant.state === "pending")
      && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now));
    const organizationGrant = live.find((grant) => grant.audience.kind === "organization") ?? null;
    const activations = organizationGrant ? (await grants.listActivations(organizationGrant.grantId))
      .filter((activation) => activation.state === "active") : [];
    const byActor = new Map<string, {
      organizationActivated: boolean;
      directGrant?: GrantRecord;
    }>();
    for (const activation of activations) {
      if (activation.actorId === scope.ownerId || !organizationGrant) continue;
      byActor.set(activation.actorId, { organizationActivated: true });
    }
    for (const grant of live) {
      if (grant.audience.kind !== "member" || grant.audience.actorId === scope.ownerId) continue;
      byActor.set(grant.audience.actorId, {
        organizationActivated: byActor.get(grant.audience.actorId)?.organizationActivated ?? false,
        directGrant: grant,
      });
    }
    const people: CollaborationProjectAccessPresentation["people"] = [];
    // Direct grants must remain manageable even when organization activations fill the bounded
    // presentation. Grant count is capped separately, so prioritizing them cannot exceed this cap.
    const candidates = [...byActor.entries()].sort(([leftActorId, left], [rightActorId, right]) => {
      const directPriority = Number(Boolean(right.directGrant)) - Number(Boolean(left.directGrant));
      return directPriority || leftActorId.localeCompare(rightActorId);
    }).slice(0, MAX_LISTED_PARTICIPANTS);
    for (let offset = 0; offset < candidates.length; offset += ACCESS_PRESENTATION_CONCURRENCY) {
      const batch = await Promise.all(candidates.slice(offset, offset + ACCESS_PRESENTATION_CONCURRENCY)
        .map(async ([actorId, candidate]): Promise<CollaborationProjectAccessPresentation["people"][number] | null> => {
          const effective = await evaluator.evaluateEffectiveAccess({ scopeId, actorId });
          if (effective.preset === null && !candidate.directGrant) return null;
          const directIsEffective = candidate.directGrant?.state === "active" && effective.preset !== null;
          const inherited = candidate.organizationActivated && effective.preset !== null
            && (!directIsEffective || organizationGrant?.preset === "contributor" || candidate.directGrant?.preset === "viewer");
          return {
            actor: await options.resolveParticipant(actorId),
            status: effective.preset === null ? "pending" : "active",
            effectivePreset: effective.preset ?? candidate.directGrant?.preset ?? "viewer",
            inherited,
            ...(candidate.directGrant ? { directGrant: {
              grantId: candidate.directGrant.grantId,
              preset: candidate.directGrant.preset,
              revision: String(candidate.directGrant.grantRevision),
            } } : {}),
          };
        }));
      people.push(...batch.filter((person): person is NonNullable<typeof person> => person !== null));
    }
    return c.json(CollaborationProjectAccessPresentationSchema.parse({
      scopeId,
      revision: String(scope.revision),
      owner: await options.resolveParticipant(scope.ownerId),
      generalAccess: organizationGrant ? {
        grantId: organizationGrant.grantId,
        preset: organizationGrant.preset,
        revision: String(organizationGrant.grantRevision),
      } : null,
      people,
    }));
  }));
  routes.post(`${GRANTS_PATH}/:grantId/accept`, async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const grantId = CollaborationIdSchema.parse(c.req.param("grantId"));
    const { value, bytes } = await readJson(c);
    z.object({}).strict().parse(value);
    const scope = await requireScope(options.repository, scopeId);
    const { grants, evaluator } = requireCapabilities(options);
    const grant = await grants.getGrant(grantId);
    if (!scope.organizationId || !grant || grant.scopeId !== scopeId || grant.organizationId !== scope.organizationId) {
      throw new CollaborationAuthorizationError("not_found", "Grant not found");
    }
    // A pending recipient (any organization member for an organization-wide grant, or the
    // one addressee of a member grant) has no ordinary scope access yet. The platform
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
      if (options.directSessions) throw new DirectAuthError("invalid_signature", "Direct session credentials are required");
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
    await grantManager(options, c, new Uint8Array(), "read", scopeId);
    const { grants } = requireCapabilities(options);
    return c.json((await grants.listGrants(scopeId)).map(projectGrant));
  }));

  routes.post(GRANTS_PATH, async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const actorId = await grantManager(options, c, bytes, "manage_members", scopeId);
    const input = CollaborationCreateGrantRequestSchema.parse(value);
    const { grants, evaluator } = requireCapabilities(options);
    const result = await evaluator.createGrant({
      scopeId,
      actorId,
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
    const actorId = await grantManager(options, c, bytes, "manage_members", scopeId);
    const input = CollaborationPatchGrantRequestSchema.parse(value);
    const { grants, evaluator } = requireCapabilities(options);
    await evaluator.patchGrantPreset({
      scopeId, grantId, actorId,
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
    const actorId = await grantManager(options, c, new Uint8Array(), "manage_members", scopeId);
    const { grants, evaluator } = requireCapabilities(options);
    await evaluator.revokeGrant({
      scopeId, grantId, actorId,
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
