import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { CollaborationScopeRecord } from "./repository.js";

const PREFLIGHT_LIFETIME_MS = 60_000;
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const ProjectIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const ProjectRecordSchema = z.object({
  id: ProjectIdSchema,
  ownerId: ActorIdSchema,
  revision: RevisionSchema,
}).strict();

const PreflightPayloadSchema = z.object({
  version: z.literal(1),
  ownerId: ActorIdSchema,
  projectId: ProjectIdSchema,
  projectRevision: RevisionSchema,
  expiresAt: z.iso.datetime(),
}).strict();

export interface CollaborationProjectSource {
  getProject(ownerId: string, projectId: string): Promise<{
    id: string;
    ownerId: string;
    revision: number;
  } | null>;
}

export class CollaborationProjectScopeError extends Error {
  constructor(public readonly code: "not_found" | "conflict" | "invalid_confirmation" | "unavailable") {
    super("Project collaboration preparation is unavailable");
    this.name = "CollaborationProjectScopeError";
  }
}

export class CollaborationProjectScopeService {
  private readonly now: () => Date;
  private readonly createScopeId: () => string;
  private readonly createEventId: () => string;

  constructor(
    private readonly db: Kysely<OwnerCollaborationDatabase>,
    private readonly options: {
      runtimeId: string;
      preflightSecret: string;
      source: CollaborationProjectSource;
      now?: () => Date;
      createScopeId?: () => string;
      createEventId?: () => string;
    },
  ) {
    if (Buffer.byteLength(options.preflightSecret) < 32) {
      throw new Error("Collaboration preflight secret is unavailable");
    }
    this.now = options.now ?? (() => new Date());
    this.createScopeId = options.createScopeId ?? randomUUID;
    this.createEventId = options.createEventId ?? randomUUID;
  }

  async preflight(input: { ownerId: string; projectId: string }): Promise<{
    eligible: true;
    projectRevision: number;
    confirmationToken: string;
    existingScopeId?: string;
    existingLifecycle?: CollaborationScopeRecord["lifecycle"];
  }> {
    const ownerId = ActorIdSchema.parse(input.ownerId);
    const projectId = ProjectIdSchema.parse(input.projectId);
    const project = await this.readProject(ownerId, projectId);
    const payload = PreflightPayloadSchema.parse({
      version: 1,
      ownerId,
      projectId,
      projectRevision: project.revision,
      expiresAt: new Date(this.now().getTime() + PREFLIGHT_LIFETIME_MS).toISOString(),
    });
    const existing = await findProjectScope(this.db, ownerId, projectId);
    return {
      eligible: true,
      projectRevision: project.revision,
      confirmationToken: sign(payload, this.options.preflightSecret),
      ...(existing ? {
        existingScopeId: existing.id,
        existingLifecycle: existing.lifecycle,
      } : {}),
    };
  }

  async prepare(input: {
    ownerId: string;
    projectId: string;
    clientRequestId: string;
    payloadHash: string;
    expectedProjectRevision: number;
    confirmationToken: string;
  }): Promise<CollaborationScopeRecord> {
    const parsed = z.object({
      ownerId: ActorIdSchema,
      projectId: ProjectIdSchema,
      clientRequestId: z.uuid(),
      payloadHash: DigestSchema,
      expectedProjectRevision: RevisionSchema,
      confirmationToken: z.string().min(64).max(4_096),
    }).strict().parse(input);
    const replay = await this.readReplay(parsed);
    if (replay) return replay;
    this.verifyConfirmation(parsed);
    const project = await this.readProject(parsed.ownerId, parsed.projectId);
    if (project.revision !== parsed.expectedProjectRevision) {
      throw new CollaborationProjectScopeError("conflict");
    }
    const now = this.now().toISOString();
    const proposedScopeId = z.uuid().parse(this.createScopeId());
    try {
      return await this.db.transaction().execute(async (trx) => {
        const inserted = await trx.insertInto("collaboration_scopes").values({
          id: proposedScopeId,
          owner_type: "personal",
          owner_id: parsed.ownerId,
          kind: "project",
          resource_id: parsed.projectId,
          parent_scope_id: null,
          membership_mode: "direct",
          lifecycle: "private",
          revision: 0,
          auth_epoch: 0,
          authority_runtime_id: this.options.runtimeId,
          authority_generation: 1,
          execution_generation: null,
          execution_eligibility: null,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        }).onConflict((conflict) => conflict
          .columns(["owner_type", "owner_id", "kind", "resource_id"])
          .where("deleted_at", "is", null)
          .where("lifecycle", "!=", "deleted")
          .doNothing())
          .returning("id")
          .executeTakeFirst();
        const scope = await trx.selectFrom("collaboration_scopes").selectAll()
          .where("owner_type", "=", "personal")
          .where("owner_id", "=", parsed.ownerId)
          .where("kind", "=", "project")
          .where("resource_id", "=", parsed.projectId)
          .where("deleted_at", "is", null)
          .where("lifecycle", "!=", "deleted")
          .forUpdate()
          .executeTakeFirst();
        if (!scope || scope.membership_mode !== "direct"
          || (scope.lifecycle !== "private" && scope.lifecycle !== "preparing")) {
          throw new CollaborationProjectScopeError("conflict");
        }
        const operation = await readCreateOperation(trx, scope.id, parsed.ownerId, parsed.clientRequestId);
        if (operation) {
          if (operation.payload_hash !== parsed.payloadHash || operation.status !== "completed") {
            throw new CollaborationProjectScopeError("conflict");
          }
          return scopeRecord(scope);
        }

        if (inserted) {
          await trx.insertInto("collaboration_members").values({
            scope_id: scope.id,
            actor_id: parsed.ownerId,
            role: "owner",
            status: "accepted",
            invitation_id: null,
            invited_by: parsed.ownerId,
            accepted_at: now,
            expires_at: null,
            revision: 1,
            joined_at: now,
            updated_at: now,
          }).execute();
          const eventId = z.uuid().parse(this.createEventId());
          await trx.insertInto("collaboration_events").values({
            scope_id: scope.id,
            scope_seq: 1,
            event_id: eventId,
            resource_kind: "project",
            resource_id: parsed.projectId,
            revision: 0,
            authority_generation: 1,
            event_type: "project.scope.prepared",
            payload: jsonb({}),
            created_at: now,
          }).execute();
          await trx.insertInto("collaboration_audit").values({
            scope_id: scope.id,
            actor_id: parsed.ownerId,
            action: "project.scope.prepared",
            outcome: "completed",
            revision: 0,
            reason_code: null,
            created_at: now,
          }).execute();
        } else {
          const owner = await trx.selectFrom("collaboration_members").select(["role", "status"])
            .where("scope_id", "=", scope.id)
            .where("actor_id", "=", parsed.ownerId)
            .executeTakeFirst();
          if (!owner || owner.role !== "owner" || owner.status !== "accepted") {
            throw new CollaborationProjectScopeError("conflict");
          }
        }
        await trx.insertInto("collaboration_operations").values({
          scope_id: scope.id,
          actor_id: parsed.ownerId,
          client_request_id: parsed.clientRequestId,
          operation_kind: "scope.create",
          payload_hash: parsed.payloadHash,
          status: "completed",
          result_ref: jsonb({ scopeId: scope.id }),
          expected_revision: parsed.expectedProjectRevision,
          accepted_auth_epoch: 0,
          created_at: now,
          expires_at: new Date(this.now().getTime() + OPERATION_RETENTION_MS).toISOString(),
        }).execute();
        return scopeRecord(scope);
      });
    } catch (error: unknown) {
      if (error instanceof CollaborationProjectScopeError) throw error;
      if (isUniqueViolation(error)) {
        const racedReplay = await this.readReplay(parsed);
        if (racedReplay) return racedReplay;
        throw new CollaborationProjectScopeError("conflict");
      }
      console.warn("[collaboration-project] scope preparation failed", error instanceof Error ? error.name : "UnknownError");
      throw new CollaborationProjectScopeError("unavailable");
    }
  }

  private async readReplay(input: {
    ownerId: string;
    projectId: string;
    clientRequestId: string;
    payloadHash: string;
  }): Promise<CollaborationScopeRecord | null> {
    const scope = await findProjectScope(this.db, input.ownerId, input.projectId);
    if (!scope) return null;
    const operation = await readCreateOperation(this.db, scope.id, input.ownerId, input.clientRequestId);
    if (!operation) return null;
    if (operation.payload_hash !== input.payloadHash || operation.status !== "completed") {
      throw new CollaborationProjectScopeError("conflict");
    }
    return scopeRecord(scope);
  }

  private async readProject(ownerId: string, projectId: string) {
    try {
      const project = ProjectRecordSchema.nullable().parse(await this.options.source.getProject(ownerId, projectId));
      if (!project || project.id !== projectId || project.ownerId !== ownerId) {
        throw new CollaborationProjectScopeError("not_found");
      }
      return project;
    } catch (error: unknown) {
      if (error instanceof CollaborationProjectScopeError) throw error;
      if (!(error instanceof z.ZodError)) {
        console.warn("[collaboration-project] project lookup failed", error instanceof Error ? error.name : "UnknownError");
      }
      throw new CollaborationProjectScopeError("unavailable");
    }
  }

  private verifyConfirmation(input: {
    ownerId: string;
    projectId: string;
    expectedProjectRevision: number;
    confirmationToken: string;
  }): void {
    const [encoded, signature, extra] = input.confirmationToken.split(".");
    if (!encoded || !signature || extra !== undefined) throw invalidConfirmation();
    const expected = createHmac("sha256", this.options.preflightSecret).update(encoded).digest();
    const received = Buffer.from(signature, "base64url");
    const padded = Buffer.alloc(expected.length);
    received.copy(padded, 0, 0, expected.length);
    if (received.length !== expected.length || !timingSafeEqual(padded, expected)) throw invalidConfirmation();
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        console.warn("[collaboration-project] preflight decode failed", error instanceof Error ? error.name : "UnknownError");
      }
      throw invalidConfirmation();
    }
    const payload = PreflightPayloadSchema.safeParse(value);
    if (!payload.success || payload.data.ownerId !== input.ownerId
      || payload.data.projectId !== input.projectId
      || payload.data.projectRevision !== input.expectedProjectRevision
      || Date.parse(payload.data.expiresAt) <= this.now().getTime()) {
      throw invalidConfirmation();
    }
  }
}

type ScopeExecutor = Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>;

function findProjectScope(db: ScopeExecutor, ownerId: string, projectId: string) {
  return db.selectFrom("collaboration_scopes").selectAll()
    .where("owner_type", "=", "personal")
    .where("owner_id", "=", ownerId)
    .where("kind", "=", "project")
    .where("resource_id", "=", projectId)
    .where("deleted_at", "is", null)
    .where("lifecycle", "!=", "deleted")
    .executeTakeFirst();
}

function readCreateOperation(db: ScopeExecutor, scopeId: string, actorId: string, clientRequestId: string) {
  return db.selectFrom("collaboration_operations").select(["payload_hash", "status"])
    .where("scope_id", "=", scopeId)
    .where("actor_id", "=", actorId)
    .where("client_request_id", "=", clientRequestId)
    .where("operation_kind", "=", "scope.create")
    .executeTakeFirst();
}

function scopeRecord(row: Awaited<ReturnType<typeof findProjectScope>> & {}): CollaborationScopeRecord {
  if (!row) throw new CollaborationProjectScopeError("not_found");
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    resourceId: row.resource_id,
    ...(row.parent_scope_id ? { parentScopeId: row.parent_scope_id } : {}),
    membershipMode: row.membership_mode,
    lifecycle: row.lifecycle,
    revision: Number(row.revision),
    authEpoch: Number(row.auth_epoch),
    authorityRuntimeId: row.authority_runtime_id,
    authorityGeneration: Number(row.authority_generation),
  };
}

function sign(payload: z.infer<typeof PreflightPayloadSchema>, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

function invalidConfirmation(): CollaborationProjectScopeError {
  return new CollaborationProjectScopeError("invalid_confirmation");
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}
