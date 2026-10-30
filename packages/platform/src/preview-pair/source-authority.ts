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
      return { open: result.data.state === "open", requested: result.data.labels.some(label => label.name === PREVIEW_PAIR_REQUEST_LABEL),
        sourceSha: result.data.head.sha };
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
