/** Owner-only creation of a scope bound to one live catalog incarnation. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import type { CollaborationScopeRecord } from "./repository.js";
import { appendMutationRecords, jsonb } from "./repository-shared.js";
import { ResourceCatalogError, type CatalogEntryRecord, type CatalogKind } from "./resource-catalog.js";
import type { CollaborationResourceServices } from "./resource-routes.js";

const LIFETIME_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const TokenSchema = z.object({
  version: z.literal(1), runtimeId: z.string(), ownerId: z.string(), organizationId: z.string(),
  kind: z.enum(["file", "folder", "app"]), resourceId: z.uuid(),
  revision: z.number().int().nonnegative(), incarnation: z.string().min(1),
  expiresAt: z.number().int().positive(),
}).strict();
type ShareInput = { ownerId: string; organizationId: string; kind: CatalogKind; resourceId: string };
type CreateInput = ShareInput & { clientRequestId: string; payloadHash: string; expectedRevision: number; confirmationToken: string };

export class StandaloneResourceScopeService {
  constructor(private readonly options: {
    resources: CollaborationResourceServices;
    runtimeId: string;
    preflightSecret: string;
    now?: () => Date;
  }) {
    if (Buffer.byteLength(options.preflightSecret) < 32) throw new Error("Collaboration preflight secret is unavailable");
  }

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }

  private async current(input: ShareInput, entry: CatalogEntryRecord): Promise<string> {
    if (entry.ownerId !== input.ownerId || entry.kind !== input.kind || entry.id !== input.resourceId) {
      throw new ResourceCatalogError("not_found");
    }
    if (entry.projectId === null && entry.kind === "folder") {
      const namespace = await this.options.resources.driver.resolveOwnerNamespace?.({ ownerId: input.ownerId, kind: "folder", path: entry.path });
      if (!namespace || namespace.projectId !== null || namespace.path !== entry.path) throw new ResourceCatalogError("forbidden");
    }
    // `inspect` registers each kind under the identity its own read path verifies:
    // the physical incarnation for a file or folder, the registry identity for an app.
    if (!this.options.resources.driver.inspect) throw new ResourceCatalogError("unavailable");
    return (await this.options.resources.driver.inspect({ ownerId: input.ownerId,
      projectId: entry.projectId, kind: entry.kind, path: entry.path })).incarnation;
  }

  async preflight(input: ShareInput): Promise<{ eligible: true; resourceRevision: number; confirmationToken: string; existingScopeId?: string; existingLifecycle?: CollaborationScopeRecord["lifecycle"] }> {
    if (!z.uuid().safeParse(input.resourceId).success) throw new ResourceCatalogError("invalid");
    const entry = await this.options.resources.catalog.get(input.resourceId);
    if (!entry) throw new ResourceCatalogError("not_found");
    const incarnation = await this.current(input, entry);
    if (incarnation !== entry.incarnation) throw new ResourceCatalogError("conflict");
    const existing = await this.findScope(input);
    if (existing && existing.organization_id !== input.organizationId) throw new ResourceCatalogError("conflict");
    const payload = TokenSchema.parse({ version: 1, runtimeId: this.options.runtimeId, ...input, revision: entry.revision,
      incarnation, expiresAt: this.now().getTime() + LIFETIME_MS });
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.options.preflightSecret).update(encoded).digest("base64url");
    return { eligible: true, resourceRevision: entry.revision, confirmationToken: `${encoded}.${signature}`,
      ...(existing ? { existingScopeId: existing.id, existingLifecycle: existing.lifecycle } : {}) };
  }

  async create(input: CreateInput): Promise<CollaborationScopeRecord> {
    if (!z.uuid().safeParse(input.resourceId).success) throw new ResourceCatalogError("invalid");
    const replay = await this.findReplay(input);
    if (replay) return replay;
    const token = this.verify(input);
    const db = this.options.resources.catalog.db;
    try {
      return await db.transaction().execute(async (trx) => {
        const entry = await this.options.resources.catalog.lock(trx, input.resourceId);
        if (entry.ownerId !== input.ownerId || entry.kind !== input.kind || entry.revision !== input.expectedRevision
          || entry.incarnation !== token.incarnation || await this.current(input, entry) !== entry.incarnation) {
          throw new ResourceCatalogError("conflict");
        }
        const timestamp = this.now().toISOString();
        await trx.insertInto("collaboration_scopes").values({
          id: randomUUID(), owner_type: "personal", owner_id: input.ownerId,
          organization_id: input.organizationId, kind: input.kind, resource_id: input.resourceId,
          parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", revision: 1,
          auth_epoch: 1, authority_runtime_id: this.options.runtimeId, authority_generation: 1,
          execution_generation: null, execution_eligibility: null,
          created_at: timestamp, updated_at: timestamp, deleted_at: null,
        }).onConflict((conflict) => conflict.columns(["owner_type", "owner_id", "kind", "resource_id"])
          .where("deleted_at", "is", null).where("lifecycle", "!=", "deleted").doNothing()).execute();
        const scope = await trx.selectFrom("collaboration_scopes").selectAll()
          .where("owner_type", "=", "personal").where("owner_id", "=", input.ownerId)
          .where("kind", "=", input.kind).where("resource_id", "=", input.resourceId)
          .where("deleted_at", "is", null).where("lifecycle", "!=", "deleted")
          .forUpdate().executeTakeFirstOrThrow();
        if (scope.organization_id !== input.organizationId || scope.lifecycle !== "shared"
          || scope.membership_mode !== "direct" || scope.authority_runtime_id !== this.options.runtimeId) {
          throw new ResourceCatalogError("conflict");
        }
        const operation = await trx.selectFrom("collaboration_operations").select(["payload_hash", "status"])
          .where("scope_id", "=", scope.id).where("actor_id", "=", input.ownerId)
          .where("client_request_id", "=", input.clientRequestId).where("operation_kind", "=", "scope.create")
          .executeTakeFirst();
        if (operation) {
          if (operation.payload_hash !== input.payloadHash || operation.status !== "completed") throw new ResourceCatalogError("conflict");
          return this.record(scope);
        }
        const member = await trx.selectFrom("collaboration_members").select(["role", "status"])
          .where("scope_id", "=", scope.id).where("actor_id", "=", input.ownerId).executeTakeFirst();
        if (!member) {
          await trx.insertInto("collaboration_members").values({ scope_id: scope.id,
            actor_id: input.ownerId, organization_id: input.organizationId, role: "owner", status: "accepted",
            invitation_id: null, invited_by: input.ownerId, accepted_at: timestamp, expires_at: null,
            revision: 1, joined_at: timestamp, updated_at: timestamp, dispositioned_at: null }).execute();
          await appendMutationRecords(trx, { scope, actorId: input.ownerId, action: "scope.created",
            recipients: [{ actorId: input.ownerId }], discoveryState: "accepted", now: timestamp });
        } else if (member.role !== "owner" || member.status !== "accepted") throw new ResourceCatalogError("conflict");
        await trx.insertInto("collaboration_operations").values({ scope_id: scope.id, actor_id: input.ownerId,
          client_request_id: input.clientRequestId, operation_kind: "scope.create", payload_hash: input.payloadHash,
          status: "completed", result_ref: jsonb({ scopeId: scope.id }), expected_revision: input.expectedRevision,
          accepted_auth_epoch: Number(scope.auth_epoch), created_at: timestamp,
          expires_at: new Date(this.now().getTime() + RETENTION_MS).toISOString() }).execute();
        return this.record(scope);
      });
    } catch (error: unknown) {
      if (error instanceof ResourceCatalogError) throw error;
      if (error instanceof Error && "code" in error && error.code === "23505") {
        const raced = await this.findReplay(input);
        if (raced) return raced;
        throw new ResourceCatalogError("conflict");
      }
      console.warn("[collaboration-resources] standalone scope creation failed", error instanceof Error ? error.name : "UnknownError");
      throw new ResourceCatalogError("unavailable");
    }
  }

  private verify(input: CreateInput): z.infer<typeof TokenSchema> {
    const [encoded, signature, extra] = input.confirmationToken.split(".");
    if (!encoded || !signature || extra !== undefined) throw new ResourceCatalogError("conflict");
    const expected = createHmac("sha256", this.options.preflightSecret).update(encoded).digest();
    const received = Buffer.from(signature, "base64url");
    const padded = Buffer.alloc(expected.length);
    received.copy(padded, 0, 0, expected.length);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new ResourceCatalogError("conflict");
    let value: unknown;
    try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) console.warn("[collaboration-resources] preflight decode failed", error instanceof Error ? error.name : "UnknownError");
      throw new ResourceCatalogError("conflict");
    }
    const parsed = TokenSchema.safeParse(value);
    if (!parsed.success || parsed.data.runtimeId !== this.options.runtimeId
      || parsed.data.ownerId !== input.ownerId || parsed.data.organizationId !== input.organizationId
      || parsed.data.kind !== input.kind || parsed.data.resourceId !== input.resourceId
      || parsed.data.revision !== input.expectedRevision || parsed.data.expiresAt <= this.now().getTime()) {
      throw new ResourceCatalogError("conflict");
    }
    return parsed.data;
  }

  private findScope(input: ShareInput) {
    return this.options.resources.catalog.db.selectFrom("collaboration_scopes").selectAll()
      .where("owner_type", "=", "personal").where("owner_id", "=", input.ownerId)
      .where("kind", "=", input.kind).where("resource_id", "=", input.resourceId)
      .where("deleted_at", "is", null).where("lifecycle", "!=", "deleted").executeTakeFirst();
  }

  private async findReplay(input: CreateInput): Promise<CollaborationScopeRecord | null> {
    const scope = await this.findScope(input);
    if (!scope) return null;
    const operation = await this.options.resources.catalog.db.selectFrom("collaboration_operations")
      .select(["payload_hash", "status"]).where("scope_id", "=", scope.id)
      .where("actor_id", "=", input.ownerId).where("client_request_id", "=", input.clientRequestId)
      .where("operation_kind", "=", "scope.create").executeTakeFirst();
    if (!operation) return null;
    if (operation.payload_hash !== input.payloadHash || operation.status !== "completed"
      || scope.organization_id !== input.organizationId) throw new ResourceCatalogError("conflict");
    return this.record(scope);
  }

  private record(row: NonNullable<Awaited<ReturnType<StandaloneResourceScopeService["findScope"]>>>): CollaborationScopeRecord {
    return { id: row.id, ownerId: row.owner_id, organizationId: row.organization_id ?? undefined,
      kind: row.kind, resourceId: row.resource_id, membershipMode: row.membership_mode,
      lifecycle: row.lifecycle, revision: Number(row.revision), authEpoch: Number(row.auth_epoch),
      authorityRuntimeId: row.authority_runtime_id, authorityGeneration: Number(row.authority_generation),
      executionGeneration: row.execution_generation, executionEligibility: row.execution_eligibility };
  }
}
