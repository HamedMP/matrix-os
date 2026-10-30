import { isIP } from "node:net";
import { isPrivateIp } from "@matrix-os/kernel/security/ssrf-guard";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { Kysely } from "kysely";
import type { Dispatcher } from "undici";
import type { PlatformDB } from "../db.js";
import type { HetznerClient } from "../customer-vps-hetzner.js";
import { buildPlatformVerificationToken } from "../platform-token.js";
import { CollaborationRuntimeEndpointRegistry, type RuntimeEndpointPlatformDatabase } from "../collaboration/runtime-endpoints.js";
import { HOME_LIVENESS_WINDOW_MS } from "../collaboration/ticket-issuer.js";
import { readCanonicalPreviewPairMember } from "./runtime-binding.js";
import type { PreviewPairReadinessMember } from "./readiness.js";
import { PreviewPairConflictError } from "./repository.js";
import { readPreviewPairJson } from "./http.js";

const Info = z.object({
  runningVersion: z.string(), build: z.object({ sha: z.string() }),
  runtime: z.object({ machineId: z.uuid(), handle: z.string(), runtimeSlot: z.string() }),
  capabilities: z.object({ collaboration: z.literal(true), collaborationDirectProtocolVersion: z.literal(COLLABORATION_DIRECT_PROTOCOL_VERSION) }),
  release: z.object({ version: z.string(), gitCommit: z.string(), sha256: z.string(), bundleSha256: z.string() }),
});

/** Read-only observation. A manifest cannot attest a host, grant access or replace real login.
 * IP is independently matched to the provider, validated globally routable and dialed directly;
 * no hostname/DNS rebinding path or redirects. Reuses the existing scoped host TLS dispatcher. */
export function createPreviewPairHostObserver(options: {
  db: PlatformDB; target: PlatformDB; provider: HetznerClient;
  previewSecret: string; controlSecret: string; dispatcher: Dispatcher;
  fetchImpl?: typeof fetch; now: () => number;
}) {
  if (options.previewSecret.length < 32 || options.previewSecret === options.controlSecret) throw new PreviewPairConflictError();
  const endpoints = new CollaborationRuntimeEndpointRegistry(options.target.kysely as unknown as Kysely<RuntimeEndpointPlatformDatabase>);
  const canonical = (member: PreviewPairReadinessMember) => readCanonicalPreviewPairMember(options.db, member, options.now);
  return async (member: PreviewPairReadinessMember, signal: AbortSignal): Promise<unknown> => {
    let stage = "canonical";
    try {
      signal.throwIfAborted();
      const { row, candidate } = await canonical(member);
      if (!options.provider.withSignal || row.hetzner_server_id === null || !row.public_ipv4
        || isIP(row.public_ipv4) !== 4 || isPrivateIp(row.public_ipv4)) throw new PreviewPairConflictError();
      stage = "provider";
      const server = await options.provider.withSignal(signal).getServer(Number(row.hetzner_server_id));
      if (!server || server.id !== Number(row.hetzner_server_id) || server.status !== "running" || server.publicIPv4 !== row.public_ipv4
        || server.labels?.app !== "matrix-os" || server.labels.machine_id !== member.machineId
        || server.labels.clerk_user_id !== member.actorId || server.labels.runtime_slot !== member.handle) throw new PreviewPairConflictError();
      stage = "host_info";
      const response = await (options.fetchImpl ?? fetch)(`https://${row.public_ipv4}:443/api/system/info`, {
        method: "GET", headers: { authorization: `Bearer ${buildPlatformVerificationToken(member.handle, options.previewSecret)}` },
        redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), dispatcher: options.dispatcher,
      } as RequestInit & { dispatcher: Dispatcher });
      if (!response.ok) { await response.body?.cancel(); throw new PreviewPairConflictError(); }
      const info = Info.parse(await readPreviewPairJson(response, 64 * 1024));
      if (info.runtime.machineId !== member.machineId || info.runtime.handle !== member.handle || info.runtime.runtimeSlot !== member.handle
        || info.runningVersion !== candidate.hostBundleVersion || info.release.version !== candidate.hostBundleVersion
        || info.build.sha !== candidate.sourceSha || info.release.gitCommit !== candidate.sourceSha
        || info.release.sha256 !== candidate.hostBundleSha256 || info.release.bundleSha256 !== candidate.hostBundleSha256) throw new PreviewPairConflictError();
      stage = "control";
      const endpoint = await endpoints.resolveEnrolled(`vps:${member.machineId}`);
      const controlAt = endpoint?.lastControlAt ? Date.parse(endpoint.lastControlAt) : Number.NaN;
      const projected = await options.target.executor.selectFrom("user_machines").selectAll().where("machine_id", "=", member.machineId).executeTakeFirst();
      if (!endpoint || endpoint.ownerId !== member.actorId || endpoint.relayHandle !== member.handle || !endpoint.publicKeys.length
        || endpoint.protocolVersion !== COLLABORATION_DIRECT_PROTOCOL_VERSION || !Number.isFinite(controlAt)
        || options.now() - controlAt > HOME_LIVENESS_WINDOW_MS || controlAt > options.now() + 5_000
        || !projected || projected.deleted_at || projected.status !== "running" || projected.provisioning_class !== "preview"
        || projected.clerk_user_id !== member.actorId || projected.handle !== member.handle || projected.runtime_slot !== member.handle
        || projected.runtime_token_epoch !== member.tokenEpoch || projected.access_clerk_user_ids.length
        || projected.image_version !== candidate.hostBundleVersion || projected.confirmed_bundle_version !== candidate.hostBundleVersion
        || projected.target_bundle_version !== candidate.hostBundleVersion || projected.target_bundle_sha256 !== candidate.hostBundleSha256) throw new PreviewPairConflictError();
      stage = "final_canonical";
      signal.throwIfAborted(); await canonical(member);
      return { role: member.role, machineId: member.machineId, actorId: member.actorId, handle: member.handle, runtimeSlot: member.handle,
        installedVersion: info.release.version, runningVersion: info.runningVersion, installedSha: info.release.gitCommit, runningSha: info.build.sha,
        authorityGeneration: endpoint.authorityGeneration, lastControlAt: endpoint.lastControlAt, healthy: true,
        bundleSha256: info.release.bundleSha256, observedAt: new Date(options.now()).toISOString() };
    } catch (error: unknown) {
      console.warn("[preview-pair] host observation unavailable", stage, error instanceof Error ? error.name : "UnknownError");
      throw new PreviewPairConflictError();
    }
  };
}
