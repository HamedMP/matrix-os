import { z } from "zod/v4";
import { sql } from "kysely";
import type { PlatformDB } from "../db.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import type { createPreviewPairGitHub } from "./github.js";
import type { createPreviewPairCloudAuthority } from "./cloud.js";
import type { createPreviewPairIdentity } from "./identity.js";
import type { PreviewPairRuntimeOptions } from "./wiring.js";
import { PreviewPairShaSchema } from "@matrix-os/contracts/preview-pair";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { createPreviewPairSources } from "./sources.js";
import { createPreviewPairControllerResolver } from "./controller.js";
import { PreviewPairUpstreamError } from "./http.js";
export const PREVIEW_PAIR_REQUEST_LABEL = "preview-collaboration-pair";
const Repo = z.object({ full_name: z.literal("HamedMP/matrix-os") });
const Pull = z.object({ number: z.number().int().positive(), state: z.enum(["open", "closed"]),
  head: z.object({ sha: PreviewPairShaSchema, repo: Repo }), base: z.object({ repo: Repo }),
  labels: z.array(z.object({ name: z.string().max(128) })).max(128) });
export interface PreviewPairSourceAuthorityOptions { db: PlatformDB; config: EnabledPreviewPairConfig;
  github: ReturnType<typeof createPreviewPairGitHub>; cloud: ReturnType<typeof createPreviewPairCloudAuthority>;
  identity: ReturnType<typeof createPreviewPairIdentity>; controlClerkSecret: string; fetchImpl?: typeof fetch }

/** Current provider facts plus canonical full UUID/generation: a short tag alone
 * cannot establish identity after a retarget, collision or cleanup interruption. */
export function createPreviewPairSourceAuthority(options: PreviewPairSourceAuthorityOptions): PreviewPairRuntimeOptions["authority"] {
  const { db, config, github, cloud, identity } = options;
  return { source: createPreviewPairSources(db, github, cloud),
    resolveController: createPreviewPairControllerResolver({ github, clerkSecret: options.controlClerkSecret,
      reviewedControllerSha: config.reviewedControllerSha, fetchImpl: options.fetchImpl }),
    isMaintainer: identity.isMaintainer, membership: identity.membership, verifyFixtures: identity.verifyFixtures,
    async inspectRequest(input, signal) {
      signal.throwIfAborted();
      const raw = await github.pullRequest(input.pr), result = Pull.safeParse(raw);
      signal.throwIfAborted();
      if (!result.success || result.data.number !== input.pr) throw new PreviewPairUpstreamError();
      const request = { open: result.data.state === "open", requested: result.data.labels.some(label => label.name === PREVIEW_PAIR_REQUEST_LABEL),
        sourceSha: result.data.head.sha };
      if (!request.open || !request.requested) return request;
      const intent = await db.executor.selectFrom("preview_pair_cloud_intents").select(["controller_run_id", "source_sha", "state"])
        .where("pair_id", "=", input.pairId).where("generation", "=", input.generation).where("pr", "=", input.pr)
        .where("state", "=", "prepared").executeTakeFirst();
      // Superseded unadmitted source is already sufficient for cleanup. Do not
      // turn an unavailable controller lookup into a reason to retain it.
      if (intent && intent.source_sha !== request.sourceSha) return request;
      const generation = intent ? undefined : await db.executor.selectFrom("preview_pair_generations as generation")
        .innerJoin("preview_pairs as pair", "pair.pair_id", "generation.pair_id").select("generation.controller_run_id")
        .where("pair.pair_id", "=", input.pairId).where("pair.pr", "=", input.pr)
        .where("generation.generation", "=", sql<number>`CASE WHEN pair.state = 'updating' AND pair.generation = ${input.generation}
          THEN pair.generation + 1 ELSE ${input.generation} END`).executeTakeFirst();
      const runId = intent?.controller_run_id ?? generation?.controller_run_id;
      if (!runId) return request; // Retained legacy generations have no controller receipt.
      const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(runId);
      if (!id.success) throw new PreviewPairUpstreamError();
      const run = await github.reviewedRun(id.data,
        ".github/workflows/preview-collaboration-pair.yml");
      signal.throwIfAborted();
      const status = z.object({ status: z.enum(["queued", "requested", "waiting", "pending", "in_progress", "completed"]),
        conclusion: z.enum(["success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "stale", "startup_failure"]).nullable() })
        .refine(value => value.status === "completed" ? value.conclusion !== null : value.conclusion === null).safeParse(run);
      if (!status.success) throw new PreviewPairUpstreamError();
      if (status.data.status === "completed" && (intent || status.data.conclusion !== "success")) request.requested = false;
      return request;
    },
    async authority(raw, signal) {
      signal.throwIfAborted(); const candidate = PreviewPairCandidateSchema.parse(raw);
      if (config.sourceProfileFingerprint && candidate.sourceProfileFingerprint !== config.sourceProfileFingerprint) return false;
      const rows = await db.executor.selectFrom("preview_pairs as pair").innerJoin("preview_pair_generations as generation",
        join => join.onRef("generation.pair_id", "=", "pair.pair_id").onRef("generation.generation", "=", "pair.generation"))
        .select(["pair.pair_id", "pair.generation"]).where("pair.state", "in", ["preparing", "ready"])
        .where(sql<boolean>`generation.candidate = ${JSON.stringify(candidate)}::jsonb`).limit(2).execute();
      if (rows.length !== 1) return false;
      const proof = await cloud(candidate.browserOrigin, candidate.apiOrigin); signal.throwIfAborted();
      return proof.pairId === rows[0].pair_id && proof.generation === rows[0].generation
        && proof.browserOrigin === candidate.browserOrigin && proof.apiOrigin === candidate.apiOrigin
        && proof.sourceSha === candidate.platformSource.sha && proof.identityIssuer === config.identityIssuer
        && proof.serviceAccount === config.serviceAccount && proof.clerkSecretRef === config.clerkSecretRef
        && proof.databaseSecretRef === config.databaseSecretRef && proof.ticketKeysSecretRef === config.ticketKeysSecretRef;
    },
  };
}
