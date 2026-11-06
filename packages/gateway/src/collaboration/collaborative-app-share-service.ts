import {
  CollaborativeAppShareSchema,
  CollaborationOrganizationIdSchema,
  type CollaborativeAppShare,
} from "@matrix-os/contracts";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";

import type { CurrentCollaborativeAppBuild } from "./collaborative-app-readiness-routes.js";
import type {
  CollaborativeAppReadinessRecord,
  CollaborativeAppReadinessRepository,
} from "./collaborative-app-readiness-repository.js";
import type {
  AtomicCollaborativeAppShareRecord,
  CollaborativeAppShareRepository,
} from "./collaborative-app-share-repository.js";
import { canonicalJson } from "./direct-crypto.js";
import type { CollaborationResourceCatalog } from "./resource-catalog.js";

const TOKEN_LIFETIME_MS = 60_000;
const OwnerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RevisionSchema = z.coerce.number().int().nonnegative();
const TokenSchema = z.object({
  version: z.literal(1),
  runtimeId: z.string().min(1).max(128),
  ownerId: OwnerIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  appId: AppIdSchema,
  catalogId: z.uuid(),
  registrationIncarnation: DigestSchema,
  resourceRevision: z.number().int().nonnegative(),
  readinessId: z.uuid(),
  readinessRevision: z.number().int().positive(),
  buildId: DigestSchema,
  expiresAt: z.number().int().positive(),
}).strict();

export interface CollaborativeAppSharePreflightInput {
  organizationId: string;
  expectedReadinessRevision: string;
  expectedBuildId: string;
}

export type CollaborativeAppSharePreflightResult = {
  eligible: true;
  catalogId: string;
  resourceRevision: string;
  readinessId: string;
  buildId: string;
  confirmationToken: string;
  existingShare?: CollaborativeAppShare;
} | {
  eligible: false;
  reason: "not_ready" | "readiness_stale" | "organization_mismatch" | "already_shared" | "unavailable";
};

export interface CollaborativeAppShareCreateInput {
  organizationId: string;
  clientRequestId: string;
  expectedResourceRevision: string;
  expectedReadinessRevision: string;
  readinessId: string;
  buildId: string;
  confirmationToken: string;
}

export interface CollaborativeAppShareStopInput {
  clientRequestId: string;
  expectedShareRevision: string;
  expectedBindingRevision: string;
}

export class CollaborativeAppShareServiceError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict" | "unavailable") {
    super("Collaborative app share is unavailable");
    this.name = "CollaborativeAppShareServiceError";
  }
}

export class CollaborativeAppShareService {
  constructor(private readonly options: {
    ownerId: string;
    runtimeId: string;
    preflightSecret: string;
    catalog: Pick<CollaborationResourceCatalog, "get">;
    readiness: Pick<CollaborativeAppReadinessRepository, "get" | "getCurrent">;
    shares: Pick<CollaborativeAppShareRepository, "getByCatalog" | "createAtomic" | "stopAtomic">;
    resolveCurrentBuild(
      ownerId: string,
      appId: string,
      options: { ensureCatalog: boolean },
    ): Promise<CurrentCollaborativeAppBuild | null>;
    resolveOwner(actorId: string): Promise<{ actorId: string; displayName: string }>;
    onStopped?(scopeId: string): Promise<void>;
    now?: () => Date;
  }) {
    if (!OwnerIdSchema.safeParse(options.ownerId).success
      || Buffer.byteLength(options.preflightSecret) < 32) {
      throw new Error("Collaborative app share configuration is unavailable");
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  async preflight(
    ownerId: string,
    appId: string,
    input: CollaborativeAppSharePreflightInput,
  ): Promise<CollaborativeAppSharePreflightResult> {
    this.assertOwnerAndApp(ownerId, appId);
    const expectedRevision = RevisionSchema.safeParse(input.expectedReadinessRevision);
    if (!expectedRevision.success || expectedRevision.data < 1
      || !CollaborationOrganizationIdSchema.safeParse(input.organizationId).success
      || !DigestSchema.safeParse(input.expectedBuildId).success) {
      throw new CollaborativeAppShareServiceError("invalid");
    }
    const resolved = await this.resolveExact(ownerId, appId, true);
    const readiness = await this.options.readiness.getCurrent({
      ownerId,
      catalogId: resolved.current.build.catalogId,
    });
    if (!readiness || readiness.status !== "ready" || readiness.invalidatedAt) {
      return { eligible: false, reason: "not_ready" };
    }
    if (readiness.build.buildId !== resolved.current.build.buildId
      || readiness.build.buildId !== input.expectedBuildId
      || readiness.revision !== expectedRevision.data) {
      return { eligible: false, reason: "readiness_stale" };
    }
    const existing = await this.options.shares.getByCatalog({ ownerId, catalogId: resolved.catalog.id });
    if (existing && existing.organizationId !== input.organizationId) {
      return { eligible: false, reason: "organization_mismatch" };
    }
    if (existing?.binding.state === "stopped") {
      return { eligible: false, reason: "already_shared" };
    }
    const token = TokenSchema.parse({
      version: 1,
      runtimeId: this.options.runtimeId,
      ownerId,
      organizationId: input.organizationId,
      appId,
      catalogId: resolved.catalog.id,
      registrationIncarnation: resolved.catalog.incarnation,
      resourceRevision: resolved.catalog.revision,
      readinessId: readiness.id,
      readinessRevision: readiness.revision,
      buildId: readiness.build.buildId,
      expiresAt: this.now().getTime() + TOKEN_LIFETIME_MS,
    });
    const encoded = Buffer.from(canonicalJson(token)).toString("base64url");
    const signature = createHmac("sha256", this.options.preflightSecret).update(encoded).digest("base64url");
    return {
      eligible: true,
      catalogId: resolved.catalog.id,
      resourceRevision: String(resolved.catalog.revision),
      readinessId: readiness.id,
      buildId: readiness.build.buildId,
      confirmationToken: `${encoded}.${signature}`,
      ...(existing ? { existingShare: await this.project(existing, readiness) } : {}),
    };
  }

  async create(ownerId: string, appId: string, input: CollaborativeAppShareCreateInput): Promise<CollaborativeAppShare> {
    this.assertOwnerAndApp(ownerId, appId);
    const resourceRevision = RevisionSchema.safeParse(input.expectedResourceRevision);
    const readinessRevision = RevisionSchema.safeParse(input.expectedReadinessRevision);
    if (!resourceRevision.success || !readinessRevision.success || readinessRevision.data < 1
      || !z.uuid().safeParse(input.clientRequestId).success || !z.uuid().safeParse(input.readinessId).success
      || !CollaborationOrganizationIdSchema.safeParse(input.organizationId).success
      || !DigestSchema.safeParse(input.buildId).success) {
      throw new CollaborativeAppShareServiceError("invalid");
    }
    const token = this.verifyToken(input.confirmationToken);
    if (token.ownerId !== ownerId || token.organizationId !== input.organizationId || token.appId !== appId
      || token.resourceRevision !== resourceRevision.data || token.readinessRevision !== readinessRevision.data
      || token.readinessId !== input.readinessId || token.buildId !== input.buildId) {
      throw new CollaborativeAppShareServiceError("conflict");
    }
    const resolved = await this.resolveExact(ownerId, appId, true);
    if (resolved.catalog.id !== token.catalogId || resolved.catalog.incarnation !== token.registrationIncarnation
      || resolved.catalog.revision !== token.resourceRevision || resolved.current.build.buildId !== token.buildId) {
      throw new CollaborativeAppShareServiceError("conflict");
    }
    const readiness = await this.options.readiness.getCurrent({ ownerId, catalogId: token.catalogId });
    if (!readiness || readiness.id !== token.readinessId || readiness.revision !== token.readinessRevision
      || readiness.build.buildId !== token.buildId || readiness.status !== "ready" || readiness.invalidatedAt) {
      throw new CollaborativeAppShareServiceError("conflict");
    }
    const payloadHash = createHash("sha256").update(canonicalJson({
      appId,
      organizationId: input.organizationId,
      clientRequestId: input.clientRequestId,
      expectedResourceRevision: resourceRevision.data,
      expectedReadinessRevision: readinessRevision.data,
      readinessId: input.readinessId,
      buildId: input.buildId,
    })).digest("hex");
    const created = await this.options.shares.createAtomic({
      ownerId,
      organizationId: input.organizationId,
      catalogId: token.catalogId,
      readinessId: token.readinessId,
      expectedResourceRevision: token.resourceRevision,
      expectedReadinessRevision: token.readinessRevision,
      expectedBuildId: token.buildId,
      clientRequestId: input.clientRequestId,
      payloadHash,
      runtimeId: this.options.runtimeId,
    });
    return this.project(created, readiness);
  }

  async get(ownerId: string, appId: string): Promise<CollaborativeAppShare | null> {
    this.assertOwnerAndApp(ownerId, appId);
    const current = await this.options.resolveCurrentBuild(ownerId, appId, { ensureCatalog: false });
    if (!current) return null;
    const existing = await this.options.shares.getByCatalog({ ownerId, catalogId: current.build.catalogId });
    if (!existing) return null;
    const readiness = await this.options.readiness.get({ id: existing.binding.readinessId, ownerId });
    if (!readiness) throw new CollaborativeAppShareServiceError("unavailable");
    return this.project(existing, readiness);
  }

  async stop(ownerId: string, appId: string, input: CollaborativeAppShareStopInput): Promise<CollaborativeAppShare> {
    this.assertOwnerAndApp(ownerId, appId);
    const shareRevision = RevisionSchema.safeParse(input.expectedShareRevision);
    const bindingRevision = RevisionSchema.safeParse(input.expectedBindingRevision);
    if (!shareRevision.success || shareRevision.data < 1 || !bindingRevision.success || bindingRevision.data < 1
      || !z.uuid().safeParse(input.clientRequestId).success) {
      throw new CollaborativeAppShareServiceError("invalid");
    }
    const current = await this.options.resolveCurrentBuild(ownerId, appId, { ensureCatalog: false });
    if (!current) throw new CollaborativeAppShareServiceError("not_found");
    const existing = await this.options.shares.getByCatalog({ ownerId, catalogId: current.build.catalogId });
    if (!existing) throw new CollaborativeAppShareServiceError("not_found");
    const payloadHash = createHash("sha256").update(canonicalJson({
      appId,
      clientRequestId: input.clientRequestId,
      expectedShareRevision: shareRevision.data,
      expectedBindingRevision: bindingRevision.data,
    })).digest("hex");
    const stopped = await this.options.shares.stopAtomic({
      scopeId: existing.scopeId,
      ownerId,
      expectedScopeRevision: shareRevision.data,
      expectedBindingRevision: bindingRevision.data,
      clientRequestId: input.clientRequestId,
      payloadHash,
    });
    if (this.options.onStopped) {
      try {
        await this.options.onStopped(stopped.scopeId);
      } catch (error: unknown) {
        console.warn("[collaborative-app-share] post-commit revocation failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
    const readiness = await this.options.readiness.get({ id: stopped.binding.readinessId, ownerId });
    if (!readiness) throw new CollaborativeAppShareServiceError("unavailable");
    return this.project(stopped, readiness);
  }

  private assertOwnerAndApp(ownerId: string, appId: string): void {
    if (ownerId !== this.options.ownerId || !OwnerIdSchema.safeParse(ownerId).success
      || !AppIdSchema.safeParse(appId).success) {
      throw new CollaborativeAppShareServiceError("not_found");
    }
  }

  private async resolveExact(ownerId: string, appId: string, ensureCatalog: boolean) {
    const current = await this.options.resolveCurrentBuild(ownerId, appId, { ensureCatalog });
    if (!current) throw new CollaborativeAppShareServiceError("not_found");
    const catalog = await this.options.catalog.get(current.build.catalogId);
    if (!catalog || catalog.ownerId !== ownerId || catalog.kind !== "app" || catalog.projectId !== null
      || catalog.path !== appId || catalog.incarnation !== current.build.registrationIncarnation) {
      throw new CollaborativeAppShareServiceError("conflict");
    }
    return { current, catalog };
  }

  private verifyToken(raw: string): z.infer<typeof TokenSchema> {
    const [encoded, signature, extra] = raw.split(".");
    if (!encoded || !signature || extra !== undefined) throw new CollaborativeAppShareServiceError("conflict");
    const expected = createHmac("sha256", this.options.preflightSecret).update(encoded).digest();
    const received = Buffer.from(signature, "base64url");
    const padded = Buffer.alloc(expected.length);
    received.copy(padded, 0, 0, expected.length);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new CollaborativeAppShareServiceError("conflict");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        console.warn("[collaborative-app-share] token decoding failed", error instanceof Error ? error.name : "UnknownError");
      }
      throw new CollaborativeAppShareServiceError("conflict");
    }
    const token = TokenSchema.safeParse(decoded);
    if (!token.success || token.data.runtimeId !== this.options.runtimeId
      || token.data.expiresAt <= this.now().getTime()) {
      throw new CollaborativeAppShareServiceError("conflict");
    }
    return token.data;
  }

  private async project(
    share: AtomicCollaborativeAppShareRecord,
    readiness: CollaborativeAppReadinessRecord,
  ): Promise<CollaborativeAppShare> {
    const state = share.binding.state === "stopped"
      ? "stopped"
      : readiness.status === "ready" && !readiness.invalidatedAt
        && readiness.build.buildId === share.binding.buildId
        ? "active"
        : "needs_recheck";
    return CollaborativeAppShareSchema.parse({
      scopeId: share.scopeId,
      organizationId: share.organizationId,
      owner: await this.options.resolveOwner(this.options.ownerId),
      build: readiness.build,
      readinessId: readiness.id,
      state,
      shareRevision: String(share.scopeRevision),
      dataRevision: String(share.binding.dataRevision),
      createdAt: share.createdAt,
      updatedAt: share.updatedAt,
    });
  }
}
