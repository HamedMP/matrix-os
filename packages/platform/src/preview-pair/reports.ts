import { z } from "zod/v4";
import { PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairPrSchema, PreviewPairShaSchema,
  PreviewPairStateSchema, PreviewPairRoleSchema, PreviewPairHandleSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import { authorizePreviewPairReader, type PreviewPairReader, type PreviewPairMaintainerCheck } from "./readers.js";
import { PreviewPairFailureStageSchema } from "./api-contracts.js";
import { PersistedPreviewPairObservationSchema } from "./readiness.js";
import { PreviewPairCandidateSchema } from "./provenance.js";

const Timestamp = z.iso.datetime({ offset: true });
export const PreviewPairReportSchema = z.strictObject({ pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema,
  revision: z.number().int().positive(), pr: PreviewPairPrSchema, sourceSha: PreviewPairShaSchema, state: PreviewPairStateSchema,
  outdated: z.boolean(), createdAt: Timestamp, expiresAt: Timestamp, infrastructureReady: z.boolean(),
  lastVerifiedAt: Timestamp.nullable(), failedStage: z.union([PreviewPairFailureStageSchema, z.literal("unavailable")]).nullable(),
  acceptance: z.literal("not_run"), members: z.array(z.strictObject({ role: PreviewPairRoleSchema,
    machineId: z.uuid(), handle: PreviewPairHandleSchema, available: z.boolean(), controlFresh: z.boolean(),
    sourceMatches: z.boolean(), fundingReady: z.boolean(), verifiedAt: Timestamp.nullable() })).max(2) });
export type PreviewPairReport = z.infer<typeof PreviewPairReportSchema>;

/** Diagnostic snapshot includes retired test references; it never resolves content capabilities. */
export async function readPreviewPairReport(db: PlatformDB, pairId: string, reader: PreviewPairReader,
  isMaintainer: PreviewPairMaintainerCheck, now: number): Promise<PreviewPairReport> {
  const pair = await authorizePreviewPairReader(db, pairId, reader, isMaintainer, now);
  const generation = await db.executor.selectFrom("preview_pair_generations").select("candidate")
    .where("pair_id", "=", pairId).where("generation", "=", pair.generation).executeTakeFirst();
  const candidate = PreviewPairCandidateSchema.safeParse(generation?.candidate);
  const bindings = await db.executor.selectFrom("preview_pair_members as member")
    .innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
    .select(["member.role", "member.machine_id", "member.actor_id", "member.handle", "member.observation", "member.retired_at",
      "machine.status", "machine.deleted_at", "machine.runtime_token_epoch", "machine.runtime_slot", "machine.provisioning_class",
      "machine.clerk_user_id", "machine.access_clerk_user_ids"])
    .where("member.pair_id", "=", pairId).where("member.generation", "=", pair.generation).orderBy("member.role").limit(3).execute();
  const members = bindings.map(binding => {
    const parsed = PersistedPreviewPairObservationSchema.safeParse(binding.observation);
    const observed = parsed.success ? parsed.data : null;
    const verifiedAt = observed ? Date.parse(observed.verifiedAt) : Number.NaN;
    const current = Boolean(observed && now - verifiedAt <= 30_000 && verifiedAt <= now + 5_000
      && observed.machineId === binding.machine_id && observed.actorId === binding.actor_id && observed.role === binding.role
      && observed.handle === binding.handle && observed.runtimeSlot === binding.handle && binding.runtime_slot === binding.handle
      && binding.clerk_user_id === binding.actor_id && binding.provisioning_class === "preview" && !binding.access_clerk_user_ids.length
      && !binding.deleted_at && !binding.retired_at && binding.status === "running");
    const controlFresh = Boolean(current && observed && now - Date.parse(observed.lastControlAt) <= 60_000
      && Date.parse(observed.lastControlAt) <= now + 5_000);
    const sourceMatches = Boolean(current && observed && candidate.success && observed.installedSha === pair.source_sha
      && observed.runningSha === pair.source_sha && observed.installedVersion === candidate.data.hostBundleVersion
      && observed.runningVersion === candidate.data.hostBundleVersion && observed.bundleSha256 === candidate.data.hostBundleSha256);
    const fundingReady = Boolean(current && observed && observed.funding.machineId === binding.machine_id
      && observed.funding.actorId === binding.actor_id && observed.funding.tokenEpoch === binding.runtime_token_epoch
      && Date.parse(observed.funding.expiresAt) > now);
    return { role: binding.role, machineId: binding.machine_id, handle: binding.handle,
      available: controlFresh && sourceMatches && fundingReady, controlFresh, sourceMatches, fundingReady,
      verifiedAt: observed?.verifiedAt ?? null };
  });
  const verifiedTimes = members.flatMap(member => member.verifiedAt ? [Date.parse(member.verifiedAt)] : []);
  const failure = PreviewPairFailureStageSchema.safeParse(pair.failure_code);
  return PreviewPairReportSchema.parse({ pairId, generation: pair.generation, revision: pair.revision, pr: pair.pr,
    sourceSha: pair.source_sha, state: pair.state, outdated: pair.outdated, createdAt: pair.created_at, expiresAt: pair.expires_at,
    infrastructureReady: pair.state === "ready" && pair.failure_code === null && Date.parse(pair.expires_at) > now
      && members.length === 2 && members.every(member => member.available),
    lastVerifiedAt: verifiedTimes.length === 2 ? new Date(Math.min(...verifiedTimes)).toISOString() : null,
    failedStage: pair.failure_code === null ? null : failure.success ? failure.data : "unavailable",
    acceptance: "not_run", members });
}
