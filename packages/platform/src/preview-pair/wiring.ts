import type { Dispatcher } from "undici";
import type { PlatformDB } from "../db.js";
import { createCustomerVpsContext, type CustomerVpsContext } from "../customer-vps-context.js";
import { createCustomerVpsProvisioner } from "../customer-vps-provision.js";
import { createCustomerVpsProvisioningDispatcher } from "../customer-vps-provisioning-dispatch.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import type { PreviewPairServiceDeps } from "./service.js";
import { createPreviewPairService } from "./service.js";
import type { PreviewPairReadinessAdapters } from "./readiness.js";
import type { PreviewPairAiActivationOptions } from "./activate-ai.js";
import type { createPreviewPairCleanup } from "./compose-cleanup.js";
import { PreviewPairConflictError } from "./repository.js";
import { PreviewPairAccessError } from "./readers.js";
import { PreviewPairCandidateSchema, type PreviewPairCandidate } from "./provenance.js";
import { preparePreviewPairMember } from "./prepare.js";
import { createPreviewPairProvisioning } from "./provisioning.js";
import { assertPreviewPairDataIsolation, reconcilePreviewPairProjection } from "./projection.js";
import { createPreviewPairCleanup as composeCleanup } from "./compose-cleanup.js";
import { createPreviewPairAiActivation } from "./activate-ai.js";
import { createPreviewPairFundingReader } from "./funding.js";
import { createPreviewPairHostObserver } from "./observe-host.js";
import { createPreviewPairAiHostRequester } from "./host-request.js";
import { withPreviewPairClaim } from "./lifecycle.js";
import { createPreviewPairProviderDrain } from "./drain-provider.js";

export interface PreviewPairRuntimeOptions {
  db: PlatformDB; target: PlatformDB; config: EnabledPreviewPairConfig;
  context: CustomerVpsContext; controlSecret: string; hostSecret: string;
  dispatcher: Dispatcher; fetchImpl?: typeof fetch; now?: () => number;
  authority: Pick<PreviewPairServiceDeps, "source" | "resolveController" | "isMaintainer" | "verifyFixtures" | "inspectRequest">
    & Pick<PreviewPairReadinessAdapters, "authority" | "membership">;
  funding: Pick<PreviewPairAiActivationOptions, "config" | "relayOrigin"> & { repository?: PreviewPairAiActivationOptions["repository"] };
  retireCloud: Parameters<typeof createPreviewPairCleanup>[0]["retireCloud"];
}

/** Internal composition only: callers supply independently verified Preview
 * resources. None of these provider/credential ports are accepted by HTTP. */
export function createPreviewPairRuntime(options: PreviewPairRuntimeOptions): { service: ReturnType<typeof createPreviewPairService> } {
  const { db, target, context, config } = options, now = options.now ?? Date.now;
  const base = context.deps.config;
  if (context.deps.db !== db || base.platformSecret !== options.hostSecret || options.hostSecret.length < 32
    || options.controlSecret.length < 32 || options.controlSecret === options.hostSecret
    || base.fundedAiEnabled || base.goldenSnapshots.enabled || !/^preview[-/][-a-z0-9/]{1,80}$/.test(base.r2PrefixRoot)) {
    throw new PreviewPairConflictError();
  }
  // Context creation and preparation are pure local work inside the original
  // admission transaction. No secret resolution or provider calls occur here.
  const contextFor = (candidate: PreviewPairCandidate) => createCustomerVpsContext({ ...context.deps,
    config: { ...base, platformRegisterUrl: `${candidate.apiOrigin}/vps/register`, fundedAiEnabled: false }, now: () => new Date(now()) });
  const prepare: PreviewPairServiceDeps["prepare"] = async (pairId, generation, role) => {
    const row = await db.executor.selectFrom("preview_pair_generations").select("candidate")
      .where("pair_id", "=", pairId).where("generation", "=", generation).executeTakeFirstOrThrow();
    const ctx = contextFor(PreviewPairCandidateSchema.parse(row.candidate));
    return preparePreviewPairMember(ctx, createCustomerVpsProvisioner(ctx, createCustomerVpsProvisioningDispatcher(ctx)), pairId, generation, role);
  };
  async function isolated() {
    try { await assertPreviewPairDataIsolation(db, target); }
    catch (error: unknown) { if (error instanceof PreviewPairConflictError) throw new PreviewPairAccessError(503); throw error; }
  }
  const transport = { db, provider: context.deps.hetzner, previewSecret: options.hostSecret,
    controlSecret: options.controlSecret, dispatcher: options.dispatcher, fetchImpl: options.fetchImpl, now };
  const repository = options.funding.repository;
  const ai = options.funding.config.enabled && repository
    ? createPreviewPairAiActivation({ db, ...options.funding, repository, controlSecret: options.controlSecret, hostSecret: options.hostSecret,
      now, requestHost: createPreviewPairAiHostRequester(transport) }) : undefined;
  const fundingUnavailable = async (): Promise<never> => { throw new PreviewPairAccessError(503); };
  const provision = createPreviewPairProvisioning({ db, controlSecret: options.controlSecret, now,
    context: async candidate => contextFor(candidate),
    verifyAuthority: async (candidate, signal) => { await isolated(); signal.throwIfAborted(); return options.authority.authority(candidate, signal); },
    mirror: async (_input, claim, signal) => { signal.throwIfAborted(); await reconcilePreviewPairProjection(db, target, claim, now); },
  });
  const service = createPreviewPairService({ db, config, ...options.authority, prepare, now,
    verifyFixtures: async signal => { if (!ai) return false; await isolated(); signal.throwIfAborted(); return options.authority.verifyFixtures(signal); },
    async activate(input, claim, signal) {
      if (!config.admissionEnabled || !ai) return false;
      if (!await provision(input, claim, signal)) return false;
      const rows = await withPreviewPairClaim(db, claim, now(), trx => trx.executor.selectFrom("user_machines")
        .select(["machine_id", "runtime_token_epoch"]).where("machine_id", "in", input.members.map(member => member.machineId)).limit(3).execute());
      if (rows.length !== 2) throw new PreviewPairConflictError();
      for (const member of input.members) {
        const row = rows.find(row => row.machine_id === member.machineId);
        if (!row) throw new PreviewPairConflictError();
        const expected = { role: member.role, machineId: member.machineId, actorId: member.actorId, handle: member.handle, tokenEpoch: row.runtime_token_epoch };
        if (!await ai.configured(expected, signal)) { await ai.step(expected, signal); return false; }
      }
      return true;
    },
    readiness: { authority: options.authority.authority, membership: options.authority.membership,
      observe: createPreviewPairHostObserver({ ...transport, target }),
      funding: ai ? createPreviewPairFundingReader({ db, now, hostConfiguration: ai.configured }) : fundingUnavailable },
    cleanup: composeCleanup({ db, target, provider: context.deps.hetzner, retireCloud: options.retireCloud, now,
      drainProvider: createPreviewPairProviderDrain({ db, provider: context.deps.hetzner, now }) }),
  });
  return { service };
}
