import { isSessionStartClean, isSessionStopConfirmed } from "./session-start-cleanup-proof.js";
import { timeChatSendStage } from "../chat/send-timing.js";
import { nativeCodexConfigurationFingerprint } from "./native-codex-configuration-fingerprint.mjs";
import { readCodexConsentAlias, savedCodexConsentMatches } from "./codex-consent-alias.mjs";
import { createCodexExecutionSessions } from "./codex-execution-sessions.js";
import { boundedOperation } from "../bounded-operation.js";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readSavedProviderSettingsConfiguration } from "../ai-providers/provider-settings-persistence.js";
import { codexCatalogObservation } from "../ai-providers/codex-native-observation.js";
import { nativeAccountLegacyPrincipalFingerprint, nativeAccountPrincipalFingerprint, verifyNativeAccountMetadata } from "../ai-providers/native-account-metadata-binding.js";
import { upgradeCodexConsentAlias } from "../ai-providers/codex-consent-upgrade.js";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { CodexNativeAccountMetadata } from "../ai-providers/codex-native-account-metadata.js";
export interface CodexExecutionAdmission {
  start(userId: string, sessionId?: string): Promise<string | undefined>;
  validate(userId: string, binding?: string, sessionId?: string): Promise<void>;
  renewStoppedSession(userId: string, previousBinding: string, sessionId: string,
    proveStopped: (signal: AbortSignal) => Promise<boolean>): Promise<string>;
  validateLaunch(userId: string, sessionId: string): Promise<{
    expectedPrincipalFingerprint: string; expectedConsentRevision: number; expectedConfigurationFingerprint: string;
    expectedHarnessInstanceId: string; expectedAccountId: string;
  } | undefined>;
  prepareRevocation(): Promise<() => Promise<void>>;
  releaseStoppedSession(userId: string, sessionId: string, proof: unknown): Promise<void>;
  releaseFailedStart(userId: string, sessionId: string, binding: string | undefined, result: unknown): Promise<void>;
  /** Full check that also mints a short-lived same-send receipt. */
  startWithReceipt?(userId: string, sessionId?: string): Promise<{ binding: string | undefined; receipt: CodexAdmissionReceipt }>;
  validateWithReceipt?(userId: string, binding: string | undefined, sessionId?: string): Promise<CodexAdmissionReceipt>;
  /**
   * Re-check within the same send after an async step (watch): owner, open
   * revocation gate, unchanged saved consent row and revision, and a fresh
   * verified native principal equal to the receipt's. Skips only re-projecting
   * the Settings snapshot. Unknown, foreign, or expired receipts run the full check.
   */
  confirm?(userId: string, receipt: CodexAdmissionReceipt, sessionId?: string): Promise<void>;
}
/** Opaque; only receipts minted by the same admission instance are honored. */
export type CodexAdmissionReceipt = { readonly binding: string | undefined };
const RECEIPT_TTL_MS = 30_000;
export interface CodexExecutionAdmissionOptions {
  homePath: string;
  stopSession?(sessionId: string): Promise<void>;
  assertProfileAvailable?(): Promise<void>;
  getSnapshot(): Promise<ProviderSettingsSnapshot>;
  readNativeAccount(): Promise<CodexNativeAccountMetadata | null>;
  isOwner(userId: string): boolean | Promise<boolean>;
}
const UNAVAILABLE = "Selected Codex account is unavailable";

/** Persisted generation references never authorize without a fresh private native proof. */
export function createCodexExecutionAdmission(options: CodexExecutionAdmissionOptions): CodexExecutionAdmission {
  const path = join(resolve(options.homePath), "system/ai-providers/settings.json");
  const sessions = createCodexExecutionSessions(resolve(options.homePath), options.stopSession);
  const reject = (): never => { throw new Error(UNAVAILABLE); };
  const current = (userId: string) => timeChatSendStage("codex_execution_admission", () => currentUntimed(userId));
  async function currentUntimed(userId: string) {
    if (!await options.isOwner(userId)) reject();
    // Do not wait on the Settings lock while its revocation is stopping children.
    await sessions.assertOpen();
    const config = await readSavedProviderSettingsConfiguration(path);
    const rows = config?.harnesses.filter(row => row.harness === "codex") ?? [];
    if (!rows.length) {
      // Legacy ambient ChatGPT credentials are not consent. Only an independently
      // verified existing API-key profile may keep its ordinary pre-Settings path.
      await sessions.assertOpen();
      await options.assertProfileAvailable?.();
      const metadata = await verifyNativeAccountMetadata(await options.readNativeAccount());
      if (!metadata || metadata.authMethod !== "api_key"
        || !(Date.parse(metadata.checkedAt) <= Date.now() && Date.parse(metadata.staleAfter) > Date.now())) reject();
      await options.assertProfileAvailable?.();
      await sessions.assertOpen();
      const latest = await readSavedProviderSettingsConfiguration(path);
      if ((latest?.harnesses.filter(row => row.harness === "codex").length ?? 0) !== 0) reject();
      return undefined;
    }
    if (rows.length !== 1 || !rows[0]!.enabled) reject();
    const row = rows[0]!;
    if (row.route.kind !== "fixed" || row.route.providerId !== "openai") reject();
    let snapshot = await options.getSnapshot();
    if (snapshot.access.mode !== "writable" || snapshot.revision !== config!.revision) reject();
    // An unavailable private observation is not a confirmed logout. Reobserve
    // once under the same consent; never replay a provider turn or retry an
    // observed sign-out/account change. Every original proof below still runs.
    if (codexCatalogObservation(snapshot) === "checking") {
      await sessions.assertOpen();
      await options.assertProfileAvailable?.();
      const saved = await readSavedProviderSettingsConfiguration(path);
      if (!saved || saved.revision !== config!.revision) reject();
      snapshot = await options.getSnapshot();
    }
    if (snapshot.access.mode !== "writable" || snapshot.revision !== config!.revision) reject();
    const source = snapshot.accessSources.find(source => source.id === row.accessSourceId);
    const account = snapshot.accounts.find(account => account.id === row.selectedAccountId);
    if (!source || source.kind !== "provider_account" || source.providerId !== "openai"
      || source!.accountId !== row.selectedAccountId || !account || account!.providerId !== "openai"
      || account!.accessSourceId !== source!.id) reject();
    if (source!.fundingKind === "owner_api_key" && account!.authMethod === "api_key") {
      await sessions.assertOpen();
      return undefined;
    }
    if (source!.id !== "owner_openai_profile" || source!.fundingKind !== "owner_account" || account!.authMethod !== "terminal"
      || account!.authState !== "authenticated") reject();
    await sessions.assertOpen();
    await options.assertProfileAvailable?.();
    const metadata = await verifyNativeAccountMetadata(await options.readNativeAccount());
    if (!metadata || metadata.authMethod !== "terminal"
      || !(Date.parse(metadata.checkedAt) <= Date.now() && Date.parse(metadata.staleAfter) > Date.now())) reject();
    // Re-read after asynchronous proof so an intervening Settings write cannot authorize dispatch.
    await options.assertProfileAvailable?.();
    await sessions.assertOpen();
    const latest = await readSavedProviderSettingsConfiguration(path);
    if (!latest || latest.revision !== config!.revision) reject();
    const current = nativeAccountPrincipalFingerprint(metadata!);
    // Bind the saved consent identity, not the observed generation, so an
    // upgraded same-account alias keeps existing session bindings and runners.
    const alias = row.nativeAccountGeneration && current !== row.nativeAccountGeneration ? await readCodexConsentAlias(resolve(options.homePath)) : null;
    const legacy = nativeAccountLegacyPrincipalFingerprint(metadata!);
    if (!savedCodexConsentMatches(row.nativeAccountGeneration, current, alias, legacy) || row.nativeAccountConsentRevision === undefined) reject();
    const principal = row.nativeAccountGeneration;
    // Unchanged credentials under legacy consent: record the same-account alias
    // here too, so every entry point upgrades without a Settings or Chat visit.
    if (!savedCodexConsentMatches(principal, current, alias)) {
      try { await upgradeCodexConsentAlias(resolve(options.homePath), principal, metadata!); }
      catch (error: unknown) {
        console.warn("[native-codex] Consent upgrade unavailable:", error instanceof Error ? error.name : "UnknownError");
      }
    }
    const configurationFingerprint = nativeCodexConfigurationFingerprint(row);
    const binding = createHash("sha256").update(JSON.stringify({
      owner: userId, computer: resolve(options.homePath), configurationFingerprint, principal,
    })).digest("hex");
    return { revision: config!.revision, binding, principal: principal!, consentRevision: row.nativeAccountConsentRevision!, configurationFingerprint, harnessInstanceId: row.id, accountId: row.selectedAccountId! };
  }
  async function validate(userId: string, binding?: string, sessionId?: string) {
    const value = await current(userId);
    if (value?.binding !== binding) {
      reject();
    }
    await sessions.register(userId, sessionId, value?.binding ?? null);
    return value;
  }
  // Receipt facts stay private to this instance; the WeakMap is bounded by live receipts.
  type ReceiptFacts = { userId: string; sessionId: string | undefined; binding: string; principal: string; revision: number;
    configurationFingerprint: string; consentRevision: number; harnessInstanceId: string; accountId: string; issuedAt: number };
  type ConfirmOutcome = { kind: "confirmed"; facts: ReceiptFacts } | { kind: "full"; value: Awaited<ReturnType<typeof validate>> };
  const receipts = new WeakMap<object, ReceiptFacts>();
  // Latest receipt per session so launch admission in the same send can confirm
  // instead of re-projecting. Bounded: oldest evicted past 64; facts expire in 30 s.
  const sessionReceipts = new Map<string, CodexAdmissionReceipt>();
  function mint(userId: string, value: Awaited<ReturnType<typeof current>>, binding: string | undefined, sessionId?: string): CodexAdmissionReceipt {
    const receipt = Object.freeze({ binding });
    if (value) {
      receipts.set(receipt, { userId, sessionId, binding: value.binding, principal: value.principal, revision: value.revision,
        configurationFingerprint: value.configurationFingerprint, consentRevision: value.consentRevision,
        harnessInstanceId: value.harnessInstanceId, accountId: value.accountId, issuedAt: Date.now() });
      if (sessionId) {
        sessionReceipts.delete(sessionId);
        sessionReceipts.set(sessionId, receipt);
        if (sessionReceipts.size > 64) sessionReceipts.delete(sessionReceipts.keys().next().value!);
      }
    }
    return receipt;
  }
  function freshFacts(userId: string, receipt: CodexAdmissionReceipt | undefined) {
    const facts = receipt && typeof receipt === "object" ? receipts.get(receipt) : undefined;
    const age = facts ? Date.now() - facts.issuedAt : Infinity;
    return facts && facts.userId === userId && age >= 0 && age < RECEIPT_TTL_MS ? facts : undefined;
  }
  /**
   * Returns undefined when the receipt was confirmed, or the full check's value
   * when it had to run (unknown, foreign, other-session, or expired receipt, or
   * any Settings write since). Only the full check's binding comparison decides
   * those; owner, revocation gate, and principal mismatches reject outright.
   */
  async function confirmOrValidate(userId: string, receipt: CodexAdmissionReceipt, sessionId?: string): Promise<ConfirmOutcome> {
    const facts = freshFacts(userId, receipt);
    if (!facts || facts.sessionId !== sessionId) return { kind: "full", value: await validate(userId, receipt?.binding, sessionId) };
    return timeChatSendStage("codex_execution_confirm", async (): Promise<ConfirmOutcome> => {
      if (!await options.isOwner(userId)) reject();
      await sessions.assertOpen();
      const config = await readSavedProviderSettingsConfiguration(path);
      const rows = config?.harnesses.filter(row => row.harness === "codex") ?? [];
      const row = rows[0];
      // Any Settings write (even an unrelated harness edit) bumps the revision:
      // re-derive everything with the full check rather than failing the send.
      if (!config || config.revision !== facts.revision || rows.length !== 1 || !row!.enabled
        || nativeCodexConfigurationFingerprint(row!) !== facts.configurationFingerprint
        || row!.nativeAccountGeneration !== facts.principal) return { kind: "full", value: await validate(userId, facts.binding, sessionId) };
      await options.assertProfileAvailable?.();
      const metadata = await verifyNativeAccountMetadata(await options.readNativeAccount());
      if (!metadata || metadata.authMethod !== "terminal"
        || !(Date.parse(metadata.checkedAt) <= Date.now() && Date.parse(metadata.staleAfter) > Date.now())
        || nativeAccountPrincipalFingerprint(metadata) !== facts.principal) reject();
      await options.assertProfileAvailable?.();
      await sessions.assertOpen();
      const latest = await readSavedProviderSettingsConfiguration(path);
      if (!latest || latest.revision !== facts.revision) return { kind: "full", value: await validate(userId, facts.binding, sessionId) };
      await sessions.register(userId, sessionId, facts.binding);
      return { kind: "confirmed", facts };
    });
  }
  async function confirm(userId: string, receipt: CodexAdmissionReceipt, sessionId?: string) {
    await confirmOrValidate(userId, receipt, sessionId);
  }
  return {
    confirm,
    async startWithReceipt(userId, sessionId) {
      const value = await current(userId);
      await sessions.register(userId, sessionId, value?.binding ?? null);
      return { binding: value?.binding, receipt: mint(userId, value, value?.binding, sessionId) };
    },
    async validateWithReceipt(userId, binding, sessionId) {
      const value = await validate(userId, binding, sessionId);
      return mint(userId, value, binding, sessionId);
    },
    async prepareRevocation() {
      sessionReceipts.clear();
      return sessions.prepareRevocation();
    },
    async renewStoppedSession(userId, previousBinding, sessionId, proveStopped) {
      if (!/^[a-f0-9]{64}$/.test(previousBinding)) reject();
      const candidate = await current(userId);
      if (!candidate) throw new Error(UNAVAILABLE);
      if (candidate.binding === previousBinding) reject();
      const prior = await sessions.get(sessionId);
      // An old registration may still own a live child. Only completed
      // revocation or a retry of this exact renewal can advance it.
      if (prior && (prior.userId !== userId || prior.binding !== candidate.binding)) reject();
      let stopped = false;
      try {
        stopped = await boundedOperation(proveStopped, 5_000);
      } catch (error: unknown) {
        console.warn("[native-codex] Stopped-session proof failed:", error instanceof Error ? error.name : "UnknownError");
      }
      if (!stopped) reject();
      const latest = await current(userId);
      if (!latest) throw new Error(UNAVAILABLE);
      if (latest.binding !== candidate.binding) reject();
      await sessions.register(userId, sessionId, latest.binding);
      return latest.binding;
    },
    async releaseStoppedSession(userId, sessionId, proof) {
      if (!isSessionStopConfirmed(proof, userId, sessionId)) return;
      sessionReceipts.delete(sessionId);
      await sessions.releaseCleanFailure(userId, sessionId);
    },
    async releaseFailedStart(userId, sessionId, binding, result) {
      if (!isSessionStartClean(result, userId, sessionId)) return;
      sessionReceipts.delete(sessionId);
      await sessions.releaseCleanFailure(userId, sessionId, binding ?? null);
    },
    async start(userId, sessionId) {
      const value = await current(userId);
      await sessions.register(userId, sessionId, value?.binding ?? null);
      return value?.binding;
    },
    async validate(userId, binding, sessionId) { await validate(userId, binding, sessionId); },
    async validateLaunch(userId, sessionId) {
      const prior = await sessions.get(sessionId);
      if (prior && prior.userId !== userId) reject();
      const receipt = sessionReceipts.get(sessionId);
      const facts = freshFacts(userId, receipt);
      if (receipt && facts && prior?.binding === facts.binding) {
        const outcome = await confirmOrValidate(userId, receipt, sessionId);
        // Intent comes from the confirmed facts, or from the full check when it ran.
        const value = outcome.kind === "confirmed" ? outcome.facts : outcome.value;
        return value ? { expectedPrincipalFingerprint: value.principal, expectedConsentRevision: value.consentRevision,
          expectedHarnessInstanceId: value.harnessInstanceId, expectedAccountId: value.accountId,
          expectedConfigurationFingerprint: value.configurationFingerprint } : undefined;
      }
      const value = await validate(userId, prior?.binding ?? undefined, sessionId);
      return value ? { expectedPrincipalFingerprint: value.principal, expectedConsentRevision: value.consentRevision,
        expectedHarnessInstanceId: value.harnessInstanceId, expectedAccountId: value.accountId, expectedConfigurationFingerprint: value.configurationFingerprint } : undefined;
    },
  };
}
