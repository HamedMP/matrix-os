/**
 * S08 / T043: `GET/PUT /api/collaboration/scopes/:scopeId/execution-policy`.
 *
 * Any current participant may read the policy that governs a scope; only
 * the scope owner may change it, and the repository enforces that. Both
 * routes pass the signed actor proof and the organization precondition
 * before touching the policy. PUT is a mutating verb the shared prefix limit
 * does not cover, so this module applies its own body limit.
 */
import {
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborationExecutionPolicyPutRequestSchema,
  CollaborationExecutionPolicySchema,
  CollaborationIdSchema,
} from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CollaborationAuthority } from "./authority.js";
import { CollaborationAuthorizationError } from "./authority-error.js";
import type { CollaborationActorProofVerifier } from "./actor-proof.js";
import {
  CollaborationExecutionPolicyError,
  type CollaborationExecutionPolicyRepository,
} from "./execution-policy.js";
import type { CollaborationRepository } from "./repository.js";
import { digest, handle, readJson, verifyHttp } from "./route-support.js";

const POLICY_PATH = "/api/collaboration/scopes/:scopeId/execution-policy";

export interface ExecutionPolicyRouteOptions {
  verifier: CollaborationActorProofVerifier;
  authority: CollaborationAuthority;
  repository: CollaborationRepository;
  executionPolicies?: CollaborationExecutionPolicyRepository;
  onScopeCommitted?(scopeId: string): Promise<void>;
}

function policyStatus(code: CollaborationExecutionPolicyError["code"]): 404 | 403 | 409 | 503 {
  return code === "not_found" ? 404 : code === "forbidden" ? 403 : code === "unavailable" ? 503 : 409;
}

async function handlePolicy(c: Context, operation: () => Promise<Response>): Promise<Response> {
  return handle(c, async () => {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof CollaborationExecutionPolicyError) {
        return c.json({ error: "Collaboration state changed", code: error.code }, policyStatus(error.code));
      }
      throw error;
    }
  });
}

function requirePolicies(options: ExecutionPolicyRouteOptions): CollaborationExecutionPolicyRepository {
  if (!options.executionPolicies) {
    throw new CollaborationAuthorizationError("unavailable", "Execution policy is unavailable");
  }
  return options.executionPolicies;
}

export function registerExecutionPolicyRoutes(routes: Hono, options: ExecutionPolicyRouteOptions): void {
  const putLimit = bodyLimit({
    maxSize: COLLABORATION_HTTP_BODY_LIMIT,
    onError: (c) => c.json({ error: "Collaboration request too large", code: "invalid_request" }, 413),
  });
  routes.use(POLICY_PATH, async (c, next) => (c.req.method === "PUT" ? putLimit(c, next) : next()));

  routes.get(POLICY_PATH, async (c) => handlePolicy(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const proof = await verifyHttp(options.verifier, c, new Uint8Array());
    await options.authority.authorize({ scopeId, actorId: proof.actorId, action: "read" });
    const policy = await requirePolicies(options).resolve(scopeId);
    if (!policy) throw new CollaborationExecutionPolicyError("not_found", "No execution policy");
    return c.json(CollaborationExecutionPolicySchema.parse(policy));
  }));

  routes.put(POLICY_PATH, async (c) => handlePolicy(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    await options.authority.authorize({ scopeId, actorId: proof.actorId, action: "read" });
    const request = CollaborationExecutionPolicyPutRequestSchema.parse(value);
    const policy = await requirePolicies(options).put({
      scopeId, actorId: proof.actorId, request, payloadHash: digest(bytes),
    });
    if (options.onScopeCommitted) {
      try {
        await options.onScopeCommitted(scopeId);
      } catch (error: unknown) {
        console.warn("[collaboration-routes] execution policy notification failed",
          error instanceof Error ? error.name : "UnknownError");
      }
    }
    return c.json(CollaborationExecutionPolicySchema.parse(policy));
  }));
}
