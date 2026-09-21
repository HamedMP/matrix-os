import { createHash, randomUUID } from "node:crypto";
import {
  CollaborationGitActionRequestSchema,
  CollaborationGitOperationSchema,
  type CollaborationGitActionRequest,
  type CollaborationGitEffectRequest,
  type CollaborationGitOperation,
} from "@matrix-os/contracts";
import { type Kysely } from "kysely";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";

const IdSchema = z.uuid();
const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const RunIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const OwnerIdentitySchema = z.object({
  name: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/),
  email: z.email().max(320),
  label: z.string().min(1).max(800).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict();

export type ProjectGitOwnerIdentity = z.infer<typeof OwnerIdentitySchema>;
export type ProjectGitActionResult = {
  commitSha?: string;
  remoteBranch?: string;
  prUrl?: string;
};
export type ProjectGitExecution = {
  operationId: string;
  scopeId: string;
  ownerId: string;
  projectId: string;
  requestingActorId: string;
  runId?: string;
  ownerIdentity: ProjectGitOwnerIdentity;
  request: CollaborationGitEffectRequest;
};

export interface ProjectGitDriver {
  run(input: ProjectGitExecution): Promise<ProjectGitActionResult>;
  /** A non-null result proves the remote side effect already happened. Null means unresolved, not safe to replay. */
  reconcile(input: ProjectGitExecution): Promise<ProjectGitActionResult | null>;
}

export class ProjectGitBrokerError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "conflict" | "unavailable" | "busy") {
    super("Project Git operation is unavailable");
    this.name = "ProjectGitBrokerError";
  }
}

export class AmbiguousProjectGitEffect extends Error {
  constructor() {
    super("Project Git effect needs reconciliation");
    this.name = "AmbiguousProjectGitEffect";
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Immutable body digest used for idempotency; the hash field cannot hash itself. */
export function hashGitAction(input: Record<string, unknown>): string {
  const { payloadHash: _ignored, ...payload } = input;
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function date(value: Date | string): string {
  return new Date(value).toISOString();
}

function toOperation(row: {
  id: string;
  scope_id: string;
  type: string;
  state: string;
  actor_id: string;
  run_id: string | null;
  owner_identity_label: string;
  commit_sha: string | null;
  remote_branch: string | null;
  pr_url: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): CollaborationGitOperation {
  return CollaborationGitOperationSchema.parse({
    id: row.id,
    scopeId: row.scope_id,
    type: row.type,
    state: row.state,
    requestingActorId: row.actor_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ownerIdentityLabel: row.owner_identity_label,
    ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    ...(row.remote_branch ? { remoteBranch: row.remote_branch } : {}),
    ...(row.pr_url ? { prUrl: row.pr_url } : {}),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  });
}

function capability(type: CollaborationGitEffectRequest["type"]): "git.commit" | "git.push" | "git.pr" | "read" {
  if (type === "commit") return "git.commit";
  if (type === "push") return "git.push";
  if (type === "pr") return "git.pr";
  return "read";
}

export function createProjectGitBroker(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  authorize(input: { scopeId: string; actorId: string; action: "git.commit" | "git.push" | "git.pr" | "read" }): Promise<{ ownerId: string; projectId: string }>;
  resolveOwnerIdentity(input: { ownerId: string; projectId: string }): Promise<ProjectGitOwnerIdentity>;
  driver: ProjectGitDriver;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  async function getRow(id: string) {
    const row = await options.db.selectFrom("collaboration_git_operations").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) throw new ProjectGitBrokerError("unavailable");
    return row;
  }

  async function settle(id: string, expected: "running" | "reconciling", state: "completed" | "failed" | "unknown", result: ProjectGitActionResult = {}) {
    const parsed = CollaborationGitOperationSchema.safeParse({
      id,
      scopeId: "00000000-0000-4000-8000-000000000000",
      type: "commit",
      state,
      requestingActorId: "actor",
      ownerIdentityLabel: "Owner",
      ...result,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    if (!parsed.success) throw new ProjectGitBrokerError("unavailable");
    await options.db.transaction().execute(async (trx) => {
      const row = await trx.updateTable("collaboration_git_operations")
        .set({
          state,
          commit_sha: result.commitSha ?? null,
          remote_branch: result.remoteBranch ?? null,
          pr_url: result.prUrl ?? null,
          updated_at: now(),
        })
        .where("id", "=", id)
        .where("state", "=", expected)
        .returningAll()
        .executeTakeFirst();
      if (!row) return;
      await trx.insertInto("collaboration_audit").values({
        scope_id: row.scope_id,
        actor_id: row.actor_id,
        action: `git.${row.type}`,
        outcome: state,
        revision: Number(row.expected_revision),
        reason_code: state === "completed" ? null : state === "unknown" ? "effect_unresolved" : "operation_failed",
        detail: {
          operationId: row.id,
          ownerId: row.owner_id,
          ownerIdentityLabel: row.owner_identity_label,
          ...(row.run_id ? { runId: row.run_id } : {}),
          ...(result.commitSha ? { commitSha: result.commitSha } : {}),
          ...(result.remoteBranch ? { remoteBranch: result.remoteBranch } : {}),
          ...(result.prUrl ? { prUrl: result.prUrl } : {}),
        },
        created_at: now(),
      }).execute();
    });
    return toOperation(await getRow(id));
  }

  async function waitForSettled(id: string): Promise<CollaborationGitOperation> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const row = await getRow(id);
      if (row.state !== "pending" && row.state !== "running" && row.state !== "reconciling") return toOperation(row);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return toOperation(await getRow(id));
  }

  return {
    async submit(input: { scopeId: string; actorId: string; request: unknown; runId?: string }): Promise<CollaborationGitOperation> {
      const scopeId = IdSchema.parse(input.scopeId);
      const actorId = ActorIdSchema.parse(input.actorId);
      const runId = input.runId ? RunIdSchema.parse(input.runId) : undefined;
      const request = CollaborationGitActionRequestSchema.parse(input.request);
      // Expiry resolves an existing operation through `expireUnresolved`; it never queues an effect.
      if (request.type === "expire") throw new ProjectGitBrokerError("forbidden");
      if (request.payloadHash !== hashGitAction(request)) throw new ProjectGitBrokerError("conflict");
      const authorization = await options.authorize({ scopeId, actorId, action: capability(request.type) });
      const ownerIdentity = OwnerIdentitySchema.parse(await options.resolveOwnerIdentity(authorization));
      const id = randomUUID();
      let row = await options.db.transaction().execute(async (trx) => {
        const scope = await trx.selectFrom("collaboration_scopes")
          .select(["owner_id", "resource_id", "revision", "lifecycle", "kind"])
          .where("id", "=", scopeId)
          .forUpdate()
          .executeTakeFirst();
        if (!scope || scope.kind !== "project") throw new ProjectGitBrokerError("not_found");
        if (scope.lifecycle !== "shared" || scope.owner_id !== authorization.ownerId || scope.resource_id !== authorization.projectId) {
          throw new ProjectGitBrokerError("forbidden");
        }
        const existing = await trx.selectFrom("collaboration_git_operations").selectAll()
          .where("scope_id", "=", scopeId).where("actor_id", "=", actorId)
          .where("client_request_id", "=", request.clientRequestId).executeTakeFirst();
        if (existing) {
          if (existing.payload_hash !== request.payloadHash) throw new ProjectGitBrokerError("conflict");
          return existing;
        }
        if (Number(scope.revision) !== Number(request.expectedRevision)) throw new ProjectGitBrokerError("conflict");
        await trx.insertInto("collaboration_git_operations").values({
          id,
          scope_id: scopeId,
          actor_id: actorId,
          run_id: runId ?? null,
          client_request_id: request.clientRequestId,
          type: request.type,
          state: "pending",
          payload_hash: request.payloadHash,
          expected_revision: Number(request.expectedRevision),
          owner_id: authorization.ownerId,
          owner_identity_label: ownerIdentity.label,
          request,
          commit_sha: null,
          remote_branch: null,
          pr_url: null,
          created_at: now(),
          updated_at: now(),
        }).onConflict((conflict) => conflict.columns(["scope_id", "actor_id", "client_request_id"]).doNothing()).execute();
        return (await trx.selectFrom("collaboration_git_operations").selectAll()
          .where("scope_id", "=", scopeId).where("actor_id", "=", actorId)
          .where("client_request_id", "=", request.clientRequestId).executeTakeFirstOrThrow());
      });
      if (row.payload_hash !== request.payloadHash) throw new ProjectGitBrokerError("conflict");
      if (row.state === "completed" || row.state === "failed") return toOperation(row);
      if (row.state === "running") {
        // A crashed gateway cannot attest whether a remote side effect happened. Reconcile the same ID.
        const recovered = await options.db.updateTable("collaboration_git_operations")
          .set({ state: "unknown", updated_at: now() })
          .where("id", "=", row.id).where("state", "=", "running")
          .where("updated_at", "<", new Date(now().getTime() - 60_000))
          .returningAll().executeTakeFirst();
        if (!recovered) return waitForSettled(row.id);
        row = recovered;
      }
      const execution: ProjectGitExecution = {
        operationId: row.id,
        scopeId,
        ownerId: authorization.ownerId,
        projectId: authorization.projectId,
        requestingActorId: actorId,
        ...(runId ? { runId } : {}),
        ownerIdentity,
        request,
      };
      if (row.state === "unknown") {
        const claimed = await options.db.updateTable("collaboration_git_operations")
          .set({ state: "reconciling", updated_at: now() })
          .where("id", "=", row.id).where("state", "=", "unknown")
          .returning("id").executeTakeFirst();
        if (!claimed) return waitForSettled(row.id);
        try {
          await options.authorize({ scopeId, actorId, action: capability(request.type) });
          const observed = await options.driver.reconcile(execution);
          return observed
            ? await settle(row.id, "reconciling", "completed", observed)
            : await settle(row.id, "reconciling", "unknown");
        } catch (error: unknown) {
          console.warn("[collaboration-git] reconciliation failed", error instanceof Error ? error.name : "UnknownError");
          return (await settle(row.id, "reconciling", "unknown"));
        }
      }
      const claimed = await options.db.transaction().execute(async (trx) => {
        // The scope row serializes claims across gateway processes; do not hold the lock during Git or forge calls.
        await trx.selectFrom("collaboration_scopes").select("id").where("id", "=", scopeId).forUpdate().executeTakeFirstOrThrow();
        const active = await trx.selectFrom("collaboration_git_operations").select("id")
          .where("scope_id", "=", scopeId).where("id", "!=", row.id)
          .where("state", "in", ["running", "reconciling", "unknown"])
          .executeTakeFirst();
        if (active) throw new ProjectGitBrokerError("busy");
        return trx.updateTable("collaboration_git_operations")
          .set({ state: "running", updated_at: now() })
          .where("id", "=", row.id).where("state", "=", "pending")
          .returning("id").executeTakeFirst();
      });
      if (!claimed) return waitForSettled(row.id);
      try {
        await options.authorize({ scopeId, actorId, action: capability(request.type) });
        const result = await options.driver.run(execution);
        return await settle(row.id, "running", "completed", result);
      } catch (error: unknown) {
        if (error instanceof AmbiguousProjectGitEffect) return await settle(row.id, "running", "unknown");
        console.warn("[collaboration-git] operation failed", error instanceof Error ? error.name : "UnknownError");
        return await settle(row.id, "running", "failed");
      }
    },

    /**
     * Owner-only: an effect the remote could not confirm blocks every later
     * operation on the scope. The owner, who can inspect the forge directly,
     * may expire it as failed. The request is never replayed by this path.
     */
    async expireUnresolved(input: { scopeId: string; actorId: string; operationId: string }): Promise<CollaborationGitOperation> {
      const scopeId = IdSchema.parse(input.scopeId);
      const actorId = ActorIdSchema.parse(input.actorId);
      const operationId = IdSchema.parse(input.operationId);
      const authorization = await options.authorize({ scopeId, actorId, action: "read" });
      if (authorization.ownerId !== actorId) throw new ProjectGitBrokerError("forbidden");
      await options.db.transaction().execute(async (trx) => {
        const existing = await trx.selectFrom("collaboration_git_operations").select(["id", "state"])
          .where("id", "=", operationId).where("scope_id", "=", scopeId).where("owner_id", "=", authorization.ownerId)
          .forUpdate().executeTakeFirst();
        if (!existing) throw new ProjectGitBrokerError("not_found");
        const row = await trx.updateTable("collaboration_git_operations")
          .set({ state: "failed", updated_at: now() })
          .where("id", "=", operationId).where("state", "=", "unknown")
          .returningAll().executeTakeFirst();
        if (!row) throw new ProjectGitBrokerError("conflict");
        await trx.insertInto("collaboration_audit").values({
          scope_id: row.scope_id,
          actor_id: actorId,
          action: `git.${row.type}`,
          outcome: "failed",
          revision: Number(row.expected_revision),
          reason_code: "effect_expired_by_owner",
          detail: {
            operationId: row.id,
            ownerId: row.owner_id,
            requestingActorId: row.actor_id,
            ownerIdentityLabel: row.owner_identity_label,
            ...(row.run_id ? { runId: row.run_id } : {}),
          },
          created_at: now(),
        }).execute();
      });
      return toOperation(await getRow(operationId));
    },

    async list(input: { scopeId: string; actorId: string }): Promise<CollaborationGitOperation[]> {
      const scopeId = IdSchema.parse(input.scopeId);
      const actorId = ActorIdSchema.parse(input.actorId);
      await options.authorize({ scopeId, actorId, action: "read" });
      const rows = await options.db.selectFrom("collaboration_git_operations").selectAll()
        .where("scope_id", "=", scopeId).orderBy("created_at", "desc").limit(100).execute();
      return rows.map(toOperation);
    },
  };
}

export type ProjectGitBroker = ReturnType<typeof createProjectGitBroker>;
