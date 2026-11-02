import type { PlatformDB } from "../db.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import type { PreviewPairLaunchContext } from "@matrix-os/contracts/preview-pair-launch";
import { PreviewPairCandidateSchema } from "./provenance.js";
import { PersistedPreviewPairObservationSchema, type PreviewPairReadinessAdapters } from "./readiness.js";
import { previewPairOperation } from "./operation.js";

/** Public proof verification grants no session. Read current canonical facts
 * before and after membership I/O; progress revisions may advance independently. */
export async function isCurrentPreviewPairLaunch(db: PlatformDB, config: EnabledPreviewPairConfig,
  context: PreviewPairLaunchContext, membership: PreviewPairReadinessAdapters["membership"], now: () => number) {
  async function snapshot() {
    const rows = await db.executor.selectFrom("preview_pairs as pair")
      .innerJoin("preview_pair_fixtures as fixture", join => join.onRef("fixture.fixture_id", "=", "pair.fixture_id").onRef("fixture.active_pair_id", "=", "pair.pair_id"))
      .innerJoin("preview_pair_generations as generation", join => join.onRef("generation.pair_id", "=", "pair.pair_id").onRef("generation.generation", "=", "pair.generation"))
      .innerJoin("preview_pair_members as member", join => join.onRef("member.pair_id", "=", "pair.pair_id").onRef("member.generation", "=", "pair.generation"))
      .innerJoin("user_machines as machine", "machine.machine_id", "member.machine_id")
      .select(["pair.pair_id", "pair.generation", "pair.pr", "pair.source_sha", "pair.state", "pair.expires_at as pair_expires_at", "pair.fixture_id",
        "fixture.owner_actor_id", "fixture.member_actor_id", "fixture.outsider_actor_id", "fixture.organization_id", "generation.candidate",
        "member.role", "member.machine_id", "member.actor_id", "member.handle", "member.retired_at", "member.observation",
        "machine.handle as actual_handle", "machine.clerk_user_id", "machine.runtime_slot", "machine.runtime_token_epoch", "machine.deleted_at",
        "machine.provisioning_class", "machine.status", "machine.image_version", "machine.access_clerk_user_ids"])
      .where("pair.pair_id", "=", context.pairId).where("pair.generation", "=", context.generation).limit(3).execute();
    if (rows.length !== 2 || rows[0]!.role === rows[1]!.role) return null;
    const row = rows[0]!, candidate = PreviewPairCandidateSchema.safeParse(row.candidate);
    const fixture = config.fixtures.find(item => item.id === row.fixture_id);
    if (!fixture || row.state !== "ready" || row.source_sha !== context.sourceSha || row.pr !== context.pr
      || row.pair_expires_at !== context.pairExpiresAt || Date.parse(row.pair_expires_at) <= now()
      || row.organization_id !== context.organizationId || fixture.organizationId !== row.organization_id
      || fixture.ownerActorId !== row.owner_actor_id || fixture.memberActorId !== row.member_actor_id || fixture.outsiderActorId !== row.outsider_actor_id
      || config.controlOrigin !== context.sourceOrigin || config.identityIssuer !== context.identityIssuer || !candidate.success
      || config.sourceProfileFingerprint && candidate.data.sourceProfileFingerprint !== config.sourceProfileFingerprint) return null;
    const proof = candidate.data;
    if (proof.sourceSha !== context.sourceSha || proof.browserOrigin !== context.browserOrigin || proof.apiOrigin !== context.apiOrigin
      || proof.identityIssuer !== context.identityIssuer || !proof.desktopArtifacts.some(item => item.artifactId === context.artifactId
        && item.sha256 === context.artifactSha256 && item.sourceSha === context.sourceSha && item.platform === context.platform && item.arch === context.arch)) return null;
    for (const member of rows) {
      const observed = PersistedPreviewPairObservationSchema.safeParse(member.observation);
      if (member.retired_at || member.deleted_at || member.provisioning_class !== "preview" || member.status !== "running"
        || member.clerk_user_id !== member.actor_id || member.actor_id !== (member.role === "owner" ? row.owner_actor_id : row.member_actor_id) || member.runtime_slot !== member.handle || member.actual_handle !== member.handle
        || member.access_clerk_user_ids.length || member.image_version !== proof.hostBundleVersion || !observed.success) return null;
      const value = observed.data, checked = Date.parse(value.verifiedAt);
      if (checked > now() + 5000 || now() - checked > 30_000 || value.machineId !== member.machine_id || value.actorId !== member.actor_id
        || value.role !== member.role || value.handle !== member.handle || value.runtimeSlot !== member.handle
        || value.installedSha !== proof.sourceSha || value.runningSha !== proof.sourceSha
        || value.installedVersion !== proof.hostBundleVersion || value.runningVersion !== proof.hostBundleVersion || value.bundleSha256 !== proof.hostBundleSha256
        || now() - Date.parse(value.observedAt) > 30_000 || Date.parse(value.observedAt) > now() + 5000
        || now() - Date.parse(value.lastControlAt) > 60_000 || Date.parse(value.lastControlAt) > now() + 5000
        || value.funding.machineId !== member.machine_id || value.funding.actorId !== member.actor_id
        || value.authorityGeneration !== member.runtime_token_epoch || value.funding.tokenEpoch !== member.runtime_token_epoch
        || Date.parse(value.funding.expiresAt) <= now()) return null;
    }
    const selected = rows.find(item => item.role === context.role);
    if (!selected || selected.machine_id !== context.machineId || selected.actor_id !== context.actorId || selected.handle !== context.handle
      || selected.runtime_slot !== context.runtimeSlot || selected.runtime_token_epoch !== context.authorityGeneration) return null;
    return { owner: row.owner_actor_id, member: row.member_actor_id, outsider: row.outsider_actor_id, organization: row.organization_id };
  }
  const before = await snapshot(); if (!before) return false;
  const current = await Promise.all([before.owner, before.member, before.outsider].map(actor => previewPairOperation(signal => membership(actor, before.organization, signal))));
  if (current[0] !== true || current[1] !== true || current[2] !== false) return false;
  return Boolean(await snapshot());
}
