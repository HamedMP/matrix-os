/**
 * Matrix Core repo routes (spec 2691, layer 6).
 *
 * - `POST /webhooks/github/core-repo`: GitHub App HMAC-SHA256 over the raw
 *   body (`timingSafeEqual`), delivery-id dedupe, `push` to the configured
 *   ref of a configured installation + repository only; anything else is 204.
 * - `POST /api/orgs/:orgId/core-repo/sync`: admin "sync now" (`org:mcp_admin`).
 * - `GET /internal/core-repo/pins` and `GET /internal/core-repo/:orgId/:commit.tar.gz`:
 *   the caller's pinned commits and their tarballs. A VPS authenticates with
 *   its existing machine credential (handle + platform verification token);
 *   the Matrix CLI off-VPS uses its platform session. Either way the identity
 *   must be a current member of the org.
 *
 * Missing configuration or storage is a generic 503, never a 404.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CoreRepoCommitSchema,
  CoreRepoOrgIdSchema,
  CoreRepoPinsResponseSchema,
  CoreRepoSyncResultSchema,
  coreRepoSlug,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { ClerkActorIdSchema } from "../organizations/roles.js";
import { authorizeOrgMcpAdmin, type OrgMcpOrganizations } from "../org-mcp/routes.js";
import type { CoreRepoRepository } from "./database.js";
import { coreRepoObjectKey, type CoreRepoObjectStore, type CoreRepoSyncService } from "./service.js";

const WEBHOOK_BODY_LIMIT = 1024 * 1024;
const HandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const DeliveryIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9-]+$/);
const TokenSchema = z.string().min(16).max(4_096).regex(/^[A-Za-z0-9._~+/=-]+$/);
const PushSchema = z.object({
  ref: z.string().max(300),
  after: CoreRepoCommitSchema,
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({ full_name: z.string().max(201) }),
}).passthrough();
const STORE_TIMEOUT_MS = 30_000;

export interface CoreRepoRouteOptions {
  service?: CoreRepoSyncService;
  repository?: CoreRepoRepository;
  store?: CoreRepoObjectStore;
  webhookSecret?: string;
  organizations?: OrgMcpOrganizations & {
    repository: OrgMcpOrganizations["repository"] & {
      listOrganizationsForActor(actorId: string): Promise<Array<{ organization: { organizationId: string; slug: string; lifecycle: string } }>>;
    };
  };
  /** Clerk user id of the running primary machine behind this credential, or null. */
  authenticateMachine(input: { handle: string; token: string }): Promise<string | null>;
  resolveActor(c: Context): Promise<string | null>;
}

function safeJson(c: Context, error: string, status: 400 | 401 | 404 | 413 | 422 | 503) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}

function unavailable(c: Context, action: string, error?: unknown) {
  if (error !== undefined) console.warn(`[core-repo] ${action} failed`, error instanceof Error ? error.name : "UnknownError");
  return safeJson(c, "Matrix Core repo unavailable", 503);
}

export function verifyGitHubSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=") || !/^[0-9a-f]{64}$/.test(header.slice(7))) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(header.slice(7), "hex"));
}

export function createCoreRepoRoutes(options: CoreRepoRouteOptions): Hono {
  const app = new Hono();
  const webhookLimit = bodyLimit({ maxSize: WEBHOOK_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) });
  const emptyLimit = bodyLimit({ maxSize: 64, onError: (c) => safeJson(c, "Request too large", 413) });

  async function caller(c: Context): Promise<string | null> {
    const handleHeader = c.req.header("x-matrix-handle");
    try {
      if (handleHeader !== undefined) {
        const handle = HandleSchema.safeParse(handleHeader);
        const authorization = c.req.header("authorization");
        const token = TokenSchema.safeParse(authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
        if (!handle.success || !token.success) return null;
        return await options.authenticateMachine({ handle: handle.data, token: token.data });
      }
      const actor = ClerkActorIdSchema.safeParse(await options.resolveActor(c));
      return actor.success ? actor.data : null;
    } catch (error: unknown) {
      console.warn("[core-repo] caller authentication failed", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }

  app.post("/webhooks/github/core-repo", webhookLimit, async (c) => {
    c.header("Cache-Control", "no-store");
    const { service, repository, webhookSecret } = options;
    if (!service || !repository || !webhookSecret) return unavailable(c, "webhook");
    const body = await c.req.text();
    if (!verifyGitHubSignature(webhookSecret, body, c.req.header("x-hub-signature-256"))) return safeJson(c, "Invalid signature", 401);
    const delivery = DeliveryIdSchema.safeParse(c.req.header("x-github-delivery"));
    if (!delivery.success) return safeJson(c, "Invalid request", 400);
    if (c.req.header("x-github-event") !== "push") return c.body(null, 204);
    let payload: unknown;
    try { payload = JSON.parse(body) as unknown; }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return safeJson(c, "Invalid request", 400);
    }
    const push = PushSchema.safeParse(payload);
    if (!push.success) return c.body(null, 204);
    const matching = service.sourcesForPush(push.data.installation.id, push.data.repository.full_name, push.data.ref);
    if (matching.length === 0) return c.body(null, 204);
    try {
      if (!(await repository.claimDelivery(delivery.data))) return c.body(null, 204);
    } catch (error: unknown) {
      return unavailable(c, "delivery dedupe", error);
    }
    // Acknowledge inside GitHub's 10 s window; the sync keeps the last good pin on failure.
    for (const source of matching) {
      void service.syncOrg(source.orgId)?.catch((error: unknown) => {
        console.error("[core-repo] webhook sync crashed", error instanceof Error ? error.name : "UnknownError");
      });
    }
    return c.json({ received: true }, 202);
  });

  app.post("/api/orgs/:orgId/core-repo/sync", emptyLimit, async (c) => {
    const admin = await authorizeOrgMcpAdmin(c, { resolveActor: options.resolveActor, organizations: options.service ? options.organizations : undefined });
    if (admin instanceof Response) return admin;
    const job = options.service?.syncOrg(admin.organizationId);
    if (!job) return unavailable(c, "manual sync");
    try {
      c.header("Cache-Control", "no-store");
      return c.json(CoreRepoSyncResultSchema.parse(await job));
    } catch (error: unknown) {
      return unavailable(c, "manual sync", error);
    }
  });

  app.get("/internal/core-repo/pins", async (c) => {
    const actorId = await caller(c);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    const { repository, organizations } = options;
    if (!repository || !organizations) return unavailable(c, "pins");
    try {
      const memberships = (await organizations.repository.listOrganizationsForActor(actorId))
        .filter(entry => entry.organization.lifecycle === "active");
      const current = [];
      for (const entry of memberships) {
        if (await organizations.projection.isCurrentMember({ organizationId: entry.organization.organizationId, actorId })) current.push(entry.organization);
      }
      const slugs = new Map(current.map(organization => [organization.organizationId, coreRepoSlug(organization.slug, organization.organizationId)]));
      const pins = await repository.listPins([...slugs.keys()]);
      c.header("Cache-Control", "private, no-store");
      return c.json(CoreRepoPinsResponseSchema.parse({ pins: pins.map(pin => ({
        orgId: pin.organizationId, slug: slugs.get(pin.organizationId)!, commit: pin.commit, sha256: pin.sha256, bytes: pin.bytes,
      })) }));
    } catch (error: unknown) {
      return unavailable(c, "pins", error);
    }
  });

  app.get("/internal/core-repo/:orgId/:file", async (c) => {
    const actorId = await caller(c);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    const organizationId = CoreRepoOrgIdSchema.safeParse(c.req.param("orgId"));
    const commit = /^([0-9a-f]{40})\.tar\.gz$/.exec(c.req.param("file"))?.[1];
    if (!organizationId.success || !commit) return safeJson(c, "Invalid request", 422);
    const { repository, organizations, store } = options;
    if (!repository || !organizations || !store) return unavailable(c, "tarball");
    try {
      if (!(await organizations.projection.isCurrentMember({ organizationId: organizationId.data, actorId }))) return safeJson(c, "Not found", 404);
      const pin = await repository.getPin(organizationId.data);
      // Only the pinned commit is served; an older or guessed commit is not.
      if (!pin || pin.commit !== commit) return safeJson(c, "Not found", 404);
      const object = await store.getObject(coreRepoObjectKey(organizationId.data, commit), { signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });
      if (!object.body) return unavailable(c, "tarball read");
      c.header("Cache-Control", "private, no-store");
      c.header("Content-Type", "application/gzip");
      c.header("Content-Length", String(pin.bytes));
      c.header("X-Matrix-Core-Sha256", pin.sha256);
      return c.body(object.body);
    } catch (error: unknown) {
      return unavailable(c, "tarball read", error);
    }
  });

  return app;
}
