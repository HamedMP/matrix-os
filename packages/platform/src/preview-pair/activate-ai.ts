import { createHash } from "node:crypto";
import { fundedHostActivationRevisionInput } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { AiFundedPolicyRepository } from "../ai-funded-policy-repository.js";
import type { PlatformDB } from "../db.js";
import { readFundedHostActivation } from "../funded-host-activation.js";
import { buildPlatformRuntimeVerificationToken, buildPlatformVerificationToken } from "../platform-token.js";
import { initializePreviewRuntimeAccess, readActivePreviewRuntimeAccess, type PreviewRuntimeAccessConfig } from "../preview-runtime-access.js";
import type { PreviewPairReadinessMember } from "./readiness.js";
import { PreviewPairConflictError } from "./repository.js";
import { readCanonicalPreviewPairMember } from "./runtime-binding.js";
import { PreviewPairUpstreamError, readPreviewPairJson } from "./http.js";

export interface PreviewPairAiActivationOptions {
  db: PlatformDB; repository: Pick<AiFundedPolicyRepository, "grantCreditInTransaction">;
  config: PreviewRuntimeAccessConfig; controlSecret: string; hostSecret: string; relayOrigin: string; now: () => number;
  /** Production binds exact canonical member/provider/IP and only the funded config path. */
  requestHost(member: PreviewPairReadinessMember, init: RequestInit, signal: AbortSignal): Promise<Response>;
}
const Status = z.strictObject({ configured: z.boolean(), configurationRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable() });

/** Trusted bounded Preview bank; candidate collaboration stays on its separate API.
 * No raw control/allowance key reaches the host. No speech dependency, waits or retry loop. */
export function createPreviewPairAiActivation(options: PreviewPairAiActivationOptions) {
  if (!options.config.enabled || options.controlSecret.length < 32 || options.hostSecret.length < 32
    || options.hostSecret === options.controlSecret || options.hostSecret === options.config.runtimeSecret
    || options.config.runtimeSecret === options.controlSecret || typeof options.requestHost !== "function") throw new PreviewPairConflictError();
  const config = options.config;
  async function prepare(member: PreviewPairReadinessMember, signal: AbortSignal, allocate: boolean) {
    signal.throwIfAborted(); await readCanonicalPreviewPairMember(options.db, member, options.now);
    const identity = { ownerId: member.actorId, machineId: member.machineId, runtimeSlot: member.handle };
    const now = () => new Date(options.now());
    const allocation = allocate
      ? await initializePreviewRuntimeAccess({ db: options.db, repository: options.repository, config,
        request: { ...identity, expectedRuntimeTokenEpoch: member.tokenEpoch }, now })
      : await readActivePreviewRuntimeAccess(options.db, identity, now());
    if (!allocation || allocation.identity.runtimeTokenEpoch !== member.tokenEpoch || Date.parse(allocation.expiresAt) <= options.now()) return null;
    const token = buildPlatformRuntimeVerificationToken({ handle: member.handle, machineId: member.machineId, runtimeSlot: member.handle }, config.runtimeSecret, member.tokenEpoch);
    const authority = await readFundedHostActivation({ db: options.db, platformSecret: options.controlSecret,
      previewRuntimeSecret: config.runtimeSecret, relayOrigin: options.relayOrigin, handle: member.handle,
      runtimeSlot: member.handle, authorization: `Bearer ${token}`, now });
    signal.throwIfAborted();
    if (authority.status !== "ready") return null;
    const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...body } = authority.configuration;
    return { body, revision: createHash("sha256").update(fundedHostActivationRevisionInput(body)).digest("hex") };
  }
  async function request(member: PreviewPairReadinessMember, method: "GET" | "POST", signal: AbortSignal, body?: unknown) {
    signal.throwIfAborted();
    try {
      return await options.requestHost(member, { method, redirect: "error", cache: "no-store",
        headers: { authorization: `Bearer ${buildPlatformVerificationToken(member.handle, options.hostSecret)}`,
          ...(body ? { "content-type": "application/json" } : {}) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), ...(body ? { body: JSON.stringify(body) } : {}),
      }, signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      if (error instanceof TypeError || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
        console.warn("[preview-pair] AI configuration transport pending", error.name); return null;
      }
      throw error;
    }
  }
  async function status(member: PreviewPairReadinessMember, signal: AbortSignal, revision: string) {
    const response = await request(member, "GET", signal);
    if (!response) return "unavailable";
    if (!response.ok) { await response.body?.cancel(); return "unavailable"; }
    try {
      const result = Status.safeParse(await readPreviewPairJson(response, 1024));
      if (!result.success || (result.data.configured && result.data.configurationRevision === null)) return "unavailable";
      return result.data.configured && result.data.configurationRevision === revision ? "ready" : "different";
    } catch (error: unknown) {
      if (!(error instanceof PreviewPairUpstreamError)) throw error;
      console.warn("[preview-pair] AI configuration status pending", error.name); return "unavailable";
    }
  }
  return {
    async step(member: PreviewPairReadinessMember, signal: AbortSignal): Promise<boolean> {
      const prepared = await prepare(member, signal, true); if (!prepared) return false;
      const current = await status(member, signal, prepared.revision);
      if (current === "ready") { await readCanonicalPreviewPairMember(options.db, member, options.now); signal.throwIfAborted(); return true; }
      if (current === "unavailable") return false;
      const response = await request(member, "POST", signal, prepared.body);
      if (response) { await response.body?.cancel(); if (!response.ok && ![409, 429, 503].includes(response.status)) throw new PreviewPairConflictError(); }
      signal.throwIfAborted(); await readCanonicalPreviewPairMember(options.db, member, options.now);
      return false; // An acknowledgement is not loaded configuration; the next pass verifies it.
    },
    async configured(member: PreviewPairReadinessMember, signal: AbortSignal): Promise<boolean> {
      const prepared = await prepare(member, signal, false); if (!prepared) return false;
      const ready = await status(member, signal, prepared.revision) === "ready";
      signal.throwIfAborted(); await readCanonicalPreviewPairMember(options.db, member, options.now); return ready;
    },
  };
}
