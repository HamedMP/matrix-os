/**
 * Platform organization composition (S03 / T016–T019). Builds the projection,
 * the control authority and the routes over the platform database, registers
 * the projection as the membership source for the identifier resolver, and
 * drains timers on shutdown. The upstream Clerk client is optional: without
 * a secret key no organization is ever verified and every assertion stays
 * negative, which is the fail-closed default.
 */
import type { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Context } from "hono";
import { createCollaborationControlAuthority, type CollaborationControlAuthority } from "../collaboration/control-authority.js";
import { logicalRuntimeIdFor } from "../collaboration/runtime-identity.js";
import { ClerkOrganizationUpstreamClient } from "./clerk-resolver.js";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "./database.js";
import { createOrganizationMembershipProjection, type ClerkOrganizationUpstream, type OrganizationMembershipProjection } from "./projection.js";
import { PlatformOrganizationRepository } from "./repository.js";
import { createPlatformOrganizationRoutes } from "./routes.js";

const MAX_AFFECTED_RUNTIMES = 256;
const INBOX_RETENTION_MS = 7 * 24 * 60 * 60_000;
const INBOX_PRUNE_INTERVAL_MS = 60 * 60_000;

interface DirectoryReader {
  listRuntimeIdsForActor(actorId: string, limit: number): Promise<string[]>;
}

export interface PlatformOrganizations {
  repository: PlatformOrganizationRepository;
  projection: OrganizationMembershipProjection;
  controlAuthority: CollaborationControlAuthority;
  register(app: Hono<any>): void;
  shutdown(): Promise<void>;
}

export async function createPlatformOrganizations(options: {
  db: Kysely<OrganizationPlatformDatabase>;
  directory?: DirectoryReader;
  clerkSecretKey?: string;
  webhookSigningSecret?: string;
  upstream?: ClerkOrganizationUpstream;
  resolveActor(c: Context): Promise<string | null>;
  authenticateRuntime(input: { runtimeId: string; bearerToken: string }): Promise<{ runtimeId: string; ownerId: string } | null>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  startTimers?: boolean;
}): Promise<PlatformOrganizations> {
  await bootstrapPlatformOrganizationDatabase(options.db);
  const now = options.now ?? (() => new Date());
  const repository = new PlatformOrganizationRepository(options.db, { now });
  const upstream = options.upstream ?? (options.clerkSecretKey
    ? new ClerkOrganizationUpstreamClient({ secretKey: options.clerkSecretKey, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), now })
    : undefined);
  if (!upstream) console.warn("[organizations] no Clerk upstream configured: organization membership can never be verified");

  let controlAuthority: CollaborationControlAuthority | undefined;
  const projection = createOrganizationMembershipProjection({
    repository,
    ...(upstream ? { upstream } : {}),
    now,
    startTimers: options.startTimers ?? false,
    onMembershipEnded: async () => {
      // The reconciliation transaction already wrote the revocation intent; drain it now,
      // and let the recurring sweep retry on failure.
      await controlAuthority?.drainRevocations();
    },
  });
  controlAuthority = createCollaborationControlAuthority({
    repository,
    projection,
    now,
    startTimers: options.startTimers ?? false,
    affectedRuntimes: async (denial) => {
      if (!denial.actorId || !options.directory) return [];
      const runtimeIds = await options.directory.listRuntimeIdsForActor(denial.actorId, MAX_AFFECTED_RUNTIMES);
      return [...new Set(runtimeIds.map((runtimeId) => logicalRuntimeIdFor(runtimeId)).filter((value): value is string => Boolean(value)))];
    },
  });
  const routes = createPlatformOrganizationRoutes({
    repository,
    projection,
    controlAuthority,
    ...(options.webhookSigningSecret ? { webhookSigningSecret: options.webhookSigningSecret } : {}),
    resolveActor: options.resolveActor,
    authenticateRuntime: options.authenticateRuntime,
    now,
  });
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  if (options.startTimers) {
    pruneTimer = setInterval(() => {
      repository.pruneInbox(new Date(now().getTime() - INBOX_RETENTION_MS)).catch((error: unknown) => {
        console.warn("[organizations] inbox prune failed", error instanceof Error ? error.name : "UnknownError");
      });
    }, INBOX_PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();
  }
  let registered = false;
  let closing = false;
  return {
    repository,
    projection,
    controlAuthority,
    register(app) {
      if (registered || closing) throw new Error("Platform organization routes are already registered or shutting down");
      registered = true;
      app.route("/", routes);
    },
    async shutdown() {
      if (closing) return;
      closing = true;
      if (pruneTimer) clearInterval(pruneTimer);
      await Promise.allSettled([controlAuthority!.shutdown(), projection.shutdown()]);
    },
  };
}
