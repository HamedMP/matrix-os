import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  FundedHostActivationResponseSchema,
  fundedHostActivationRevisionInput,
  type FundedHostActivationRequest,
} from "@matrix-os/contracts";
import type { Dispatcher } from "undici";
import type { AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";
import type { PlatformDB } from "./db.js";
import { buildPlatformRuntimeVerificationToken, buildPlatformVerificationToken } from "./platform-token.js";
import {
  initializePreviewRuntimeAccess,
  isBoundedPreviewProvisioningClass,
  type PreviewRuntimeAccessConfig,
  type PreviewRuntimeAccessSummary,
} from "./preview-runtime-access.js";
import { activatePlatformSpeechFleet } from "./speech/fleet-activation.js";
import { readBoundedHostJson } from "./speech/host-readiness.js";

export interface PreviewRuntimeActivationRequest {
  ownerId: string;
  machineId: string;
  runtimeSlot: string;
  expectedRuntimeTokenEpoch: number;
}

export interface PreviewRuntimeActivationResult {
  status: "ready";
  allocation: PreviewRuntimeAccessSummary;
  fundedAiConfigured: true;
  speechConfigured: true;
}

export type PreviewRuntimeAccessActivator = (
  request: PreviewRuntimeActivationRequest,
) => Promise<PreviewRuntimeActivationResult>;

export function createPreviewRuntimeAccessActivator(options: {
  db: PlatformDB;
  repository: Pick<AiFundedPolicyRepository, "grantCreditInTransaction">;
  config: PreviewRuntimeAccessConfig;
  hostControlSecret: string;
  platformOrigin: string;
  speechPlatformOrigin: string;
  relayOrigin: string;
  fetchImpl?: typeof fetch;
  fetchDispatcher?: Dispatcher;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}): PreviewRuntimeAccessActivator {
  if (!options.config.enabled || options.hostControlSecret.length < 32) {
    throw new Error("Preview runtime activation is misconfigured");
  }
  const config = options.config;
  const platformOrigin = new URL(options.platformOrigin);
  const speechPlatformOrigin = new URL(options.speechPlatformOrigin);
  const relayOrigin = new URL(options.relayOrigin);
  if (platformOrigin.protocol !== "https:" || speechPlatformOrigin.protocol !== "https:"
    || relayOrigin.protocol !== "https:") {
    throw new Error("Preview runtime activation is misconfigured");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((ms: number) => delay(ms));
  return async request => {
    const allocation = await initializePreviewRuntimeAccess({
      db: options.db, repository: options.repository, config, request, now: options.now,
    });
    if (Date.parse(allocation.expiresAt) <= (options.now ?? (() => new Date()))().getTime()) {
      throw new Error("Preview runtime access has expired");
    }
    const machine = await options.db.executor.selectFrom("user_machines").select([
      "machine_id", "clerk_user_id", "handle", "runtime_slot", "runtime_token_epoch",
      "provisioning_class", "public_ipv4", "status", "activation_state", "deleted_at",
    ]).where("machine_id", "=", request.machineId).executeTakeFirst();
    if (!machine || machine.clerk_user_id !== request.ownerId || machine.runtime_slot !== request.runtimeSlot
      || machine.runtime_token_epoch !== request.expectedRuntimeTokenEpoch
      || !isBoundedPreviewProvisioningClass(machine.provisioning_class)
      || machine.status !== "running" || machine.activation_state !== "authorized" || machine.deleted_at !== null
      || !machine.public_ipv4) throw new Error("Preview runtime is ineligible");

    const runtimeToken = buildPlatformRuntimeVerificationToken({ handle: machine.handle,
      machineId: machine.machine_id, runtimeSlot: machine.runtime_slot }, config.runtimeSecret,
    machine.runtime_token_epoch);
    const issuedAt = (options.now ?? (() => new Date()))();
    const activation = FundedHostActivationResponseSchema.parse({
      contractVersion: 1,
      identity: { handle: machine.handle, machineId: machine.machine_id, ownerId: machine.clerk_user_id,
        runtimeSlot: machine.runtime_slot, runtimeTokenEpoch: machine.runtime_token_epoch },
      configuration: { enabled: true, platformOrigin: platformOrigin.origin,
        relayOrigin: relayOrigin.origin, runtimeToken },
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(Math.min(issuedAt.getTime() + 30_000, Date.parse(allocation.expiresAt))).toISOString(),
    });
    const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...fundedBody } = activation;
    const expectedRevision = createHash("sha256")
      .update(fundedHostActivationRevisionInput(fundedBody)).digest("hex");
    const base = `https://${machine.public_ipv4}:443`;
    const authorization = `Bearer ${buildPlatformVerificationToken(machine.handle, options.hostControlSecret)}`;
    const requestOptions = () => ({
      headers: { authorization },
      signal: AbortSignal.timeout(10_000),
      redirect: "error" as const,
      ...(options.fetchDispatcher ? { dispatcher: options.fetchDispatcher } : {}),
    }) as RequestInit & { dispatcher?: Dispatcher };
    const post = await fetchImpl(`${base}/api/internal/platform-funded-ai/config`, {
      ...requestOptions(), method: "POST", headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(fundedBody satisfies FundedHostActivationRequest),
    });
    await post.body?.cancel();
    if (!post.ok) throw new Error("Preview funded AI activation failed");
    let fundedReady = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(1_000);
      try {
        const status = await fetchImpl(`${base}/api/internal/platform-funded-ai/config`, {
          ...requestOptions(), method: "GET",
        });
        const value = await readBoundedHostJson(status, 1024) as { configured?: unknown; configurationRevision?: unknown } | null;
        if (status.ok && value?.configured === true && value.configurationRevision === expectedRevision) {
          fundedReady = true;
          break;
        }
      } catch (error: unknown) {
        if (attempt === 11) {
          console.warn("[preview-runtime-activation] funded readiness check failed",
            error instanceof Error ? error.name : "UnknownError");
        }
      }
    }
    if (!fundedReady) throw new Error("Preview funded AI activation failed");
    const speech = await activatePlatformSpeechFleet({
      machines: [{ machineId: machine.machine_id, clerkUserId: machine.clerk_user_id,
        handle: machine.handle, runtimeSlot: machine.runtime_slot, runtimeTokenEpoch: machine.runtime_token_epoch,
        publicIPv4: machine.public_ipv4 }],
      platformOrigin: speechPlatformOrigin.origin,
      platformSecret: options.hostControlSecret,
      runtimeSecret: config.runtimeSecret,
      fetchImpl,
      fetchDispatcher: options.fetchDispatcher,
      wait,
      concurrency: 1,
    });
    if (speech.activated !== 1 || speech.failed !== 0) throw new Error("Preview speech activation failed");
    return { status: "ready", allocation, fundedAiConfigured: true, speechConfigured: true };
  };
}
