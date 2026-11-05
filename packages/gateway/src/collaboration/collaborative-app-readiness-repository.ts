import {
  CollaborativeAppBuildRefSchema,
  CollaborativeAppReadinessGateResultSchema,
  type CollaborativeAppBuildRef,
} from "@matrix-os/contracts";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod/v4";

import type { CollaborationAppReadinessTable, OwnerCollaborationDatabase } from "./database.js";

const ArtifactRefSchema = z.string().min(1).max(4_096).refine((value) => {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
});
const VerifierVersionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const OwnerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const GateResultsSchema = z.array(CollaborativeAppReadinessGateResultSchema).max(12);

export type CollaborativeAppReadinessStatus = "checking" | "ready" | "blocked" | "stale" | "failed";
export type CollaborativeAppInvalidationReason = "build_drift" | "catalog_deleted" | "runtime_incompatible" | "manual_recheck";

export interface CollaborativeAppReadinessRecord {
  id: string;
  ownerId: string;
  build: CollaborativeAppBuildRef;
  artifactRef: string;
  status: CollaborativeAppReadinessStatus;
  gateResults: z.infer<typeof GateResultsSchema>;
  verifiedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: CollaborativeAppInvalidationReason | null;
  verifierVersion: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export class CollaborativeAppReadinessRepositoryError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict" | "unavailable") {
    super("Collaborative app readiness is unavailable");
    this.name = "CollaborativeAppReadinessRepositoryError";
  }
}

type ReadinessRow = Selectable<CollaborationAppReadinessTable>;

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toRecord(row: ReadinessRow): CollaborativeAppReadinessRecord {
  const build = CollaborativeAppBuildRefSchema.parse({
    appId: row.app_id,
    catalogId: row.catalog_id,
    registrationIncarnation: row.registration_incarnation,
    manifestVersion: row.manifest_version,
    buildId: row.build_id,
    manifestDigest: row.manifest_digest,
    schemaDigest: row.schema_digest,
    assetDigest: row.asset_digest,
    bridgeContractVersion: row.bridge_contract_version,
    runtimeAbi: row.runtime_abi,
  });
  const gateResults = GateResultsSchema.parse(row.gate_results);
  return {
    id: row.id,
    ownerId: row.owner_id,
    build,
    artifactRef: row.artifact_ref,
    status: row.status,
    gateResults,
    verifiedAt: iso(row.verified_at),
    invalidatedAt: iso(row.invalidated_at),
    invalidationReason: row.invalidation_reason,
    verifierVersion: row.verifier_version,
    revision: Number(row.revision),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function assertTransition(input: {
  status: CollaborativeAppReadinessStatus;
  gateResults: z.infer<typeof GateResultsSchema>;
  verifiedAt?: Date;
  invalidatedAt?: Date;
  invalidationReason?: CollaborativeAppInvalidationReason;
}): void {
  if (input.status === "ready"
    && (!input.verifiedAt || input.invalidatedAt || input.gateResults.length === 0
      || input.gateResults.some((gate) => gate.status !== "passed"))) {
    throw new CollaborativeAppReadinessRepositoryError("invalid");
  }
  if (input.status === "blocked" && !input.gateResults.some((gate) => gate.status === "blocked")) {
    throw new CollaborativeAppReadinessRepositoryError("invalid");
  }
  if (input.status === "failed" && !input.gateResults.some((gate) => gate.status === "failed")) {
    throw new CollaborativeAppReadinessRepositoryError("invalid");
  }
  if ((input.status === "stale") !== (input.invalidatedAt !== undefined)
    || (input.invalidatedAt !== undefined) !== (input.invalidationReason !== undefined)) {
    throw new CollaborativeAppReadinessRepositoryError("invalid");
  }
}

export class CollaborativeAppReadinessRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly db: Kysely<OwnerCollaborationDatabase>,
    options: { now?: () => Date; createId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async createOrGet(input: {
    ownerId: string;
    build: CollaborativeAppBuildRef;
    artifactRef: string;
    verifierVersion: string;
  }): Promise<CollaborativeAppReadinessRecord> {
    const owner = OwnerIdSchema.safeParse(input.ownerId);
    const build = CollaborativeAppBuildRefSchema.safeParse(input.build);
    const artifact = ArtifactRefSchema.safeParse(input.artifactRef);
    const verifier = VerifierVersionSchema.safeParse(input.verifierVersion);
    if (!owner.success || !build.success || !artifact.success || !verifier.success) {
      throw new CollaborativeAppReadinessRepositoryError("invalid");
    }
    const catalog = await this.db.selectFrom("collaboration_resource_catalog")
      .select(["owner_id", "kind", "incarnation"])
      .where("id", "=", build.data.catalogId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!catalog || catalog.owner_id !== owner.data || catalog.kind !== "app"
      || catalog.incarnation !== build.data.registrationIncarnation) {
      throw new CollaborativeAppReadinessRepositoryError("not_found");
    }
    const timestamp = this.now();
    await sql`
      INSERT INTO collaboration_app_readiness (
        id, owner_id, catalog_id, registration_incarnation, app_id, manifest_version,
        build_id, manifest_digest, schema_digest, asset_digest, bridge_contract_version,
        runtime_abi, artifact_ref, status, gate_results, verified_at, invalidated_at,
        invalidation_reason, verifier_version, revision, created_at, updated_at
      ) VALUES (
        ${this.createId()}, ${owner.data}, ${build.data.catalogId}, ${build.data.registrationIncarnation},
        ${build.data.appId}, ${build.data.manifestVersion}, ${build.data.buildId}, ${build.data.manifestDigest},
        ${build.data.schemaDigest}, ${build.data.assetDigest}, ${build.data.bridgeContractVersion},
        ${build.data.runtimeAbi}, ${artifact.data}, 'checking', '[]'::jsonb, NULL, NULL, NULL,
        ${verifier.data}, 1, ${timestamp}, ${timestamp}
      )
      ON CONFLICT (catalog_id, build_id, verifier_version) DO NOTHING
    `.execute(this.db);
    const row = await this.db.selectFrom("collaboration_app_readiness").selectAll()
      .where("catalog_id", "=", build.data.catalogId)
      .where("build_id", "=", build.data.buildId)
      .where("verifier_version", "=", verifier.data)
      .where("owner_id", "=", owner.data)
      .executeTakeFirst();
    if (!row) throw new CollaborativeAppReadinessRepositoryError("conflict");
    return toRecord(row);
  }

  async transition(input: {
    id: string;
    ownerId: string;
    expectedRevision: number;
    status: CollaborativeAppReadinessStatus;
    gateResults: unknown;
    verifiedAt?: Date;
    invalidatedAt?: Date;
    invalidationReason?: CollaborativeAppInvalidationReason;
  }): Promise<CollaborativeAppReadinessRecord> {
    const id = z.uuid().safeParse(input.id);
    const owner = OwnerIdSchema.safeParse(input.ownerId);
    const gates = GateResultsSchema.safeParse(input.gateResults);
    if (!id.success || !owner.success || !gates.success || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new CollaborativeAppReadinessRepositoryError("invalid");
    }
    assertTransition({ ...input, gateResults: gates.data });
    const timestamp = this.now();
    const row = await this.db.updateTable("collaboration_app_readiness").set({
      status: input.status,
      gate_results: sql`${JSON.stringify(gates.data)}::jsonb`,
      verified_at: input.verifiedAt ?? null,
      invalidated_at: input.invalidatedAt ?? null,
      invalidation_reason: input.invalidationReason ?? null,
      revision: input.expectedRevision + 1,
      updated_at: timestamp,
    }).where("id", "=", id.data).where("owner_id", "=", owner.data)
      .where("revision", "=", input.expectedRevision)
      .returningAll().executeTakeFirst();
    if (!row) throw new CollaborativeAppReadinessRepositoryError("conflict");
    return toRecord(row);
  }

  async get(input: { id: string; ownerId: string }): Promise<CollaborativeAppReadinessRecord | null> {
    const row = await this.db.selectFrom("collaboration_app_readiness")
      .innerJoin("collaboration_resource_catalog", "collaboration_resource_catalog.id", "collaboration_app_readiness.catalog_id")
      .selectAll("collaboration_app_readiness")
      .where("collaboration_app_readiness.id", "=", input.id)
      .where("collaboration_app_readiness.owner_id", "=", input.ownerId)
      .where("collaboration_resource_catalog.deleted_at", "is", null)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async getCurrent(input: { ownerId: string; catalogId: string }): Promise<CollaborativeAppReadinessRecord | null> {
    const row = await this.db.selectFrom("collaboration_app_readiness")
      .innerJoin("collaboration_resource_catalog", "collaboration_resource_catalog.id", "collaboration_app_readiness.catalog_id")
      .selectAll("collaboration_app_readiness")
      .where("collaboration_app_readiness.owner_id", "=", input.ownerId)
      .where("collaboration_app_readiness.catalog_id", "=", input.catalogId)
      .where("collaboration_resource_catalog.deleted_at", "is", null)
      .orderBy("collaboration_app_readiness.updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }
}
