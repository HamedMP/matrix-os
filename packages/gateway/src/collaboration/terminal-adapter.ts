import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import type { CollaborationScopeRecord, CollaborationRepository } from "./repository.js";
import type {
  CollaborationTerminalMetadata,
  CollaborationTerminalRuntime,
} from "./terminal-dispatcher.js";

const PREFLIGHT_LIFETIME_MS = 60_000;
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TerminalSessionSchema = z.object({
  name: z.string().min(1).max(128),
  status: z.enum(["active", "exited"]),
  createdAt: z.iso.datetime(),
  incarnationVerified: z.boolean(),
  creatorActorId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
  collaborationScopeId: z.uuid().optional(),
  sessionIncarnation: z.string().regex(/^terminal-[a-f0-9]{32}$/).optional(),
  executionGeneration: z.number().int().positive().optional(),
  sharedControlMode: z.enum(["eligible", "shared"]).optional(),
}).passthrough();
const PreflightPayloadSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  terminalId: z.string().min(1).max(128),
  incarnation: z.string().regex(/^terminal-[a-f0-9]{32}$/),
  executionGeneration: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
}).strict();
const TerminalEligibilitySchema = z.object({
  profileId: z.literal("scope-runtime-terminal-v1"),
  profileVersion: z.number().int().positive(),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  adapterId: z.literal("terminal"),
  harnessVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
}).strict();

export type CollaborationTerminalAdapterErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_confirmation"
  | "unavailable";

export class CollaborationTerminalAdapterError extends Error {
  constructor(public readonly code: CollaborationTerminalAdapterErrorCode) {
    super("Shared terminal is unavailable");
    this.name = "CollaborationTerminalAdapterError";
  }
}

type RegistrySession = z.infer<typeof TerminalSessionSchema>;

export class CollaborationTerminalAdapter implements CollaborationTerminalRuntime {
  private readonly now: () => Date;
  private readonly createScopeId: () => string;

  constructor(private readonly options: {
    repository: CollaborationRepository;
    registry: {
      get(name: string): Promise<unknown>;
      bindCollaboration(name: string, input: {
        scopeId: string;
        sessionIncarnation: string;
        executionGeneration: number;
      }): Promise<unknown>;
      unbindCollaboration(name: string, input: {
        scopeId: string;
        sessionIncarnation: string;
      }): Promise<void>;
    };
    runtime: {
      input(input: { terminalId: string; data: string }): Promise<void>;
      paste(input: { terminalId: string; data: string }): Promise<void>;
      resize(input: { terminalId: string; cols: number; rows: number }): Promise<void>;
      stop(input: { terminalId: string }): Promise<void>;
    };
    runtimeId: string;
    executionEligibility: z.infer<typeof TerminalEligibilitySchema>;
    preflightSecret: string;
    now?: () => Date;
    createScopeId?: () => string;
  }) {
    if (Buffer.byteLength(options.preflightSecret) < 32) {
      throw new Error("Collaboration preflight secret is unavailable");
    }
    this.now = options.now ?? (() => new Date());
    this.createScopeId = options.createScopeId ?? randomUUID;
    TerminalEligibilitySchema.parse(options.executionEligibility);
  }

  async preflight(input: { ownerId: string; terminalId: string }): Promise<{
    eligible: boolean;
    reason?: "unsupported" | "unavailable";
    resourceRevision: number;
    confirmationToken?: string;
  }> {
    let session = await this.readSession(input.terminalId);
    session = await this.repairOrphanedPrivateBinding(input.ownerId, input.terminalId, session);
    const resourceRevision = session?.executionGeneration ?? 0;
    if (!session) return { eligible: false, reason: "unavailable", resourceRevision };
    if (!eligiblePrivateSession(session, input.ownerId)
      && !await this.matchesSharedScope(session, input.ownerId, input.terminalId)) {
      return { eligible: false, reason: "unsupported", resourceRevision };
    }
    const payload = PreflightPayloadSchema.parse({
      version: 1,
      ownerId: input.ownerId,
      terminalId: input.terminalId,
      incarnation: session.sessionIncarnation,
      executionGeneration: session.executionGeneration,
      expiresAt: new Date(this.now().getTime() + PREFLIGHT_LIFETIME_MS).toISOString(),
    });
    return {
      eligible: true,
      resourceRevision,
      confirmationToken: signPreflight(payload, this.options.preflightSecret),
    };
  }

  async shareTerminal(input: {
    ownerId: string;
    terminalId: string;
    clientRequestId: string;
    payloadHash: string;
    expectedResourceRevision: number;
    confirmationToken: string;
  }): Promise<CollaborationScopeRecord> {
    const confirmation = this.verifyConfirmation(input);
    let session = await this.readSession(input.terminalId);
    session = await this.repairOrphanedPrivateBinding(input.ownerId, input.terminalId, session);
    const privateSession = session ? eligiblePrivateSession(session, input.ownerId) : false;
    const existingSharedScope = session
      ? await this.matchingSharedScope(session, input.ownerId, input.terminalId)
      : null;
    if (!session || (!privateSession && !existingSharedScope)
      || session.sessionIncarnation !== confirmation.incarnation
      || session.executionGeneration !== input.expectedResourceRevision) {
      throw new CollaborationTerminalAdapterError("conflict");
    }
    const scope = await this.options.repository.createDirectScope({
      scopeId: this.createScopeId(),
      ownerId: input.ownerId,
      kind: "terminal",
      resourceId: input.terminalId,
      authorityRuntimeId: this.options.runtimeId,
    });
    if (scope.lifecycle !== "private") {
      if (existingSharedScope?.id !== scope.id) throw new CollaborationTerminalAdapterError("conflict");
      return this.replaySharedScope(scope, input);
    }
    if (!privateSession) throw new CollaborationTerminalAdapterError("conflict");

    try {
      await this.options.registry.bindCollaboration(input.terminalId, {
        scopeId: scope.id,
        sessionIncarnation: confirmation.incarnation,
        executionGeneration: confirmation.executionGeneration,
      });
    } catch (error: unknown) {
      console.warn(
        "[collaboration-terminal] registry binding failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw new CollaborationTerminalAdapterError("unavailable");
    }

    try {
      return await this.activateScope(scope, input, confirmation);
    } catch (error: unknown) {
      await this.options.registry.unbindCollaboration(input.terminalId, {
        scopeId: scope.id,
        sessionIncarnation: confirmation.incarnation,
      }).catch((rollbackError: unknown) => {
        console.warn(
          "[collaboration-terminal] registry rollback failed",
          rollbackError instanceof Error ? rollbackError.name : "UnknownError",
        );
      });
      throw error;
    }
  }

  async get(scopeId: string, terminalId: string): Promise<CollaborationTerminalMetadata | null> {
    const session = await this.readSession(terminalId);
    if (!session || session.collaborationScopeId !== scopeId || session.sharedControlMode !== "shared"
      || !session.sessionIncarnation || !session.executionGeneration || !session.creatorActorId) return null;
    return {
      scopeId,
      terminalId,
      incarnation: session.sessionIncarnation,
      executionGeneration: session.executionGeneration,
      creatorActorId: session.creatorActorId,
      createdAt: session.createdAt,
      status: session.status,
    };
  }

  async input(input: Parameters<CollaborationTerminalRuntime["input"]>[0]): Promise<void> {
    await this.requireRuntimeBinding(input);
    await input.revalidate();
    await this.options.runtime.input({ terminalId: input.terminalId, data: input.data });
  }

  async paste(input: Parameters<CollaborationTerminalRuntime["paste"]>[0]): Promise<void> {
    await this.requireRuntimeBinding(input);
    await input.revalidate();
    await this.options.runtime.paste({ terminalId: input.terminalId, data: input.data });
  }

  async resize(input: Parameters<CollaborationTerminalRuntime["resize"]>[0]): Promise<void> {
    await this.requireRuntimeBinding(input);
    await input.revalidate();
    await this.options.runtime.resize({ terminalId: input.terminalId, cols: input.cols, rows: input.rows });
  }

  async stop(input: Parameters<CollaborationTerminalRuntime["stop"]>[0]): Promise<void> {
    await this.requireRuntimeBinding(input);
    await this.options.runtime.stop({ terminalId: input.terminalId });
  }

  private async requireRuntimeBinding(input: {
    scopeId: string;
    terminalId: string;
    incarnation: string;
  }): Promise<void> {
    const current = await this.get(input.scopeId, input.terminalId);
    if (!current || current.incarnation !== input.incarnation || current.status !== "active") {
      throw new CollaborationTerminalAdapterError("not_found");
    }
  }

  private async readSession(terminalId: string): Promise<RegistrySession | null> {
    try {
      const parsed = TerminalSessionSchema.safeParse(await this.options.registry.get(terminalId));
      return parsed.success ? parsed.data : null;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "session_not_found") return null;
      console.warn(
        "[collaboration-terminal] registry read failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return null;
    }
  }

  private async repairOrphanedPrivateBinding(
    ownerId: string,
    terminalId: string,
    session: RegistrySession | null,
  ): Promise<RegistrySession | null> {
    if (!session?.collaborationScopeId || !session.sessionIncarnation || session.sharedControlMode !== "shared"
      || session.creatorActorId !== ownerId) return session;
    const scope = await this.options.repository.getScope(session.collaborationScopeId);
    if (!scope || scope.ownerId !== ownerId || scope.kind !== "terminal"
      || scope.resourceId !== terminalId || scope.lifecycle !== "private") return session;
    try {
      await this.options.registry.unbindCollaboration(terminalId, {
        scopeId: session.collaborationScopeId,
        sessionIncarnation: session.sessionIncarnation,
      });
      return await this.readSession(terminalId);
    } catch (error: unknown) {
      console.warn(
        "[collaboration-terminal] orphaned registry binding cleanup failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return session;
    }
  }

  private async matchesSharedScope(session: RegistrySession, ownerId: string, terminalId: string): Promise<boolean> {
    return Boolean(await this.matchingSharedScope(session, ownerId, terminalId));
  }

  private async matchingSharedScope(
    session: RegistrySession,
    ownerId: string,
    terminalId: string,
  ): Promise<CollaborationScopeRecord | null> {
    if (!eligibleSharedSession(session, ownerId) || !session.collaborationScopeId) return null;
    const scope = await this.options.repository.getScope(session.collaborationScopeId);
    return scope?.ownerId === ownerId && scope.kind === "terminal" && scope.resourceId === terminalId
      && scope.lifecycle === "shared" ? scope : null;
  }

  private verifyConfirmation(input: {
    ownerId: string;
    terminalId: string;
    expectedResourceRevision: number;
    confirmationToken: string;
  }): z.infer<typeof PreflightPayloadSchema> {
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
        console.warn("[collaboration-terminal] preflight decode failed", error instanceof Error ? error.name : "UnknownError");
      }
      throw invalidConfirmation();
    }
    const payload = PreflightPayloadSchema.safeParse(value);
    if (!payload.success || payload.data.ownerId !== input.ownerId || payload.data.terminalId !== input.terminalId
      || payload.data.executionGeneration !== input.expectedResourceRevision
      || Date.parse(payload.data.expiresAt) <= this.now().getTime()) throw invalidConfirmation();
    return payload.data;
  }

  private async activateScope(
    scope: CollaborationScopeRecord,
    input: { ownerId: string; clientRequestId: string; payloadHash: string },
    confirmation: z.infer<typeof PreflightPayloadSchema>,
  ): Promise<CollaborationScopeRecord> {
    const now = this.now().toISOString();
    return this.options.repository.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("collaboration_scopes").selectAll()
        .where("id", "=", scope.id).forUpdate().executeTakeFirstOrThrow();
      if (current.lifecycle !== "private" || current.kind !== "terminal"
        || current.resource_id !== confirmation.terminalId || current.owner_id !== input.ownerId) {
        throw new CollaborationTerminalAdapterError("conflict");
      }
      const activated = await trx.updateTable("collaboration_scopes").set({
        lifecycle: "shared",
        revision: 1,
        auth_epoch: 1,
        execution_generation: confirmation.executionGeneration,
        execution_eligibility: this.options.executionEligibility,
        updated_at: now,
      }).where("id", "=", scope.id).where("lifecycle", "=", "private").where("revision", "=", 0)
        .returningAll().executeTakeFirst();
      if (!activated) throw new CollaborationTerminalAdapterError("conflict");
      const eventId = randomUUID();
      await trx.insertInto("collaboration_events").values({
        scope_id: scope.id,
        scope_seq: 1,
        event_id: eventId,
        resource_kind: "terminal",
        resource_id: confirmation.terminalId,
        revision: 1,
        authority_generation: Number(activated.authority_generation),
        event_type: "scope.shared",
        payload: {},
        created_at: now,
      }).execute();
      await trx.insertInto("collaboration_audit").values({
        scope_id: scope.id,
        actor_id: input.ownerId,
        action: "scope.shared",
        outcome: "completed",
        revision: 1,
        reason_code: null,
        created_at: now,
      }).execute();
      await trx.insertInto("collaboration_directory_outbox").values({
        event_id: eventId,
        scope_id: scope.id,
        recipient_actor_ids: [{ actorId: input.ownerId }],
        authority_runtime_id: this.options.runtimeId,
        authority_generation: Number(activated.authority_generation),
        resource_kind: "terminal",
        discovery_state: "accepted",
        retry_after: now,
        delivered_at: null,
        created_at: now,
      }).execute();
      await trx.insertInto("collaboration_operations").values({
        scope_id: scope.id,
        actor_id: input.ownerId,
        client_request_id: input.clientRequestId,
        operation_kind: "scope.create",
        payload_hash: input.payloadHash,
        status: "completed",
        result_ref: { scopeId: scope.id },
        expected_revision: confirmation.executionGeneration,
        accepted_auth_epoch: 1,
        created_at: now,
        expires_at: new Date(this.now().getTime() + OPERATION_RETENTION_MS).toISOString(),
      }).execute();
      return rowToScope(activated);
    });
  }

  private async replaySharedScope(
    scope: CollaborationScopeRecord,
    input: {
      ownerId: string;
      clientRequestId: string;
      payloadHash: string;
      expectedResourceRevision: number;
    },
  ): Promise<CollaborationScopeRecord> {
    if (scope.lifecycle !== "shared") throw new CollaborationTerminalAdapterError("conflict");
    return this.options.repository.db.transaction().execute(async (trx) => {
      const createdAt = this.now();
      await trx.insertInto("collaboration_operations").values({
        scope_id: scope.id,
        actor_id: input.ownerId,
        client_request_id: input.clientRequestId,
        operation_kind: "scope.create",
        payload_hash: input.payloadHash,
        status: "completed",
        result_ref: { scopeId: scope.id },
        expected_revision: input.expectedResourceRevision,
        accepted_auth_epoch: scope.authEpoch,
        created_at: createdAt.toISOString(),
        expires_at: new Date(createdAt.getTime() + OPERATION_RETENTION_MS).toISOString(),
      }).onConflict((conflict) => conflict
        .columns(["scope_id", "actor_id", "client_request_id", "operation_kind"])
        .doNothing()).execute();
      const operation = await trx.selectFrom("collaboration_operations")
        .select(["payload_hash", "status"])
        .where("scope_id", "=", scope.id)
        .where("actor_id", "=", input.ownerId)
        .where("client_request_id", "=", input.clientRequestId)
        .where("operation_kind", "=", "scope.create").executeTakeFirst();
      if (!operation || operation.payload_hash !== input.payloadHash || operation.status !== "completed") {
        throw new CollaborationTerminalAdapterError("conflict");
      }
      return scope;
    });
  }
}

function eligiblePrivateSession(session: RegistrySession, ownerId: string): boolean {
  return session.status === "active" && session.incarnationVerified
    && session.creatorActorId === ownerId && Boolean(session.sessionIncarnation)
    && Boolean(session.executionGeneration) && session.sharedControlMode === "eligible"
    && session.collaborationScopeId === undefined;
}

function eligibleSharedSession(session: RegistrySession, ownerId: string): boolean {
  return session.status === "active" && session.incarnationVerified
    && session.creatorActorId === ownerId && Boolean(session.sessionIncarnation)
    && Boolean(session.executionGeneration) && session.sharedControlMode === "shared"
    && Boolean(session.collaborationScopeId);
}

function signPreflight(payload: z.infer<typeof PreflightPayloadSchema>, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

function invalidConfirmation(): CollaborationTerminalAdapterError {
  return new CollaborationTerminalAdapterError("invalid_confirmation");
}

function rowToScope(row: {
  id: string;
  owner_id: string;
  kind: "chat" | "terminal" | "project";
  resource_id: string;
  parent_scope_id: string | null;
  membership_mode: "direct" | "inherited";
  lifecycle: CollaborationScopeRecord["lifecycle"];
  revision: number;
  auth_epoch: number;
  authority_runtime_id: string;
  authority_generation: number;
}): CollaborationScopeRecord {
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
